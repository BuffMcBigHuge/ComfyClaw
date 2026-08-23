// workflow-diff.js
// Explain what a ComfyUI UI graph loses when exported as an API prompt.

const FRONTEND_ONLY = /(?:Fast Groups Bypasser|Label \(rgthree\)|MarkdownNote|^Note$|Reroute)/i;

function modeName(mode) {
  return ({ 0: 'active', 1: 'on-event', 2: 'muted', 3: 'on-trigger', 4: 'bypassed' })[mode] || `mode-${mode}`;
}

function nodeLabel(node) {
  const title = node.title || node.properties?.['Node name for S&R'];
  return `${node.id}:${node.type}${title && title !== node.type ? ` (${title})` : ''}`;
}

function slotName(node, direction, index) {
  const slots = direction === 'in' ? node?.inputs : node?.outputs;
  return slots?.[index]?.name ?? String(index);
}

function classifyNode(node, apiIds) {
  if (apiIds.has(String(node.id))) return 'retained';
  if ([...apiIds].some((id) => id.startsWith(`${node.id}:`))) return 'expanded-subgraph';
  if (node.mode === 4) return 'bypassed';
  if (node.mode === 2) return 'muted';
  if (FRONTEND_ONLY.test(node.type)) return 'frontend-only';
  return 'stripped';
}

function buildComponents(missingNodes, links) {
  const missingIds = new Set(missingNodes.map((node) => String(node.id)));
  const adjacency = new Map([...missingIds].map((id) => [id, new Set()]));
  for (const link of links) {
    const origin = String(link[1]);
    const target = String(link[3]);
    if (missingIds.has(origin) && missingIds.has(target)) {
      adjacency.get(origin).add(target);
      adjacency.get(target).add(origin);
    }
  }

  const components = [];
  const seen = new Set();
  for (const id of missingIds) {
    if (seen.has(id)) continue;
    const stack = [id];
    const component = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      component.add(current);
      for (const neighbor of adjacency.get(current) || []) stack.push(neighbor);
    }
    components.push(component);
  }
  return components;
}

function groupTargets(workflow, controller) {
  const groups = workflow.groups || [];
  const matcher = controller.properties?.matchTitle;
  if (!matcher) return [];
  try {
    const regex = new RegExp(matcher, 'i');
    return groups.filter((group) => regex.test(group.title || ''));
  } catch {
    return [];
  }
}

function diffUIToAPI(workflow, apiPrompt) {
  const apiIds = new Set(Object.keys(apiPrompt));
  const nodesById = new Map(workflow.nodes.map((node) => [String(node.id), node]));
  const entries = workflow.nodes.map((node) => ({
    node,
    classification: classifyNode(node, apiIds),
  }));
  const missing = entries.filter((entry) => entry.classification !== 'retained');
  const executableMissing = missing.filter((entry) => !['frontend-only', 'expanded-subgraph'].includes(entry.classification));

  const chains = buildComponents(executableMissing.map((entry) => entry.node), workflow.links || [])
    .map((component) => {
      const incoming = [];
      const outgoing = [];
      for (const link of workflow.links || []) {
        const [linkId, originId, originSlot, targetId, targetSlot, type] = link;
        const origin = String(originId);
        const target = String(targetId);
        if (!component.has(origin) && component.has(target)) {
          const source = nodesById.get(origin);
          const destination = nodesById.get(target);
          incoming.push({
            linkId,
            type,
            text: `${source ? nodeLabel(source) : origin}.${slotName(source, 'out', originSlot)} -> ${nodeLabel(destination)}.${slotName(destination, 'in', targetSlot)}`,
          });
        }
        if (component.has(origin) && !component.has(target)) {
          const source = nodesById.get(origin);
          const destination = nodesById.get(target);
          outgoing.push({
            linkId,
            type,
            text: `${nodeLabel(source)}.${slotName(source, 'out', originSlot)} -> ${destination ? nodeLabel(destination) : target}.${slotName(destination, 'in', targetSlot)}`,
          });
        }
      }
      return {
        nodes: [...component].map((id) => nodesById.get(id)).filter(Boolean),
        incoming,
        outgoing,
      };
    })
    .filter((chain) => chain.incoming.length || chain.outgoing.length);

  const controllers = workflow.nodes
    .filter((node) => /Fast Groups Bypasser \(rgthree\)/i.test(node.type))
    .map((node) => ({
      node,
      matchTitle: node.properties?.matchTitle || '',
      matchColors: node.properties?.matchColors || '',
      groups: groupTargets(workflow, node),
    }));

  const rgthreeSwitches = workflow.nodes
    .filter((node) => /(?:Any Switch|Power Lora Loader).*\(rgthree\)/i.test(node.type))
    .map((node) => {
      const apiNode = apiPrompt[String(node.id)];
      const uiConnected = (node.inputs || []).filter((input) => input.link != null).map((input) => input.name);
      const apiConnected = Object.entries(apiNode?.inputs || {})
        .filter(([, value]) => Array.isArray(value))
        .map(([key]) => key);
      return {
        node,
        retained: Boolean(apiNode),
        uiConnected,
        apiConnected,
        dropped: uiConnected.filter((key) => !apiConnected.includes(key)),
      };
    });

  return {
    uiNodeCount: workflow.nodes.length,
    apiNodeCount: Object.keys(apiPrompt).length,
    entries,
    missing,
    chains,
    controllers,
    rgthreeSwitches,
    modeName,
    nodeLabel,
  };
}

module.exports = { diffUIToAPI, modeName, nodeLabel };
