#!/usr/bin/env node
// cli.js
// Unified CLI for ComfyUI workflow discovery, inspection, and execution.
//
// Usage:
//   comfyclaw --list
//   comfyclaw --describe <workflow>
//   comfyclaw --run <workflow> [outDir] [--set @tag.key=value ...]

const fs = require('node:fs');
const path = require('node:path');

const { listWorkflows, loadWorkflow } = require('./workflows');
const { applyNodeInputOverrides, resolveTagOverrides } = require('./patch');
const { getServerWithLowestQueue } = require('./helpers');
const ComfyUI = require('./comfy');
const config = require('./config');

// ── Optional S3 Upload ──────────────────────────────────────────────────────

let s3Client = null;
let PutObjectCommand = null;

function getS3() {
    if (!config.aws?.enabled) return null;
    if (s3Client) return { s3Client, PutObjectCommand };

    try {
        const s3sdk = require('@aws-sdk/client-s3');
        PutObjectCommand = s3sdk.PutObjectCommand;

        // Build S3 client options — if explicit creds are set, use them;
        // otherwise fall back to the default chain (~/.aws/credentials, env vars, instance role)
        const opts = { region: config.aws.region || 'us-east-1' };
        if (config.aws.accessKeyId && config.aws.secretAccessKey) {
            opts.credentials = {
                accessKeyId: config.aws.accessKeyId,
                secretAccessKey: config.aws.secretAccessKey,
            };
        }

        s3Client = new s3sdk.S3Client(opts);
        return { s3Client, PutObjectCommand };
    } catch {
        console.warn('Warning: @aws-sdk/client-s3 not installed. S3 upload disabled.');
        console.warn('  Install with: npm install @aws-sdk/client-s3');
        config.aws.enabled = false;
        return null;
    }
}

async function uploadToS3(filePath, buf) {
    const s3 = getS3();
    if (!s3) return null;

    const ext = path.extname(filePath).slice(1);
    const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', mp4: 'video/mp4', gif: 'image/gif' };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const key = `${config.aws.prefix || ''}${path.basename(filePath)}`;

    try {
        const cmd = new s3.PutObjectCommand({
            Bucket: config.aws.bucket,
            Key: key,
            Body: buf,
            ContentType: contentType,
        });

        await s3.s3Client.send(cmd);
        console.log(`  Uploaded to S3: s3://${config.aws.bucket}/${key}`);
        return key;
    } catch (err) {
        console.error(`  S3 upload failed: ${err.message}`);
        return null;
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isScalar(v) {
    return (
        v === null ||
        v === undefined ||
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean'
    );
}

function summarizeNode(nodeId, node) {
    const title = node?._meta?.title;
    const classType = node?.class_type;
    const inputs = node?.inputs || {};

    const scalar = [];
    const linked = [];

    for (const [k, v] of Object.entries(inputs)) {
        if (Array.isArray(v)) linked.push(k);
        else if (isScalar(v)) scalar.push({ key: k, value: v });
    }

    return { nodeId, title, classType, scalar, linked };
}

// ── Commands ─────────────────────────────────────────────────────────────────

function cmdList() {
    const workflows = listWorkflows();
    if (workflows.length === 0) {
        console.log('No workflows found in workflows/ directory.');
        console.log('Place *-api.json files in the workflows/ folder.');
        process.exit(0);
    }

    console.log('Available workflows:\n');
    for (const wf of workflows) {
        console.log(`  ${wf.name}`);
    }
    console.log(`\nTotal: ${workflows.length} workflow(s)`);
    console.log('\nUsage:');
    console.log('  comfyclaw --describe <name>   Show editable parameters');
    console.log('  comfyclaw --run <name>        Execute a workflow');
}

/**
 * Query ComfyUI server /object_info/<class_type> for a node's input schema.
 * Returns a map of { inputName: string[] | null } for enum-type inputs.
 */
async function fetchNodeInputInfo(serverURL, classType) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(`${serverURL}/object_info/${encodeURIComponent(classType)}`, {
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (!res.ok) return {};

        const data = await res.json();
        const nodeInfo = data?.[classType];
        if (!nodeInfo) return {};

        const result = {};
        const allInputs = { ...(nodeInfo.input?.required || {}), ...(nodeInfo.input?.optional || {}) };

        for (const [k, v] of Object.entries(allInputs)) {
            if (Array.isArray(v) && Array.isArray(v[0])) {
                // Enum-type: v[0] is the list of valid values
                result[k] = v[0];
            }
        }
        return result;
    } catch {
        return {};
    }
}

async function getServerURL() {
    const envServer = process.env.COMFYUI_SERVER;
    if (envServer) return envServer;

    try {
        const res = await getServerWithLowestQueue();
        if (!res.allServersDown && res.serverToUse) return res.serverToUse;
    } catch { /* ignore */ }
    return null;
}

async function cmdDescribe(name) {
    if (!name) {
        console.error('Error: --describe requires a workflow name.');
        console.error('Usage: comfyclaw --describe <workflow>');
        console.error('Run "comfyclaw --list" to see available workflows.');
        process.exit(2);
    }

    const { prompt } = loadWorkflow(name);

    // Find all @tagged nodes
    const tagged = [];
    for (const [nodeId, node] of Object.entries(prompt)) {
        const title = node?._meta?.title;
        if (typeof title === 'string' && title.startsWith('@')) {
            tagged.push(summarizeNode(nodeId, node));
        }
    }

    tagged.sort((a, b) => (a.title || '').localeCompare(b.title || ''));

    if (tagged.length === 0) {
        console.log(`Workflow "${name}" has no @tags.`);
        console.log('Add _meta.title = "@tagname" to nodes you want to be editable.');
        return;
    }

    // Try to reach the server for enum value lookups
    const serverURL = await getServerURL();
    const enumCache = {};

    if (serverURL) {
        // Fetch object_info for each unique class_type
        const classTypes = [...new Set(tagged.map((t) => t.classType))];
        await Promise.all(
            classTypes.map(async (ct) => {
                enumCache[ct] = await fetchNodeInputInfo(serverURL, ct);
            }),
        );
    }

    console.log(`Workflow: ${name}`);
    console.log(`Tags: ${tagged.length}`);
    if (serverURL) console.log(`Server: ${serverURL}`);
    console.log('');

    for (const n of tagged) {
        console.log(`${n.title}  (node ${n.nodeId}, ${n.classType})`);
        const nodeEnums = enumCache[n.classType] || {};

        if (n.scalar.length) {
            console.log('  editable:');
            for (const { key, value } of n.scalar) {
                const display = typeof value === 'string'
                    ? (value.length > 60 ? `"${value.slice(0, 57)}..."` : `"${value}"`)
                    : JSON.stringify(value);
                console.log(`    --set ${n.title}.${key}=${display}`);

                // Show available enum values from server
                if (nodeEnums[key]) {
                    const vals = nodeEnums[key];
                    const marked = vals.map((v) => {
                        const current = String(value) === String(v);
                        return current ? `★ ${v}` : `  ${v}`;
                    });
                    console.log(`      values (${vals.length}):`);
                    for (const m of marked) {
                        console.log(`        ${m}`);
                    }
                }
            }
        } else {
            console.log('  editable: (none)');
        }

        if (n.linked.length) {
            console.log(`  linked (do NOT override): ${n.linked.join(', ')}`);
        }

        console.log('');
    }

    console.log('Example:');
    // Build a concrete example from the first tag with scalar inputs
    const example = tagged.find((t) => t.scalar.length > 0);
    if (example) {
        const s = example.scalar[0];
        const val = typeof s.value === 'string' ? '"your value here"' : s.value;
        console.log(`  comfyclaw --run ${name} outputs --set ${example.title}.${s.key}=${val}`);
    } else {
        console.log(`  comfyclaw --run ${name} outputs`);
    }
}

async function cmdRun(name, argv) {
    if (!name) {
        console.error('Error: --run requires a workflow name.');
        console.error('Usage: comfyclaw --run <workflow> [outDir] [--set @tag.key=value ...] [--file @tag.key=path ...]');
        console.error('Run "comfyclaw --list" to see available workflows.');
        process.exit(2);
    }

    // Parse remaining argv: [outDir] [--set key=val ...] [--file key=path ...]
    let outDir = path.join(process.cwd(), 'outputs');
    const setArgs = [];
    const fileArgs = [];
    let i = 0;

    // First non-flag arg after name is outDir
    if (argv[0] && !argv[0].startsWith('--')) {
        outDir = argv[0];
        i = 1;
    }

    for (; i < argv.length; i++) {
        if (argv[i] === '--set') {
            if (!argv[i + 1]) throw new Error('Missing value for --set');
            setArgs.push(argv[i + 1]);
            i++;
        } else if (argv[i] === '--file') {
            if (!argv[i + 1]) throw new Error('Missing value for --file');
            fileArgs.push(argv[i + 1]);
            i++;
        }
    }

    fs.mkdirSync(outDir, { recursive: true });

    const { prompt: apiPrompt } = loadWorkflow(name);

    // Server selection (needed early for file uploads)
    const envServer = process.env.COMFYUI_SERVER;
    let serverToUse = envServer || null;

    if (!serverToUse) {
        const res = await getServerWithLowestQueue();
        if (res.allServersDown || !res.serverToUse) {
            throw new Error('All ComfyUI servers unavailable (see logs above).');
        }
        serverToUse = res.serverToUse;
    }

    // Upload files (--file args) BEFORE override resolution so that
    // the uploaded server-side filenames are included in setArgs
    if (fileArgs.length > 0) {
        const uploader = { comfyUIServerURL: serverToUse };
        uploader.uploadFile = ComfyUI.prototype.uploadFile.bind(uploader);

        for (const arg of fileArgs) {
            const idxEq = arg.indexOf('=');
            if (idxEq === -1) throw new Error(`Invalid --file '${arg}'. Expected @tag.key=/path/to/file or nodeId.key=/path/to/file`);
            const left = arg.slice(0, idxEq);
            const filePath = arg.slice(idxEq + 1);

            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found: ${path.resolve(filePath)}`);
            }

            const result = await uploader.uploadFile(filePath);
            const serverFilename = result.name;

            setArgs.push(`${left}=${serverFilename}`);
            console.log(`  Mapped --file ${left} → ${serverFilename}`);
        }
    }

    // Resolve tag-based + node-id overrides (now includes any --file entries)
    const overrides = resolveTagOverrides(apiPrompt, setArgs);
    const { applied, skipped } = applyNodeInputOverrides(apiPrompt, overrides);

    if (applied.length) {
        console.log('Applied overrides:');
        applied.forEach((o) => console.log(`  - node ${o.nodeId}: ${o.key} = ${JSON.stringify(o.value)}`));
    }
    if (skipped.length) {
        console.log('Skipped overrides:');
        skipped.forEach((o) => console.log(`  - node ${o.nodeId}${o.key ? '.' + o.key : ''}: ${o.reason}`));
    }

    // Detect save nodes
    const saveNodes = Object.keys(apiPrompt).filter(
        (k) => apiPrompt[k]?._meta?.title === 'Save'
            || apiPrompt[k]?._meta?.title === '@save'
            || apiPrompt[k]?._meta?.title === 'SaveVideo'
            || apiPrompt[k]?.class_type === 'SaveImage'
            || apiPrompt[k]?.class_type === 'SaveAudio'
            || apiPrompt[k]?.class_type === 'VHS_VideoCombine',
    );

    if (saveNodes.length === 0) {
        throw new Error('No Save node detected in workflow. Tag your output node as @save or use SaveImage class.');
    }

    let finished = false;
    const downloaded = [];
    let comfy = null;
    let timeoutId = null;

    await new Promise((resolve, reject) => {
        const cleanup = () => {
            if (timeoutId) clearTimeout(timeoutId);
            timeoutId = null;
            if (comfy) comfy.disconnect();
            comfy = null;
        };

        const resolveDone = () => {
            finished = true;
            cleanup();
            resolve();
        };

        const rejectDone = (err) => {
            finished = true;
            cleanup();
            reject(err);
        };

        comfy = new ComfyUI({
            comfyUIServerURL: serverToUse,
            nodes: { api_save: saveNodes },

            onSaveCallback: async ({ message }) => {
                // Log per-node save events for progress visibility.
                // Actual file downloading happens after execution_success via /history.
                const nodeId = message?.data?.node;
                const count = (message?.data?.output?.images || []).length
                    + (message?.data?.output?.gifs || []).length;
                console.log(`Node ${nodeId} reported ${count} output(s) (will download all via /history)`);
            },

            onMessageCallback: async ({ message }) => {
                if (message?.type === 'execution_error') {
                    rejectDone(new Error(message?.data?.exception_message || 'Execution error'));
                    return;
                }
                if (message?.type === 'execution_success') {
                    try {
                        // Fetch complete outputs from /history (authoritative for batch outputs)
                        const history = await comfy.getHistory(comfy.promptId);
                        const outputs = history?.outputs || {};

                        for (const nodeId of saveNodes) {
                            const nodeOutput = outputs[nodeId] || {};
                            const files = [
                                ...(nodeOutput.images || []),
                                ...(nodeOutput.gifs || []),
                            ];
                            for (const file of files) {
                                const buf = await comfy.getFile(file);
                                const outPath = path.join(outDir, `${comfy.promptId}-${file.filename}`);
                                fs.writeFileSync(outPath, buf);
                                downloaded.push(outPath);
                                console.log(`Saved: ${outPath} (${buf.length} bytes)`);

                                // Optional S3 upload
                                if (config.aws?.enabled) {
                                    await uploadToS3(outPath, buf);
                                }
                            }
                        }
                        resolveDone();
                    } catch (e) {
                        rejectDone(e);
                    }
                }
            },

            onOpenCallback: async (self) => {
                try {
                    await self.queue({ workflowDataAPI: apiPrompt });
                } catch (e) {
                    rejectDone(e);
                }
            },

            onErrorCallback: async (err) => {
                rejectDone(err);
            },
        });

        // Safety timeout
        timeoutId = setTimeout(() => {
            if (!finished) {
                rejectDone(new Error('Timed out waiting for workflow to finish.'));
            }
        }, Number(process.env.COMFYUI_TIMEOUT_MS || 180000));
    });

    console.log('\nDone. Outputs:');
    downloaded.forEach((p) => console.log(`  - ${p}`));
}

// ── Main ─────────────────────────────────────────────────────────────────────

function printUsage() {
    console.log('ComfyClaw — Discover, inspect, and run ComfyUI workflows.\n');
    console.log('Usage:');
    console.log('  comfyclaw --list                              List available workflows');
    console.log('  comfyclaw --describe <workflow>               Show editable @tag parameters');
    console.log('  comfyclaw --run <workflow> [outDir] [--set] [--file]   Run a workflow\n');
    console.log('Override parameters:');
    console.log('  --set  @tag.key=value      Tag-based override (recommended)');
    console.log('  --set  nodeId.key=value    Direct node-ID override\n');
    console.log('File upload (images, audio):');
    console.log('  --file @tag.key=/path       Upload file to server and inject filename');
    console.log('  --file nodeId.key=/path     Same, using node ID\n');
    console.log('Environment:');
    console.log('  COMFYCLAW_WORKFLOWS  Path to workflows directory (default: ./workflows)');
    console.log('  COMFYUI_SERVER       Force a specific server URL');
    console.log('  COMFYUI_TIMEOUT_MS   Max wait time (default: 180000)');
}

async function main() {
    const argv = process.argv.slice(2);

    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
        printUsage();
        process.exit(argv.length === 0 ? 2 : 0);
    }

    const command = argv[0];

    if (command === '--list') {
        cmdList();
    } else if (command === '--describe') {
        await cmdDescribe(argv[1]);
    } else if (command === '--run') {
        await cmdRun(argv[1], argv.slice(2));
    } else {
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(2);
    }
}

main().catch((err) => {
    console.error(`Error: ${err.message}`);
    process.exit(1);
});
