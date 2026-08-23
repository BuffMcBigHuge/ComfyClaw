// validation.js
// Pre-flight validation and schema-aware override preparation.

const fs = require('node:fs');
const path = require('node:path');
const { coerceValue, parseOverrideArg, resolveNodeTarget } = require('./patch');

const SCALAR_TYPES = new Set(['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'NUMBER', 'COMBO']);
const FILE_EXTENSIONS = {
  IMAGE: new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif']),
  AUDIO: new Set(['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.aac', '.mp4']),
};

class SchemaCache {
  constructor(serverURL) {
    this.serverURL = serverURL ? serverURL.replace(/\/$/, '') : null;
    this.cache = new Map();
  }

  async get(classType) {
    if (!this.serverURL) return null;
    if (!this.cache.has(classType)) {
      this.cache.set(classType, this.fetch(classType));
    }
    return this.cache.get(classType);
  }

  async fetch(classType) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(
        `${this.serverURL}/object_info/${encodeURIComponent(classType)}`,
        { signal: controller.signal },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      return data?.[classType] ?? null;
    } catch (err) {
      throw new Error(`Unable to read schema for ${classType} from ${this.serverURL}: ${err.message}`);
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function normalizeDefinition(definition) {
  if (!Array.isArray(definition)) return null;

  if (Array.isArray(definition[0])) {
    return {
      type: 'COMBO',
      options: definition[0],
      config: definition[1] || {},
    };
  }

  const type = definition[0];
  const config = definition[1] || {};
  return {
    type,
    options: type === 'COMBO' && Array.isArray(config.options) ? config.options : null,
    config,
  };
}

function findInputSpec(nodeInfo, key) {
  if (!nodeInfo?.input) return null;
  const allInputs = {
    ...(nodeInfo.input.required || {}),
    ...(nodeInfo.input.optional || {}),
  };

  if (allInputs[key]) {
    return { ...normalizeDefinition(allInputs[key]), key, dynamic: false };
  }

  const dot = key.indexOf('.');
  if (dot === -1) return null;
  const groupName = key.slice(0, dot);
  const dynamicKey = key.slice(dot + 1);
  const group = normalizeDefinition(allInputs[groupName]);
  if (!group || !String(group.type).startsWith('COMFY_AUTOGROW')) return null;

  const template = group.config?.template;
  const prefix = template?.prefix || '';
  if (!dynamicKey.startsWith(prefix)) return null;

  const indexText = dynamicKey.slice(prefix.length);
  if (!/^\d+$/.test(indexText)) return null;
  const index = Number(indexText);
  if (Number.isFinite(template.max) && index >= template.max) return null;

  const templateInputs = {
    ...(template?.input?.required || {}),
    ...(template?.input?.optional || {}),
  };
  const innerName = Object.keys(templateInputs)[0];
  const inner = normalizeDefinition(templateInputs[innerName]);
  if (!inner) return null;

  return {
    ...inner,
    key,
    dynamic: true,
    groupName,
    index,
  };
}

function resolveEnumShortForm(value, options) {
  if (!options || typeof value !== 'string') return value;
  if (options.includes(value)) return value;

  const lower = value.toLowerCase();
  const exactCaseFold = options.filter((option) => String(option).toLowerCase() === lower);
  if (exactCaseFold.length === 1) return exactCaseFold[0];

  const matches = options.filter((option) => {
    const text = String(option);
    const short = text.replace(/\s*[\[(].*[\])]\s*$/, '').trim();
    if (short.toLowerCase() === lower) return true;
    if (!text.toLowerCase().startsWith(lower)) return false;
    const next = text[value.length];
    return next === undefined || /[\s([]/.test(next);
  });

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`enum shorthand is ambiguous; matches: ${matches.join(', ')}`);
  }
  throw new Error(`not one of: ${options.join(', ')}`);
}

function validateScalarValue(value, spec) {
  let resolved = value;
  if (spec?.options) resolved = resolveEnumShortForm(value, spec.options);

  const type = spec?.type;
  if (!type) return resolved;
  if (!SCALAR_TYPES.has(type)) {
    throw new Error(`expects a connected ${type} value, not a scalar`);
  }

  if (type === 'STRING' && typeof resolved !== 'string') {
    throw new Error(`expects STRING, got ${typeof resolved}`);
  }
  if ((type === 'INT' || type === 'FLOAT' || type === 'NUMBER')
      && (typeof resolved !== 'number' || !Number.isFinite(resolved))) {
    throw new Error(`expects ${type}, got ${typeof resolved}`);
  }
  if (type === 'INT' && !Number.isInteger(resolved)) {
    throw new Error(`expects INT, got ${resolved}`);
  }
  if (type === 'BOOLEAN' && typeof resolved !== 'boolean') {
    throw new Error(`expects BOOLEAN, got ${typeof resolved}`);
  }

  const { min, max } = spec.config || {};
  if (typeof resolved === 'number' && Number.isFinite(min) && resolved < min) {
    throw new Error(`must be >= ${min}`);
  }
  if (typeof resolved === 'number' && Number.isFinite(max) && resolved > max) {
    throw new Error(`must be <= ${max}`);
  }
  return resolved;
}

function targetForArg(apiPrompt, arg, flag) {
  const parsed = parseOverrideArg(arg, flag);
  const nodeId = resolveNodeTarget(apiPrompt, parsed.prefix);
  const node = apiPrompt[nodeId];
  if (!node) throw new Error(`node ${nodeId} not found`);
  return { ...parsed, nodeId, node };
}

async function validateOverrideBatch(apiPrompt, { setArgs = [], fileArgs = [], serverURL } = {}) {
  const schemaCache = new SchemaCache(serverURL);
  const errors = [];
  const warnings = [];
  const setPlans = [];
  const filePlans = [];

  if (!serverURL) {
    warnings.push('No ComfyUI server available; validation is limited to keys already present in the API graph.');
  }

  for (const arg of setArgs) {
    try {
      const target = targetForArg(apiPrompt, arg, '--set');
      const nodeInfo = await schemaCache.get(target.node.class_type);
      if (serverURL && nodeInfo === null) {
        throw new Error(`class ${target.node.class_type} is not installed on the server`);
      }
      const spec = findInputSpec(nodeInfo, target.key);
      const current = target.node.inputs?.[target.key];

      if (!spec && current === undefined) {
        throw new Error(`input key does not exist on ${target.node.class_type}`);
      }
      if (Array.isArray(current)) {
        throw new Error('input is connected; --set cannot replace graph links');
      }

      const value = validateScalarValue(coerceValue(target.raw), spec);
      setPlans.push({ ...target, value, spec });
    } catch (err) {
      errors.push({ flag: '--set', arg, message: err.message });
    }
  }

  for (const arg of fileArgs) {
    try {
      const target = targetForArg(apiPrompt, arg, '--file');
      const nodeInfo = await schemaCache.get(target.node.class_type);
      if (serverURL && nodeInfo === null) {
        throw new Error(`class ${target.node.class_type} is not installed on the server`);
      }
      const spec = findInputSpec(nodeInfo, target.key);
      const current = target.node.inputs?.[target.key];

      if (!spec && current === undefined) {
        throw new Error(`input key does not exist on ${target.node.class_type}`);
      }
      if (Array.isArray(current)) {
        throw new Error('input is already connected');
      }

      const filePath = path.resolve(target.raw);
      if (!fs.existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
      const uploadScalar = spec?.config?.image_upload
        || spec?.config?.audio_upload
        || spec?.config?.video_upload;
      let action = 'direct';
      let connectionType = null;

      if (spec && !SCALAR_TYPES.has(spec.type)) {
        connectionType = spec.type;
        if (!FILE_EXTENSIONS[connectionType]) {
          throw new Error(`cannot auto-insert a loader for ${connectionType}`);
        }
        action = 'loader';
      } else if (!uploadScalar) {
        throw new Error('file target is not an upload field or a supported connection socket');
      }

      if (action === 'loader') {
        const ext = path.extname(filePath).toLowerCase();
        if (!FILE_EXTENSIONS[connectionType].has(ext)) {
          throw new Error(`${connectionType} input does not accept ${ext || 'extensionless'} files`);
        }
      }

      filePlans.push({ ...target, filePath, spec, action, connectionType });
    } catch (err) {
      errors.push({ flag: '--file', arg, message: err.message });
    }
  }

  return { errors, warnings, setPlans, filePlans };
}

async function validatePromptGraph(apiPrompt, { serverURL } = {}) {
  const errors = [];
  const warnings = [];
  if (!serverURL) {
    warnings.push('No ComfyUI server available; full prompt validation was skipped.');
    return { errors, warnings };
  }

  const schemaCache = new SchemaCache(serverURL);
  for (const [nodeId, node] of Object.entries(apiPrompt)) {
    let nodeInfo;
    try {
      nodeInfo = await schemaCache.get(node.class_type);
    } catch (err) {
      errors.push({ nodeId, message: err.message });
      continue;
    }
    if (nodeInfo === null) {
      errors.push({ nodeId, message: `class ${node.class_type} is not installed on the server` });
      continue;
    }

    for (const [key, definition] of Object.entries(nodeInfo?.input?.required || {})) {
      const normalized = normalizeDefinition(definition);
      if (String(normalized?.type).startsWith('COMFY_AUTOGROW')) continue;
      if (node.inputs?.[key] === undefined) {
        errors.push({ nodeId, key, message: `required input is missing on ${node.class_type}` });
      }
    }

    for (const [key, value] of Object.entries(node.inputs || {})) {
      if (!Array.isArray(value)) continue;
      if (value.length !== 2 || !apiPrompt[String(value[0])]) {
        errors.push({ nodeId, key, message: `connection references missing node ${value[0]}` });
        continue;
      }
      const source = apiPrompt[String(value[0])];
      try {
        const sourceInfo = await schemaCache.get(source.class_type);
        const outputIndex = Number(value[1]);
        if (sourceInfo?.output && (!Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex >= sourceInfo.output.length)) {
          errors.push({ nodeId, key, message: `connection references missing output ${value[0]}:${value[1]}` });
        }
      } catch (err) {
        errors.push({ nodeId, key, message: err.message });
      }
    }
  }
  return { errors, warnings };
}

function applyValidatedSetPlans(apiPrompt, setPlans) {
  const applied = [];
  for (const plan of setPlans) {
    apiPrompt[plan.nodeId].inputs ||= {};
    apiPrompt[plan.nodeId].inputs[plan.key] = plan.value;
    applied.push({ nodeId: plan.nodeId, key: plan.key, value: plan.value });
  }
  return applied;
}

function insertImplicitLoader(apiPrompt, filePlan, uploadedName) {
  const loaders = {
    IMAGE: { classType: 'LoadImage', inputKey: 'image' },
    AUDIO: { classType: 'LoadAudio', inputKey: 'audio' },
  };
  const loader = loaders[filePlan.connectionType];
  if (!loader) throw new Error(`No implicit loader for ${filePlan.connectionType}`);

  const numericIds = Object.keys(apiPrompt)
    .filter((id) => /^\d+$/.test(id))
    .map(Number);
  let nextId = numericIds.length ? Math.max(...numericIds) + 1 : 1;
  while (apiPrompt[String(nextId)]) nextId++;
  const loaderId = String(nextId);

  apiPrompt[loaderId] = {
    inputs: { [loader.inputKey]: uploadedName },
    class_type: loader.classType,
    _meta: { title: `ComfyClaw implicit ${loader.classType}` },
  };
  apiPrompt[filePlan.nodeId].inputs ||= {};
  apiPrompt[filePlan.nodeId].inputs[filePlan.key] = [loaderId, 0];
  return loaderId;
}

module.exports = {
  SchemaCache,
  findInputSpec,
  resolveEnumShortForm,
  validateScalarValue,
  validateOverrideBatch,
  validatePromptGraph,
  applyValidatedSetPlans,
  insertImplicitLoader,
};
