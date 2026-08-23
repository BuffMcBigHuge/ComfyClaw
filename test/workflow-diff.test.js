const test = require('node:test');
const assert = require('node:assert/strict');

const { diffUIToAPI } = require('../workflow-diff');

test('diff reports retained rgthree switch inputs that API export dropped', () => {
  const workflow = {
    nodes: [
      { id: 1, type: 'Source', mode: 0, outputs: [{ name: 'out', links: [1] }] },
      { id: 2, type: 'Source', mode: 4, outputs: [{ name: 'out', links: [2] }] },
      {
        id: 3,
        type: 'Any Switch (rgthree)',
        mode: 0,
        title: 'Choice',
        inputs: [
          { name: 'any_01', link: 1 },
          { name: 'any_02', link: 2 },
        ],
        outputs: [],
      },
    ],
    links: [
      [1, 1, 0, 3, 0, '*'],
      [2, 2, 0, 3, 1, '*'],
    ],
    groups: [],
  };
  const api = {
    1: { class_type: 'Source', inputs: {} },
    3: { class_type: 'Any Switch (rgthree)', inputs: { any_01: ['1', 0] } },
  };

  const diff = diffUIToAPI(workflow, api);
  assert.deepEqual(diff.rgthreeSwitches[0].dropped, ['any_02']);
  assert.equal(diff.missing.find((entry) => entry.node.id === 2).classification, 'bypassed');
});
