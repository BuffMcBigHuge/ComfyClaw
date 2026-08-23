// ui-compiler.js
// Compile UI-format workflows through the installed ComfyUI frontend.

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright-core');

const MODE_VALUES = {
  active: 0,
  always: 0,
  mute: 2,
  muted: 2,
  bypass: 4,
  bypassed: 4,
};

const BOOLEAN_VALUES = {
  '1': true,
  true: true,
  on: true,
  enable: true,
  enabled: true,
  active: true,
  '0': false,
  false: false,
  off: false,
  disable: false,
  disabled: false,
  bypass: false,
  bypassed: false,
};

function splitAssignment(arg, flag) {
  const index = arg.indexOf('=');
  if (index <= 0 || index === arg.length - 1) {
    throw new Error(`Invalid ${flag} '${arg}'. Expected selector=value`);
  }
  return { selector: arg.slice(0, index), raw: arg.slice(index + 1) };
}

function parseModeArgs(args = []) {
  return args.map((arg) => {
    const { selector, raw } = splitAssignment(arg, '--mode');
    const mode = MODE_VALUES[raw.toLowerCase()];
    if (mode === undefined) {
      throw new Error(`Invalid --mode '${arg}'. Use active, mute, or bypass.`);
    }
    return { selector, mode, value: raw.toLowerCase() };
  });
}

function parseSwitchArgs(args = []) {
  return args.map((arg) => {
    const { selector: left, raw } = splitAssignment(arg, '--switch');
    const dot = left.indexOf('.');
    if (dot <= 0 || dot === left.length - 1) {
      throw new Error(`Invalid --switch '${arg}'. Expected controller.group=on|off`);
    }
    const enabled = BOOLEAN_VALUES[raw.toLowerCase()];
    if (enabled === undefined) {
      throw new Error(`Invalid --switch '${arg}'. Use on or off.`);
    }
    return {
      controller: left.slice(0, dot),
      group: left.slice(dot + 1),
      enabled,
    };
  });
}

function browserCandidates() {
  const explicit = [
    process.env.COMFYCLAW_BROWSER_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  ].filter(Boolean);

  if (process.platform === 'win32') {
    return [
      ...explicit,
      path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  }
  if (process.platform === 'darwin') {
    return [
      ...explicit,
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }
  return [
    ...explicit,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
}

function findBrowserExecutable() {
  return browserCandidates().find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

async function launchBrowser() {
  const executablePath = findBrowserExecutable();
  const options = {
    headless: process.env.COMFYCLAW_BROWSER_HEADLESS !== 'false',
    args: ['--no-first-run', '--disable-default-apps'],
  };
  if (executablePath) options.executablePath = executablePath;

  try {
    return await chromium.launch(options);
  } catch (err) {
    throw new Error(
      `Unable to launch Chrome for UI workflow compilation: ${err.message}. ` +
      'Set COMFYCLAW_BROWSER_PATH to a Chrome/Edge executable.'
    );
  }
}

async function compileUIWorkflow({ serverURL, workflowPath, modeArgs = [], switchArgs = [] }) {
  if (!serverURL) throw new Error('UI workflow compilation requires a ComfyUI server.');
  const resolvedPath = path.resolve(workflowPath);
  const workflowData = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  if (!Array.isArray(workflowData.nodes) || !Array.isArray(workflowData.links)) {
    throw new Error(`"${resolvedPath}" is not a UI-format workflow.`);
  }

  const modes = parseModeArgs(modeArgs);
  const switches = parseSwitchArgs(switchArgs);
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    await page.goto(serverURL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () => window.app?.graph && typeof window.app.loadGraphData === 'function'
        && typeof window.app.queuePrompt === 'function',
      null,
      { timeout: 60000 },
    );

    await page.evaluate(async (data) => {
      await window.app.loadGraphData(data);
    }, workflowData);
    await page.waitForFunction(
      (count) => window.app?.graph?._nodes?.length === count,
      workflowData.nodes.length,
      { timeout: 30000 },
    );

    const changes = await page.evaluate(async ({ modeOperations, switchOperations }) => {
      const graph = window.app.graph;
      const normalize = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
      const findNode = (selector) => {
        const exact = graph._nodes.filter((node) =>
          String(node.id) === selector || node.title === selector
        );
        if (exact.length === 1) return exact[0];
        const folded = graph._nodes.filter((node) =>
          String(node.title || '').toLowerCase() === selector.toLowerCase()
        );
        if (folded.length === 1) return folded[0];
        if (exact.length + folded.length === 0) throw new Error(`UI node '${selector}' not found`);
        throw new Error(`UI node '${selector}' is ambiguous`);
      };

      const applied = [];
      for (const operation of modeOperations) {
        const node = findNode(operation.selector);
        const previous = node.mode;
        node.mode = operation.mode;
        node.graph?.setDirtyCanvas?.(true, true);
        applied.push({ type: 'mode', nodeId: String(node.id), title: node.title, previous, mode: node.mode });
      }

      for (const operation of switchOperations) {
        const controller = findNode(operation.controller);
        const deadline = Date.now() + 10000;
        let candidates = [];
        do {
          candidates = (controller.widgets || []).filter((widget) => widget.group?.title);
          if (candidates.length) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        } while (Date.now() < deadline);

        const target = normalize(operation.group);
        const matches = candidates.filter((widget) =>
          String(widget.group.title).toLowerCase() === operation.group.toLowerCase()
          || normalize(widget.group.title) === target
        );
        if (matches.length !== 1) {
          const available = candidates.map((widget) => widget.group.title).join(', ');
          throw new Error(
            matches.length
              ? `Switch group '${operation.group}' is ambiguous on ${operation.controller}`
              : `Switch group '${operation.group}' not found on ${operation.controller}. Available: ${available}`
          );
        }

        const widget = matches[0];
        if (typeof widget.toggle === 'function') widget.toggle(operation.enabled);
        else if (typeof widget.doModeChange === 'function') widget.doModeChange(operation.enabled);
        else throw new Error(`Switch '${operation.group}' has no callable toggle`);
        applied.push({
          type: 'switch',
          controllerId: String(controller.id),
          controllerTitle: controller.title,
          group: widget.group.title,
          enabled: operation.enabled,
        });
      }
      return applied;
    }, { modeOperations: modes, switchOperations: switches });

    let capturedRequest = null;
    await page.route('**/prompt', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      capturedRequest = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          prompt_id: '00000000-0000-4000-8000-000000000001',
          number: 0,
          node_errors: {},
        }),
      });
    });

    await page.evaluate(async () => {
      await window.app.queuePrompt(0, 1);
    });
    await page.waitForFunction(() => true);

    if (!capturedRequest?.prompt) {
      throw new Error('The ComfyUI frontend did not produce a /prompt request.');
    }

    const controls = await page.evaluate(() => window.app.graph._nodes
      .filter((node) => String(node.type).includes('Fast Groups Bypasser'))
      .map((node) => ({
        nodeId: String(node.id),
        title: node.title,
        groups: (node.widgets || [])
          .filter((widget) => widget.group?.title)
          .map((widget) => ({ title: widget.group.title, enabled: Boolean(widget.toggled) })),
      })));

    return {
      prompt: capturedRequest.prompt,
      workflow: capturedRequest.extra_data?.extra_pnginfo?.workflow || null,
      source: 'ui',
      sourcePath: resolvedPath,
      sourceNodeCount: workflowData.nodes.length,
      compiledNodeCount: Object.keys(capturedRequest.prompt).length,
      changes,
      controls,
      pageErrors,
    };
  } catch (err) {
    throw new Error(`UI compilation failed for "${resolvedPath}": ${err.message}`);
  } finally {
    await browser.close();
  }
}

module.exports = {
  MODE_VALUES,
  BOOLEAN_VALUES,
  parseModeArgs,
  parseSwitchArgs,
  findBrowserExecutable,
  compileUIWorkflow,
};
