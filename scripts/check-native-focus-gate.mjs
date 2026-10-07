// Newly authored gate runner. Cross-platform identity checks run everywhere;
// native Win32 tests run only on Windows, and otherwise are explicitly skipped.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
const root=fileURLToPath(new URL('../',import.meta.url));
const tsx=path.join(root,'node_modules','tsx','dist','cli.mjs');
// Keep the real native press branch wired to the once-only policy. A failed
// AX call may already have opened a modal, so it cannot fall through to HID.
const bridge=fs.readFileSync(path.join(root,'native/macos/bridge.swift'),'utf8');
const begin=bridge.indexOf('} else if supportsAction(element, action: kAXPressAction as CFString) {');
assert(begin>=0);
const end=bridge.indexOf('\n\t\t\t} else {',begin);
assert(end>begin);
const nativePress=bridge.slice(begin,end);
assert.equal((nativePress.match(/performNativeActionOnce/g)||[]).length,1);
assert(!nativePress.includes('refreshElement()'));
assert(!nativePress.includes('executeCoordinates('));
assert(nativePress.includes('if attempt["outcome"] as? String != "worked"'));
assert(nativePress.includes('return finish(["outcome": "unknown"'));

for(const script of ['check-focus-window.mjs','check-windows-foreground.mjs']){
 execFileSync(process.execPath,[tsx,path.join(root,'scripts',script)],{stdio:'inherit',cwd:root});
}
if(process.platform==='darwin'){
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cu-foreground-gate-tests-'));
 try {
  const binary=path.join(temporary,'tests');
  execFileSync('xcrun',['swiftc','-parse-as-library',path.join(root,'native/macos/foreground_gate.swift'),path.join(root,'native/macos/foreground_gate_tests.swift'),'-o',binary],{stdio:'inherit',cwd:root});
  execFileSync(binary,[],{stdio:'inherit',cwd:root});
 } finally {fs.rmSync(temporary,{recursive:true,force:true});}
}else if(process.platform==='win32'){
 execFileSync('cargo',['test','--locked','--manifest-path',path.join(root,'native','windows','bridge-rs','Cargo.toml'),'foreground::tests','--','--test-threads=1'],{stdio:'inherit',cwd:root});
}else{
 console.log('SKIP native Win32 foreground tests: requires Windows; identity/backend regressions passed');
}
