import assert from 'node:assert/strict';
import {parseLookResponse, serializeOutline, serializeFoldedOutline, restoreOutline, nodeByRef} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind, executeObserve, executeSearchUi, executeExpandUi, executeAct, shutdownComputerUseSession} from '../src/bridge.ts';
const leaf=(ref,title,extra={})=>({ref,role:'text',title,children:[],...extra});
const raw={lookId:'fold-fixture',window:{windowId:10,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1},outline:{ref:'window',role:'frame',title:'Owned fixture',children:[{ref:'panel',role:'filler',children:[{ref:'menus',role:'menu bar',children:Array.from({length:300},(_,i)=>leaf(`menu-${i}`,`Menu ${i}`))},{ref:'document',role:'scroll pane',children:[leaf('editor','Owned editor',{isTextInput:true,canSetValue:true,isEnabled:false,value:'Owned baseline'})]}]}]}};
const parsed=parseLookResponse(raw).parsedOutline;
const before=JSON.stringify(serializeOutline(parsed));
const folded=serializeFoldedOutline(parsed);
assert.equal(folded.view,'folded');
assert.equal(folded.observedNodeCount,305);
assert.equal(folded.returnedNodeCount,4);
assert.equal(folded.root.children[0].children[0].disclosure.omittedNodeCount,300);
assert.equal(folded.root.children[0].children[1].disclosure.omittedNodeCount,1);
assert.equal(folded.root.children[0].children[1].truncated,false,'Response folding must not invent a native read frontier');
assert.equal(JSON.stringify(serializeOutline(parsed)),before,'Folding must not mutate the complete cached tree');
assert.equal(nodeByRef(parsed,parsed.nodes.at(-1).ref).isEnabled,false);
assert.throws(()=>restoreOutline(folded),/not a complete observation/);
assert.ok(JSON.stringify(folded).length < before.length*.05,'Large menu descendants should not dominate a folded response');
// Native truncation and response folding are independently visible.
parsed.root.children[0].children[1].truncated=true;
assert.equal(serializeFoldedOutline(parsed).root.children[0].children[1].truncated,true);

const root={kind:'window',rootRef:'native-root',windowRef:'native-root',windowId:10,pid:7,appName:'Fixture',title:'Owned fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
let observes=0,inputs=0;
const overrides={ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:'Fixture',pid:7}],listRoots:async()=>[root],getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:10,rootRef:'native-root'}),observe:async()=>{observes++;return parseLookResponse(raw);},act:async()=>{inputs++;throw Error('Unexpected input');}};
const original=Object.fromEntries(Object.keys(overrides).map(k=>[k,backend[k]]));Object.assign(backend,overrides);
const call=(fn,params)=>fn('folded-observe-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try{
 const found=await call(executeFind,{text:root.title});const ref=found.details.windows[0].windowRef;
 const full=await call(executeObserve,{root:ref,mode:'semantic'});
 assert.equal(full.details.outline.view,undefined);
 assert.equal(restoreOutline(full.details.outline).nodes.length,305);
 const compact=await call(executeObserve,{root:ref,mode:'semantic',outlineView:'folded'});
 assert.equal(compact.details.outline.returnedNodeCount,4);
 const stateId=compact.details.capture.stateId;
 const search=await call(executeSearchUi,{stateId,text:'Owned editor'});
 assert.equal(search.details.matches.length,1,'Search must use the retained hidden descendants');
 const editor=search.details.matches[0];assert.equal(editor.isEnabled,false);
 const expanded=await call(executeExpandUi,{stateId,ref:compact.details.outline.root.children[0].children[1].ref,includeSubtree:true});
 assert.equal(expanded.details.subtree.root.children[0].ref,editor.ref);
 assert.equal(expanded.details.subtree.root.children[0].value,'Owned baseline');
 assert.equal(observes,2,'Cached search/expansion must not repeat native capture');
 await assert.rejects(call(executeAct,{stateId,actions:[{action:'typeText',ref:editor.ref,text:'Blocked'}]}),/disabled; input was not sent/);
 assert.equal(inputs,0,'Folded output must not bypass disabled-state input guards');
 const count=observes;
 for(const params of [{outlineView:'tiny'},{mode:'pixels',outlineView:'folded'},{mode:'metrics',outlineView:'full'}]){
  await assert.rejects(call(executeObserve,{root:ref,...params}),/outlineView/);
 }
 assert.equal(observes,count,'Invalid combinations must reject before native observation');
 console.log('PASS folded projection, disclosure counts, native frontiers, immutable complete state, cached search/expand, disabled zero-input guard and preflight');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
