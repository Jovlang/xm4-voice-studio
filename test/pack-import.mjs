import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/scripts/app.ts', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('async function applySharedPack('), source.indexOf('async function importLocalPack('));
const code = ts.transpileModule(handlers, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function setup({ fail = false, cancel = false, stale = false } = {}) {
  const state = { assignments: { 0: 'library/old.mp3' }, hiddenLibrary: [], source: '01', sounds: [], openedPack: stale ? 'pack-id' : undefined, openedPackVerified: false };
  const pack = { source: '01', assignments: { 15: 'custom/Hundred' }, sounds: { Hundred: Uint8Array.of(255, 251, 1) } };
  const files = new Map();
  let failing = fail, downloads = 0;
  const context = vm.createContext({
    state, Uint8Array, Object, Error, LANG_NAMES: { '01': 'English' },
    linkedPackId: () => 'pack-id', shareEnabled: true,
    downloadPack: async () => { downloads++; return pack; },
    store: { get: async key => files.get(key), set: async (key, data) => files.set(key, data) },
    loadSounds: async () => {
      if (failing) throw new Error('library unavailable');
      state.sounds = [...files.keys()].map(key => ({ id: `custom/${key.slice(6)}` }));
    },
    sharePanel: (message, options) => {
      if (message.startsWith('Open the shared pack?')) options.actions.find(([label]) => label === (cancel ? 'Cancel' : 'Open'))[1]();
    },
    closeShare: () => {}, save: () => {}, renderSlots: () => {},
    $: () => ({ scrollIntoView() {}, value: '' }), matchMedia: () => ({ matches: true }), errMsg: error => error.message,
  });
  const open = vm.runInContext(code + '\nimportLinkedPack;', context);
  return { open, state, files, downloads: () => downloads, retry: () => { failing = false; } };
}
const failed = setup({ fail: true });
await failed.open();
assert.equal(failed.state.openedPack, undefined);
assert.equal(failed.state.assignments[0], 'library/old.mp3');
failed.retry(); await failed.open();
assert.equal(failed.state.assignments[15], 'custom/Hundred');
assert.equal(failed.state.openedPackVerified, true);
assert.equal(failed.downloads(), 2);
await failed.open(); assert.equal(failed.downloads(), 2);

const cancelled = setup({ cancel: true });
await cancelled.open();
assert.equal(cancelled.state.openedPack, undefined);
assert.equal(cancelled.files.size, 0);
assert.equal(cancelled.state.assignments[0], 'library/old.mp3');

const stale = setup({ stale: true });
await stale.open();
assert.equal(stale.downloads(), 1, 'Unverified markers from older versions must be retried');
assert.equal(stale.state.assignments[15], 'custom/Hundred');
console.log('Pack import recovery checks passed');
