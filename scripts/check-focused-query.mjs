import assert from 'node:assert/strict';
import {parseLookResponse,searchOutlineRanked} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeObserve,executeSearchUi,shutdownComputerUseSession} from '../src/bridge.ts';
const raw={lookId:'focus-query',window:{windowId:10,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1},outline:{ref:'window',role:'window',focused:true,truncated:true,children:[{ref:'zoom',role:'edit',title:'Zoom',focused:false},{ref:'editor',role:'edit',title:'Editor',focused:true},{ref:'unknown',role:'edit',title:'Unknown'}]}};
const tree=parseLookResponse(raw).parsedOutline;
for(const focused of [true,false]){
 const result=searchOutlineRanked(tree,undefined,'edit',undefined,12,focused);
 assert.equal(result.totalMatches,1,'Focus filtering must exclude other state and unknown');
 assert.equal(result.matches[0].focused,focused);
}
assert.equal(searchOutlineRanked(tree,undefined,'edit').totalMatches,3,'Omitted predicate preserves prior search');
const crowded=parseLookResponse({...raw,outline:{...raw.outline,children:[...Array.from({length:20},(_,i)=>({ref:'other-'+i,role:'edit',title:'Other',focused:false})),{ref:'focused-last',role:'edit',title:'Editor',focused:true,canFocus:true}]}}).parsedOutline;
assert.equal(searchOutlineRanked(crowded,undefined,'edit',undefined,12,true).matches[0].label,'Editor','Filter before result cap; a focused editor after twelve controls must remain findable');
assert.equal(searchOutlineRanked(crowded,'Editor','edit','focus',12,true).totalMatches,1,'All supplied predicates are conjunctive');
assert.equal(searchOutlineRanked(crowded,'Editor','button',undefined,12,true).totalMatches,0);

const root={kind:'window',rootRef:'focus-query-root',windowRef:'focus-query-root',windowId:10,pid:7,appName:'Fixture',title:'Focus fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
let observations=0,inputs=0;
const overrides={ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:'Fixture',pid:7}],listRoots:async()=>[root],getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:10,rootRef:root.rootRef}),observe:async()=>{observations++;return parseLookResponse(raw);},act:async()=>{inputs++;throw Error('Unexpected input');}};
const original=Object.fromEntries(Object.keys(overrides).map(k=>[k,backend[k]]));Object.assign(backend,overrides);
const call=(fn,params)=>fn('focus-query-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try{
 const found=await call(executeFind,{text:root.title});const rootRef=found.details.windows[0].windowRef;
 for(const focused of [true,false]){
  const observation=await call(executeObserve,{root:rootRef,mode:'semantic',outlineQuery:{role:'edit',focused}});
  const query=observation.details.queryResult;
  assert.equal(query.query.focused,focused);assert.equal(query.totalMatches,1);assert.equal(query.matches[0].focused,focused);
  assert.equal(query.cachedTreeComplete,false,'A filtered match does not establish native tree completeness');
  const stateId=observation.details.capture.stateId;const before=observations;
  const search=await call(executeSearchUi,{stateId,role:'edit',focused});
  assert.equal(search.details.totalMatches,1);assert.equal(search.details.matches[0].focused,focused);
  const focusOnly=await call(executeSearchUi,{stateId,focused:false});assert.equal(focusOnly.details.totalMatches,1);
  const miss=await call(executeSearchUi,{stateId,text:'Missing editor',focused:true});assert.equal(miss.details.totalMatches,0);
  assert.equal(observations,before,'Focus predicates use cached observation; OCR cannot supply keyboard focus');
 }
 const before=observations;
 for(const focused of ['true',0,null]){
  await assert.rejects(call(executeSearchUi,{focused,role:'edit'}),/focused.*boolean/);
  await assert.rejects(call(executeObserve,{root:rootRef,mode:'semantic',outlineQuery:{focused}}),/focused.*boolean/);
 }
 assert.equal(observations,before,'Invalid focused predicates reject before native observation');assert.equal(inputs,0);
 console.log('PASS true/false/unknown focus, conjunctive filtering, focus-only queries, unchanged defaults, cached zero-input miss, truncation truth and invalid preflight');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
