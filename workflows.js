// workflows.js
// Workflow discovery and loading for UI-native and legacy API workflows.

const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = process.env.COMFYCLAW_WORKFLOWS
    ? path.resolve(process.env.COMFYCLAW_WORKFLOWS)
    : path.join(process.cwd(), 'workflows');

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isUIWorkflow(data) {
    return Boolean(data && Array.isArray(data.nodes) && Array.isArray(data.links));
}

function isApiPrompt(data) {
    return Boolean(data && typeof data === 'object' && !Array.isArray(data) && !isUIWorkflow(data));
}

/** List workflow names once, preferring UI format when both formats exist. */
function listWorkflows() {
    if (!fs.existsSync(WORKFLOWS_DIR)) return [];

    const byName = new Map();
    for (const filename of fs.readdirSync(WORKFLOWS_DIR).filter((file) => file.endsWith('.json'))) {
        const api = filename.endsWith('-api.json');
        const name = api ? filename.replace(/-api\.json$/, '') : filename.replace(/\.json$/, '');
        const current = byName.get(name) || { name, ui: null, api: null };
        current[api ? 'api' : 'ui'] = path.join(WORKFLOWS_DIR, filename);
        byName.set(name, current);
    }

    return [...byName.values()]
        .map((entry) => ({
            ...entry,
            format: entry.ui ? 'ui' : 'api',
            path: entry.ui || entry.api,
            filename: path.basename(entry.ui || entry.api),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
}

function uiCandidates(name) {
    if (path.extname(name).toLowerCase() === '.json') {
        const direct = path.resolve(name);
        return name.endsWith('-api.json')
            ? [direct.replace(/-api\.json$/, '.json')]
            : [direct];
    }
    return [path.join(WORKFLOWS_DIR, `${name}.json`)];
}

function apiCandidates(name) {
    if (path.extname(name).toLowerCase() === '.json') {
        const direct = path.resolve(name);
        return name.endsWith('-api.json')
            ? [direct]
            : [direct.replace(/\.json$/, '-api.json')];
    }
    return [path.join(WORKFLOWS_DIR, `${name}-api.json`)];
}

function findUIWorkflow(name) {
    for (const filePath of uiCandidates(name)) {
        if (!fs.existsSync(filePath)) continue;
        const data = readJson(filePath);
        if (!isUIWorkflow(data)) continue;
        return { name, path: filePath, workflow: data };
    }
    return null;
}

function loadUIWorkflow(name) {
    const result = findUIWorkflow(name);
    if (result) return result;
    throw new Error(`UI workflow "${name}" not found. Expected: ${uiCandidates(name).join(', ')}`);
}

/** Load a legacy API-format workflow. */
function loadWorkflow(name) {
    for (const filePath of apiCandidates(name)) {
        if (!fs.existsSync(filePath)) continue;
        const data = readJson(filePath);
        if (!isApiPrompt(data)) {
            throw new Error(`"${filePath}" is not a valid API prompt graph.`);
        }
        return { name, path: filePath, prompt: data };
    }

    throw new Error(
        `API workflow "${name}" not found.\n` +
        `Expected: ${apiCandidates(name).join(', ')}\n` +
        'A UI workflow can be run directly when a ComfyUI server is selected.'
    );
}

module.exports = {
    listWorkflows,
    loadWorkflow,
    loadUIWorkflow,
    findUIWorkflow,
    isUIWorkflow,
    isApiPrompt,
    WORKFLOWS_DIR,
};
