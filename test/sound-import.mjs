import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Run the actual UI import handler with browser/audio/storage boundaries simulated.
const source = readFileSync(new URL('../src/scripts/app.ts', import.meta.url), 'utf8');
const handler = source.slice(source.indexOf('let soundsUploading ='), source.indexOf('// ---------- slots ----------'));
assert.ok(handler.includes('async function uploadSounds'));
const js = ts.transpileModule(handler, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function setup({ convert, save, render } = {}) {
  const classes = new Set();
  const elements = {
    dock: { classList: { add: (...names) => names.forEach(n => classes.add(n)), remove: name => classes.delete(name) } },
    soundAdd: { disabled: false },
    soundDrop: { innerHTML: 'Drop audio here', textContent: '' },
  };
  const state = { sounds: [] };
  const saved = [];
  let errors = [];
  let renders = 0;
  const context = vm.createContext({
    Uint8Array, state, $: id => elements[id],
    toSlotMp3: convert || (async () => Uint8Array.of(255, 251, 1)),
    store: { set: save || (async (key) => saved.push(key)) },
    blobUrl: () => 'blob:test', errMsg: e => e.message,
    showErrors: (_, lines) => { errors = [...lines]; },
    renderSounds: render || (() => renders++), renderSlots: () => renders++,
    loadSounds: () => { throw new Error('A successful import must not refetch the library'); },
  });
  const upload = vm.runInContext(js + '\nuploadSounds;', context);
  return { upload, state, saved, elements, classes, errors: () => errors, renders: () => renders };
}

const success = setup();
await success.upload([{ name: 'Eighty.mp3' }, { name: 'Eighty.mp3' }]);
assert.deepEqual(success.saved, ['sound:Eighty', 'sound:Eighty_2']);
assert.equal(success.state.sounds.length, 2);
assert.equal(success.renders(), 2);
assert.equal(success.elements.soundAdd.disabled, false);
assert.equal(success.classes.has('open'), true);
assert.equal(success.classes.has('hold'), false);
assert.equal(success.elements.soundDrop.innerHTML, 'Drop audio here');
assert.deepEqual(success.errors(), []);

const partial = setup({ convert: async f => {
  if (f.name === 'bad.mp3') throw new Error('unsupported audio');
  return Uint8Array.of(255, 251);
} });
await partial.upload([{ name: 'bad.mp3' }, { name: 'good.wav' }]);
assert.equal(partial.state.sounds.length, 1);
assert.match(partial.errors()[0], /bad.mp3: couldn't convert.*unsupported audio/);
assert.equal(partial.elements.soundAdd.disabled, false);

const storage = setup({ save: async () => { throw new Error('quota exceeded'); } });
await storage.upload([{ name: 'sound.mp3' }]);
assert.equal(storage.state.sounds.length, 0);
assert.match(storage.errors()[0], /couldn't save.*quota exceeded/);
assert.equal(storage.elements.soundAdd.disabled, false);

const renderFailure = setup({ render: () => { throw new Error('render failed'); } });
await renderFailure.upload([{ name: 'sound.mp3' }]);
assert.equal(renderFailure.saved.length, 1);
assert.match(renderFailure.errors()[0], /Reload to recover saved sounds/);
assert.equal(renderFailure.elements.soundAdd.disabled, false);
assert.equal(renderFailure.classes.has('hold'), false);

let finish;
const concurrent = setup({ convert: () => new Promise(resolve => { finish = resolve; }) });
const first = concurrent.upload([{ name: 'first.mp3' }]);
await concurrent.upload([{ name: 'second.mp3' }]);
finish(Uint8Array.of(255, 251));
await first;
assert.deepEqual(concurrent.saved, ['sound:first']);
assert.equal(concurrent.elements.soundAdd.disabled, false);

console.log('Sound import regressions passed (5 scenarios)');
