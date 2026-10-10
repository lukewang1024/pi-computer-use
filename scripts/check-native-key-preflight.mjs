// Newly authored argument regressions; does not deliver platform input.
import assert from 'node:assert/strict';
import {normalizeKeypressKeys} from '../src/actions.ts';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeObserve,executeSearchUi,executeAct,shutdownComputerUseSession} from '../src/bridge.ts';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveHelperSourcePaths} from './setup-helper.mjs';
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
const unmapped = ['🙂', '汉', 'é', 'e\u0301', '\0'];
for (const key of unmapped) {
 assert.deepEqual(normalizeKeypressKeys('macos',[key]),[key]);
 for (const modifier of ['cmd','ctrl','shift','alt']) {
  assert.throws(()=>normalizeKeypressKeys('macos',[modifier,key]),/Unsupported/);
  assert.throws(()=>normalizeKeypressKeys('macos',[modifier+'+'+key]),/Unsupported/);
 }
}
for (const key of ['a','1','.',"'",'`','[',']','\\','-','=','+','~','left','f12','forward_delete','space',' ']) {
 assert.deepEqual(normalizeKeypressKeys('macos',['cmd',key]),['cmd',key]);
}
for (let code=32;code<=126;code++) {
 const key=String.fromCharCode(code);
 assert.deepEqual(normalizeKeypressKeys('macos',['cmd',key]),['cmd',key.toLowerCase()]);
}
// Exercise exported CU executors with a controlled Mac backend. An invalid
// later shortcut must reject the whole transaction before its valid AX prefix.
const original={...backend};
let nativeCalls=0,focusCalls=0;
const root={kind:'window',rootRef:'native-key-root',windowId:731,pid:100731,appName:'Key fixture',title:'Owned key fixture',zOrder:0,
 framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
Object.assign(backend,{name:'macos',ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),
 listApps:async()=>[{appName:root.appName,pid:root.pid}],listRoots:async()=>[root],
 getFrontmost:async()=>({appName:root.appName,pid:root.pid,windowId:root.windowId,rootRef:root.rootRef}),
 isBrowserApp:()=>false,isChromeFamilyApp:()=>false,
 observe:async()=>parseLookResponse({lookId:'key-look',capturedAt:Date.now()/1000,
  window:{windowId:root.windowId,framePoints:root.framePoints,scaleFactor:1,isModal:false},
  outline:{ref:'native-key-button',role:'button',title:'Submit',canPress:true,actions:['press'],children:[]},timings:{}}),
 act:async()=>{nativeCalls++;throw Error('Native action must not be reached');},
 actBatch:async()=>{nativeCalls++;throw Error('Native batch must not be reached');},
 focusWindow:async()=>{focusCalls++;throw Error('Foreground activation must not be reached');},shutdown:async()=>{}});
const call=(fn,params)=>fn('key-preflight-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try {
 for (const keys of [['cmd','🙂'],['ctrl+汉'],['a','alt+é']]) {
  const roots=await call(executeFind,{text:root.title});
  const observation=await call(executeObserve,{root:roots.details.windows[0].windowRef,mode:'semantic'});
  const search=await call(executeSearchUi,{stateId:observation.details.capture.stateId,text:'Submit',role:'button'});
  const ref=search.details.matches[0].ref;
  await assert.rejects(()=>call(executeAct,{stateId:observation.details.capture.stateId,
   actions:[{action:'press',ref},{action:'keypress',ref,keys}]}),/Unsupported/);
 }
 assert.equal(nativeCalls,0,'invalid shortcut must not dispatch even the valid prefix');
 assert.equal(focusCalls,0,'invalid shortcut must not activate the target');
} finally {await shutdownComputerUseSession();Object.assign(backend,original);}
if (process.platform === 'darwin') {
 const temporary=mkdtempSync(path.join(os.tmpdir(),'cu-native-key-preflight-'));
 try {
  const rootDir=fileURLToPath(new URL('../',import.meta.url));
  const binary=path.join(temporary,'tests');
  const frameworks=['ApplicationServices','AppKit','ScreenCaptureKit','Foundation','SwiftUI'].flatMap(name=>['-framework',name]);
  execFileSync('xcrun',['swiftc','-parse-as-library','-D','PI_CU_TEST_NATIVE_KEYS',...frameworks,...resolveHelperSourcePaths(rootDir),'-o',binary],{stdio:'inherit'});
  execFileSync(binary,[],{stdio:'inherit'});
 } finally {rmSync(temporary,{recursive:true,force:true});}
} else console.log('SKIP compiled native Mac key parser: requires Swift on macOS; public preflight checks ran');
console.log('Native key argument preflight checks passed (new coverage; no input)');
