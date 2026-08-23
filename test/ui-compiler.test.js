const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseModeArgs,
  parseSwitchArgs,
  findBrowserExecutable,
} = require('../ui-compiler');

test('UI mode controls accept agent-friendly mode names', () => {
  assert.deepEqual(parseModeArgs(['42=active', '@optional=bypass', '7=mute']), [
    { selector: '42', mode: 0, value: 'active' },
    { selector: '@optional', mode: 4, value: 'bypass' },
    { selector: '7', mode: 2, value: 'mute' },
  ]);
  assert.throws(() => parseModeArgs(['42=sometimes']), /active, mute, or bypass/);
});

test('UI switch controls preserve controller and group selectors', () => {
  assert.deepEqual(parseSwitchArgs(['@references.picture_1=on', '9.optional.branch=off']), [
    { controller: '@references', group: 'picture_1', enabled: true },
    { controller: '9', group: 'optional.branch', enabled: false },
  ]);
  assert.throws(() => parseSwitchArgs(['@references=on']), /controller.group/);
});

test('a local Chrome-family browser is discoverable for UI compilation', () => {
  assert.equal(typeof findBrowserExecutable(), 'string');
});
