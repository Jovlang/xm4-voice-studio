import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
let abort = false;
const database = {
  transaction() {
    const transaction = { objectStore: () => ({ put() {
      const request = { result: 'sound:example' };
      queueMicrotask(() => {
        request.onsuccess?.();
        if (abort) { transaction.error = new Error('quota failure after request success'); transaction.onabort?.(); }
        else transaction.oncomplete?.();
      });
      return request;
    } }) };
    return transaction;
  },
};
const indexedDB = { open() {
  const request = { result: database };
  queueMicrotask(() => request.onsuccess());
  return request;
} };
const source = readFileSync(new URL('../src/lib/store.ts', import.meta.url), 'utf8').replace(/^export /gm, '');
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const put = vm.runInContext(js + '\nset;', vm.createContext({ indexedDB, setTimeout, clearTimeout, Error }));
assert.equal(await put('sound:example', new Uint8Array()), 'sound:example');
abort = true;
await assert.rejects(put('sound:example', new Uint8Array()), /quota failure after request success/);
console.log('IndexedDB transaction completion and abort checks passed');
