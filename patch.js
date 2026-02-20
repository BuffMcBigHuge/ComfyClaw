// patch.js
// Utilities to apply safe overrides to an API prompt graph.

function coerceValue(raw) {
  // Best-effort coercion from CLI/env strings.
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (raw === 'undefined') return undefined;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);

  // JSON objects/arrays
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      return JSON.parse(raw);
    } catch {
      // fallthrough
    }
  }

  return raw;
}

/**
 * Apply overrides to an API prompt.
 *
 * overrides format:
 * {
 *   "6": {"text": "new prompt"},
 *   "3": {"seed": 123, "steps": 30}
 * }
 */
function applyNodeInputOverrides(apiPrompt, overrides) {
  if (!overrides) return { apiPrompt, applied: [], skipped: [] };

  const applied = [];
  const skipped = [];

  for (const [nodeId, inputs] of Object.entries(overrides)) {
    const node = apiPrompt[nodeId];
    if (!node) {
      skipped.push({ nodeId, reason: 'node_not_found' });
      continue;
    }
    if (!node.inputs || typeof node.inputs !== 'object') node.inputs = {};

    for (const [k, v] of Object.entries(inputs || {})) {
      // Do not allow overriding linked inputs (arrays like ["4",0]) unless explicitly intended.
      if (Array.isArray(node.inputs[k])) {
        skipped.push({ nodeId, key: k, reason: 'linked_input_refuse_override' });
        continue;
      }
      node.inputs[k] = v;
      applied.push({ nodeId, key: k, value: v });
    }
  }

  return { apiPrompt, applied, skipped };
}

/**
 * Parse a --set style list:
 *   ["6.text=hello", "3.steps=30"]
 * into overrides object.
 */
function parseSetArgs(setArgs) {
  const overrides = {};
  for (const s of setArgs || []) {
    const idxEq = s.indexOf('=');
    if (idxEq === -1) throw new Error(`Invalid --set '${s}'. Expected nodeId.key=value`);
    const left = s.slice(0, idxEq);
    const raw = s.slice(idxEq + 1);
    const idxDot = left.indexOf('.');
    if (idxDot === -1) throw new Error(`Invalid --set '${s}'. Expected nodeId.key=value`);
    const nodeId = left.slice(0, idxDot);
    const key = left.slice(idxDot + 1);

    overrides[nodeId] ||= {};
    overrides[nodeId][key] = coerceValue(raw);
  }
  return overrides;
}

/**
 * Resolve tag-based overrides (@tag.key=value) to node-id-based overrides.
 *
 * Accepts the raw --set args array and an API prompt graph.
 * Returns a unified overrides object (keyed by node ID) ready for applyNodeInputOverrides().
 *
 * Tag format:  @tagname.key=value  (e.g. @prompt.text="hello")
 * Node format: nodeId.key=value    (e.g. 6.text="hello")
 *
 * Rules:
 * - A @tag must match exactly one node (by _meta.title). Zero or >1 → error.
 * - Node-id overrides are passed through as-is.
 */
function resolveTagOverrides(apiPrompt, setArgs) {
  const overrides = {};

  for (const s of setArgs || []) {
    const idxEq = s.indexOf('=');
    if (idxEq === -1) throw new Error(`Invalid --set '${s}'. Expected @tag.key=value or nodeId.key=value`);
    const left = s.slice(0, idxEq);
    const raw = s.slice(idxEq + 1);
    const idxDot = left.indexOf('.');
    if (idxDot === -1) throw new Error(`Invalid --set '${s}'. Expected @tag.key=value or nodeId.key=value`);

    const prefix = left.slice(0, idxDot);
    const key = left.slice(idxDot + 1);

    let nodeId;

    if (prefix.startsWith('@')) {
      // Tag-based: resolve @tag to node ID
      const tag = prefix; // e.g. "@prompt"
      const matches = [];
      for (const [nid, node] of Object.entries(apiPrompt)) {
        if (node?._meta?.title === tag) {
          matches.push(nid);
        }
      }
      if (matches.length === 0) {
        throw new Error(`Tag "${tag}" not found in workflow. No node has _meta.title === "${tag}".`);
      }
      if (matches.length > 1) {
        throw new Error(`Tag "${tag}" is ambiguous: matched nodes [${matches.join(', ')}]. Each @tag must be unique.`);
      }
      nodeId = matches[0];
    } else {
      // Node-id based (passthrough)
      nodeId = prefix;
    }

    overrides[nodeId] ||= {};
    overrides[nodeId][key] = coerceValue(raw);
  }

  return overrides;
}

module.exports = {
  applyNodeInputOverrides,
  parseSetArgs,
  resolveTagOverrides,
  coerceValue,
};
