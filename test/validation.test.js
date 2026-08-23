const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findInputSpec,
  resolveEnumShortForm,
  validateScalarValue,
  insertImplicitLoader,
  validatePromptGraph,
} = require('../validation');

test('findInputSpec expands COMFY_AUTOGROW_V3 socket names', () => {
  const info = {
    input: {
      optional: {
        images: ['COMFY_AUTOGROW_V3', {
          template: {
            input: { required: { image: ['IMAGE', {}] } },
            prefix: 'image_',
            min: 0,
            max: 9,
          },
        }],
      },
    },
  };

  assert.deepEqual(findInputSpec(info, 'images.image_0'), {
    type: 'IMAGE',
    options: null,
    config: {},
    key: 'images.image_0',
    dynamic: true,
    groupName: 'images',
    index: 0,
  });
  assert.equal(findInputSpec(info, 'images.image_9'), null);
});

test('enum shorthand resolves a unique labelled option', () => {
  const options = ['1:1 (Square)', '9:16 (Portrait Widescreen)', '16:9 (Widescreen)'];
  assert.equal(resolveEnumShortForm('9:16', options), '9:16 (Portrait Widescreen)');
  assert.equal(resolveEnumShortForm('16:9 (Widescreen)', options), '16:9 (Widescreen)');
  assert.throws(() => resolveEnumShortForm('4:5', options), /not one of/);
});

test('connected socket types reject scalar overrides', () => {
  assert.throws(
    () => validateScalarValue('image.png', { type: 'IMAGE', config: {} }),
    /connected IMAGE/,
  );
});

test('implicit image loader uses a fresh node and connects the target', () => {
  const prompt = {
    5: { class_type: 'Target', inputs: {} },
    9: { class_type: 'Other', inputs: {} },
  };
  const loaderId = insertImplicitLoader(prompt, {
    connectionType: 'IMAGE',
    nodeId: '5',
    key: 'images.image_0',
  }, 'uploaded.png');

  assert.equal(loaderId, '10');
  assert.deepEqual(prompt['10'], {
    inputs: { image: 'uploaded.png' },
    class_type: 'LoadImage',
    _meta: { title: 'ComfyClaw implicit LoadImage' },
  });
  assert.deepEqual(prompt['5'].inputs['images.image_0'], ['10', 0]);
});

test('full graph validation catches required inputs disconnected by UI controls', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      SaveResult: {
        input: { required: { images: ['IMAGE', {}] } },
        output: [],
      },
    }),
  });

  try {
    const result = await validatePromptGraph({
      34: { class_type: 'SaveResult', inputs: {} },
    }, { serverURL: 'http://comfy.test' });

    assert.deepEqual(result.errors, [{
      nodeId: '34',
      key: 'images',
      message: 'required input is missing on SaveResult',
    }]);
  } finally {
    global.fetch = originalFetch;
  }
});
