import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind, executeObserve, executeAct, shutdownComputerUseSession} from '../src/bridge.ts';

const root = {kind:'window',rootRef:'owned-document',windowRef:'owned-document',windowId:10,pid:7,appName:'Fixture',title:'Owned fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
let inputs = 0;
let evidence = {status:'observed',readOnly:true,source:'AXDocument',documentURL:'file:///tmp/owned.docx',parentRole:'AXApplication'};
const overrides = {
  ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),
  listApps:async()=>[{appName:'Fixture',pid:7}], listRoots:async()=>[root],
  getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:10,rootRef:root.rootRef}),
  observe:async()=>parseLookResponse({lookId:'document-look',window:{windowId:10,metadata:{documentEvidence:evidence}},outline:{ref:'window',role:'AXWindow',children:[{ref:'button',role:'AXButton',title:'Disabled command',isEnabled:false,canPress:true}]}}),
  act:async()=>{inputs++;throw Error('Unexpected input');},
};
const original = Object.fromEntries(Object.keys(overrides).map(key=>[key,backend[key]]));
const originalName = backend.name;
Object.assign(backend,overrides,{name:'macos'});
const call = (fn,params)=>fn('window-document-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try {
  const found = await call(executeFind,{text:root.title});
  const ref = found.details.windows[0].windowRef;
  for (const status of ['observed','busy','unconfirmed']) {
    evidence = status === 'observed' ? evidence : {status,readOnly:true,source:'AXDocument'};
    const observed = await call(executeObserve,{root:ref,mode:'semantic'});
    assert.deepEqual(observed.details.windowDocumentEvidence,evidence);
    assert.equal(observed.details.target.windowId,10);
    assert.equal(observed.details.target.pid,7);
    const button = observed.details.outline.root.children[0];
    await assert.rejects(call(executeAct,{stateId:observed.details.capture.stateId,actions:[{action:'press',ref:button.ref}]}),/disabled/i);
  }
  assert.equal(inputs,0,'Document metadata never overrides action guards');
  console.log('PASS public window document evidence, unavailable states and unchanged input guards');
} finally {
  Object.assign(backend,original,{name:originalName});
  await shutdownComputerUseSession();
}
