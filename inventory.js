// inventory.js
// Query ComfyUI servers for available models, LoRAs, VAEs, etc.
// Optionally scan local directories for model files.
// Stores inventory in inventory/ directory.

const fs = require('node:fs');
const path = require('node:path');
const { getServerWithLowestQueue } = require('./helpers');

const BASE_DIR = process.env.COMFYCLAW_DIR || __dirname;
const INVENTORY_DIR = path.join(BASE_DIR, 'inventory');

// Asset types we query from ComfyUI /object_info
const ASSET_TYPES = {
  checkpoints: { classType: 'CheckpointLoaderSimple', inputKey: 'ckpt_name' },
  loras:       { classType: 'LoraLoader',             inputKey: 'lora_name' },
  vaes:        { classType: 'VAELoader',              inputKey: 'vae_name' },
  upscalers:   { classType: 'UpscaleModelLoader',     inputKey: 'model_name' },
  samplers:    { classType: 'KSampler',               inputKey: 'sampler_name' },
  schedulers:  { classType: 'KSampler',               inputKey: 'scheduler' },
};

// Model file extensions to look for when scanning directories
const MODEL_EXTENSIONS = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.bin']);

// Directory name → asset type mapping for auto-categorization
const DIR_NAME_MAP = {
  checkpoints: 'checkpoints',
  ckpts: 'checkpoints',
  loras: 'loras',
  lora: 'loras',
  vae: 'vaes',
  vaes: 'vaes',
  upscale_models: 'upscalers',
  upscalers: 'upscalers',
};

/**
 * Fetch the list of available values for an asset type from a ComfyUI server.
 */
async function fetchAssetList(serverURL, classType, inputKey) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(
      `${serverURL}/object_info/${encodeURIComponent(classType)}`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const nodeInfo = data?.[classType];
    if (!nodeInfo) return [];
    const allInputs = { ...(nodeInfo.input?.required || {}), ...(nodeInfo.input?.optional || {}) };
    const entry = allInputs[inputKey];
    if (Array.isArray(entry) && Array.isArray(entry[0])) return entry[0];
    return [];
  } catch (err) {
    clearTimeout(timeoutId);
    throw new Error(`Failed to fetch ${classType}.${inputKey}: ${err.message}`);
  }
}

/**
 * Get the server URL (env override or auto-select).
 */
async function getServerURL() {
  const envServer = process.env.COMFYUI_SERVER;
  if (envServer) return envServer;
  try {
    const res = await getServerWithLowestQueue();
    if (!res.allServersDown && res.serverToUse) return res.serverToUse;
  } catch { /* ignore */ }
  return null;
}

/**
 * Pull full inventory from a ComfyUI server.
 * Returns { checkpoints: [...], loras: [...], vaes: [...], ... }
 */
async function pullInventory(serverURL) {
  const inventory = {};
  for (const [type, { classType, inputKey }] of Object.entries(ASSET_TYPES)) {
    inventory[type] = await fetchAssetList(serverURL, classType, inputKey);
  }
  return inventory;
}

/**
 * Recursively scan directories for model files.
 * Auto-categorizes based on parent directory names.
 * Returns { checkpoints: [...], loras: [...], uncategorized: [...], ... }
 */
function scanDirectories(dirs) {
  const results = {};

  function walk(dir, category) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`  Warning: Cannot read directory ${dir}: ${err.message}`);
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Check if this directory name maps to an asset category
        const dirLower = entry.name.toLowerCase();
        const newCategory = DIR_NAME_MAP[dirLower] || category;
        walk(fullPath, newCategory);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (MODEL_EXTENSIONS.has(ext)) {
          const cat = category || 'uncategorized';
          if (!results[cat]) results[cat] = [];
          results[cat].push(entry.name);
        }
      }
    }
  }

  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) {
      console.warn(`  Warning: Directory not found: ${resolved}`);
      continue;
    }

    // Check if the top-level dir itself maps to a category
    const topDirName = path.basename(resolved).toLowerCase();
    const topCategory = DIR_NAME_MAP[topDirName] || null;
    walk(resolved, topCategory);
  }

  // Deduplicate within each category
  for (const [cat, items] of Object.entries(results)) {
    results[cat] = [...new Set(items)].sort();
  }

  return results;
}

// ── Inventory File I/O ───────────────────────────────────────────────────

function ensureInventoryDir() {
  fs.mkdirSync(INVENTORY_DIR, { recursive: true });
}

function inventoryPath() {
  return path.join(INVENTORY_DIR, 'inventory.json');
}

/**
 * Load the stored inventory (raw list of available assets per type).
 */
function loadInventory() {
  const p = inventoryPath();
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Save inventory to disk.
 */
function saveInventory(inventoryData, source) {
  ensureInventoryDir();
  const data = {
    pulled_at: new Date().toISOString(),
    source: source || null,
    assets: {},
  };
  for (const [type, items] of Object.entries(inventoryData)) {
    if (type.startsWith('_')) continue;
    data.assets[type] = items;
  }
  fs.writeFileSync(inventoryPath(), JSON.stringify(data, null, 2));
  return data;
}

/**
 * Merge scanned results into an existing inventory.
 * Adds new items, preserves existing ones.
 */
function mergeInventory(existing, scanned, source) {
  const merged = { ...(existing?.assets || {}) };

  for (const [type, items] of Object.entries(scanned)) {
    if (!merged[type]) {
      merged[type] = [];
    }
    const existingSet = new Set(merged[type]);
    for (const item of items) {
      existingSet.add(item);
    }
    merged[type] = [...existingSet].sort();
  }

  return saveInventory(merged, source);
}

module.exports = {
  ASSET_TYPES,
  INVENTORY_DIR,
  pullInventory,
  scanDirectories,
  getServerURL,
  loadInventory,
  saveInventory,
  mergeInventory,
};
