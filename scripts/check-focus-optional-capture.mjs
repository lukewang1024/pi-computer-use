// Newly authored public focus-tool regression; native backend is injected.
import assert from 'node:assert/strict';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeFocusWindow,shutdownComputerUseSession} from '../src/bridge.ts';
const root={kind:'window',rootRef:'native-root',windowRef:'native-root',windowId:10,pid:7,appName:'Fixture',title:'Owned fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
let captures=0,inputs=0,wrongFront=false,focusError=false;
const overrides={ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:'Fixture',pid:7}],listRoots:async()=>[root],getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:wrongFront?20:10,rootRef:wrongFront?'floating':'native-root'}),
 focusWindow:async()=>{if(focusError)throw Error('Focus transport outcome unknown');return {focused:true,activated:true,setMain:true,setFocused:true,raised:true};},
 observe:async()=>{captures++;throw Error('Capture unavailable');},act:async()=>{inputs++;throw Error('Unexpected input');}};
const original=Object.fromEntries(Object.keys(overrides).map(key=>[key,backend[key]]));Object.assign(backend,overrides);
const call=(fn,params)=>fn('focus-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try{
 const roots=await call(executeFind,{text:'Owned fixture'});const ref=roots.details.windows[0].windowRef;
 const focused=await call(executeFocusWindow,{root:ref});
 assert.equal(focused.details.focusWindow.verified,true);
 assert.equal(focused.details.observation.status,'omitted');assert.equal(captures,0);
 const captured=await call(executeFocusWindow,{root:ref,capture:true});
 assert.equal(captured.details.focusWindow.verified,true,'read-only capture failure must not erase verified focus');
 assert.equal(captured.details.observation.status,'failed');assert.equal(captured.details.observation.completion,'unconfirmed');assert.equal(captures,1);
 assert.equal(captured.details.stateId,undefined);assert.equal(captured.details.capture,undefined,'failed capture must not invent a successor');
 wrongFront=true;const rejected=await call(executeFocusWindow,{root:ref});
 assert.equal(rejected.details.focusWindow.verified,false,'native advisory success cannot override exact HWND evidence');
 focusError=true;await assert.rejects(()=>call(executeFocusWindow,{root:ref,capture:true}),/Focus transport outcome unknown/);
 assert.equal(captures,1,'focus transport failure must not become an optional capture error');assert.equal(inputs,0);
 console.log('Focus optional-capture regression checks passed (new coverage; injected native backend)');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
