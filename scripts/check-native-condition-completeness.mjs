// Controlled public executors, with no native helper, capture or GUI input.
import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind, executeObserve, executeSearchUi, executeAct, executeWaitFor, shutdownComputerUseSession} from '../src/bridge.ts';
import {outcomeAfterCheck} from '../src/actions.ts';

const root = {kind:'window',rootRef:'owned-root',windowRef:'owned-root',windowId:10,pid:7,
 appName:'Fixture',title:'Owned condition fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},
 scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
let value = 'old', dispatches = 0, waits = 0, sequence = 0, incomplete = true;
const overrides = {
 name:'macos', ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),
 listApps:async()=>[{appName:root.appName,pid:7}],listRoots:async()=>[root],
 getFrontmost:async()=>({appName:root.appName,pid:7,windowId:10,rootRef:root.rootRef}),
 isBrowserApp:()=>false,isChromeFamilyApp:()=>false,
 observe:async()=>parseLookResponse({lookId:'condition-'+(++sequence),window:{windowId:10,rootRef:root.rootRef,
  framePoints:root.framePoints,scaleFactor:1},outline:{ref:'window',role:'AXWindow',children:[
   {ref:'field',role:'AXTextField',title:'Field',value,focused:true,isTextInput:true,canSetValue:true,children:[]}
  ]}}),
 act:async request=>{dispatches++;value=request.params.text;return {outcome:'worked',performed:{delivery:'ax'}};},
 actBatch:undefined,
 waitFor:async request=>{waits++;return incomplete
  ? {found:false,timedOut:true,incomplete:true,reason:'condition_tree_incomplete',nodeCount:2000}
  : {found:true,gone:request.gone,nodeCount:31};},
 shutdown:async()=>{},
};
const original = Object.fromEntries(Object.keys(overrides).map(k=>[k,backend[k]]));
Object.assign(backend,overrides);
const call = (fn,params)=>fn('condition-completeness',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try {
 for (const until of ['present','absent']) {
  const roots = await call(executeFind,{text:root.title});
  const observed = await call(executeObserve,{root:roots.details.windows[0].windowRef,mode:'semantic'});
  const found = await call(executeSearchUi,{stateId:observed.details.capture.stateId,text:'Field',role:'AXTextField'});
  const ref = found.details.matches.find(m=>m.matchReason==='exact').ref;
  const before = dispatches;
  const result = await call(executeAct,{stateId:observed.details.capture.stateId,
   actions:[{action:'setText',ref,text:'new'}],expect:{text:'deep condition',until,timeoutMs:100},observationMode:'semantic'});
  assert.equal(dispatches,before+1,'Condition reading must never replay delivered input');
  assert.equal(result.details.execution.outcome,'unknown','A matching successor value must not override an incomplete business condition');
  assert.equal(result.details.execution.verification.status,'unverified');
  assert.equal(result.details.execution.verification.reason,'condition_tree_incomplete');
  assert.equal(result.details.execution.verification.nodeCount,2000);
  assert.equal(result.details.execution.error.code,'postcondition_unverified');
  assert.equal(result.details.outline.root.children[0].value,'new','Delivered value and unverified condition are separate facts');
  const wait = await call(executeWaitFor,{stateId:result.details.capture.stateId,text:'deep condition',until,timeoutMs:100});
  assert.equal(wait.details.found,false);assert.equal(wait.details.incomplete,true);
  assert.equal(wait.details.reason,'condition_tree_incomplete');
  assert(wait.content.some(c=>c.type==='text'&&c.text.includes('unverified')));
 }
 incomplete = false;
 const roots = await call(executeFind,{text:root.title});
 const observed = await call(executeObserve,{root:roots.details.windows[0].windowRef,mode:'semantic'});
 const ref = observed.details.outline.root.children[0].ref;
 const result = await call(executeAct,{stateId:observed.details.capture.stateId,
  actions:[{action:'setText',ref,text:'complete'}],expect:{text:'deep condition',timeoutMs:100},observationMode:'semantic'});
 assert.equal(result.details.execution.outcome,'worked');
 assert.equal(result.details.execution.verification.status,'verified');
 assert.equal(result.details.execution.error,undefined);
 assert.equal(outcomeAfterCheck('didnt','unverified'),'didnt','A proven pre-dispatch refusal remains a refusal');
 assert(waits>=5);
 console.log('PASS incomplete native presence/absence receipts, preserved input effects, no replay and complete positive regression');
} finally { Object.assign(backend,original); await shutdownComputerUseSession(); }
