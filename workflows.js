// workflows.js
// Workflow discovery and loading for the ComfyUI CLI.

const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(process.cwd(), 'workflows');

/**
 * List all available API workflows.
 * Scans the workflows/ directory for *-api.json files.
 * Returns an array of { name, filename, path }.
 */
function listWorkflows() {
    if (!fs.existsSync(WORKFLOWS_DIR)) {
        return [];
    }

    const files = fs.readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('-api.json'));
    return files.map((filename) => {
        const name = filename.replace(/-api\.json$/, '');
        return {
            name,
            filename,
            path: path.join(WORKFLOWS_DIR, filename),
        };
    });
}

/**
 * Load a workflow by short name (e.g. "text2video" → "text2video-api.json").
 * Returns the parsed API prompt graph object.
 * Throws if not found or invalid.
 */
function loadWorkflow(name) {
    // Try exact -api.json match first
    const apiPath = path.join(WORKFLOWS_DIR, `${name}-api.json`);
    if (fs.existsSync(apiPath)) {
        const data = JSON.parse(fs.readFileSync(apiPath, 'utf8'));
        validateApiPrompt(data, apiPath);
        return { name, path: apiPath, prompt: data };
    }

    // Try as a full filename
    const directPath = path.join(WORKFLOWS_DIR, name);
    if (fs.existsSync(directPath)) {
        const data = JSON.parse(fs.readFileSync(directPath, 'utf8'));
        validateApiPrompt(data, directPath);
        return { name, path: directPath, prompt: data };
    }

    // Try with .json extension
    const jsonPath = path.join(WORKFLOWS_DIR, `${name}.json`);
    if (fs.existsSync(jsonPath)) {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        validateApiPrompt(data, jsonPath);
        return { name, path: jsonPath, prompt: data };
    }

    throw new Error(
        `Workflow "${name}" not found.\n` +
        `Looked for:\n` +
        `  ${apiPath}\n` +
        `  ${directPath}\n` +
        `  ${jsonPath}\n` +
        `Run "comfyclaw --list" to see available workflows.`
    );
}

function validateApiPrompt(data, filePath) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error(`"${filePath}" is not a valid API prompt graph (expected an object keyed by node IDs).`);
    }
}

module.exports = { listWorkflows, loadWorkflow, WORKFLOWS_DIR };
