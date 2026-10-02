// Newly authored argument regressions; does not deliver platform input.
import assert from 'node:assert/strict';
import {normalizeKeypressKeys} from '../src/actions.ts';
assert.deepEqual(normalizeKeypressKeys('windows',['CTRL','A']),['ctrl','a']);
assert.deepEqual(normalizeKeypressKeys('windows',['F24']),['f24']);
assert.deepEqual(normalizeKeypressKeys('linux',['Control','F35']),['control','f35']);
assert.deepEqual(normalizeKeypressKeys('macos',['Command','O']),['cmd','o']);
assert.deepEqual(normalizeKeypressKeys('macos',['cmd+shift+p']),['cmd+shift+p']);
for(const platform of ['windows','linux','macos']){
 for(const invalid of [[],[''],[3],['definitely-not-a-key']])assert.throws(()=>normalizeKeypressKeys(platform,invalid));
}
for(const key of ['.',',','/',';',"'",'`','[',']','\\','-','=','\0','\n']){
 assert.throws(()=>normalizeKeypressKeys('windows',['ctrl',key]),/Unsupported|empty/,'raw ASCII must not be mistaken for a Windows virtual key: '+JSON.stringify(key));
}
assert.throws(()=>normalizeKeypressKeys('windows',['F25']),/Unsupported/);
assert.throws(()=>normalizeKeypressKeys('linux',['F36']),/Unsupported/);
assert.throws(()=>normalizeKeypressKeys('macos',['cmd','ctrl']),/Unsupported/);
console.log('Native key argument preflight checks passed (new coverage; no input)');
