import assert from 'node:assert/strict';
import {CdpTab,cdpSnapshotOutline} from '../src/cdp.ts';
import {restoreOutline,nodeByRef} from '../src/outline.ts';
import {changesBetween} from '../src/view.ts';
const wire=Object.create(CdpTab.prototype),sent=[];
wire.nextId=1;wire.pending=new Map();
let wrongSession=false;
wire.ws={send(raw){const request=JSON.parse(raw);sent.push(request);queueMicrotask(()=>wire.handleMessage(JSON.stringify({id:request.id,result:{ok:true},...(request.sessionId?{sessionId:wrongSession?'foreign':request.sessionId}:{})})));}};
assert.deepEqual(await wire.send('Page.getFrameTree',{},1000,'child'),{ok:true});
assert.equal(sent[0].sessionId,'child');
wrongSession=true;
await assert.rejects(()=>wire.send('Page.getFrameTree',{},1000,'child'),/different target session/);
assert.equal(sent.length,2,'mismatched responses must not replay requests');
let mainLoads=0;wire.loadFired=()=>mainLoads++;
wire.handleMessage(JSON.stringify({method:'Page.loadEventFired',sessionId:'child'}));
assert.equal(mainLoads,0,'child events cannot settle main navigation');
wire.handleMessage(JSON.stringify({method:'Page.loadEventFired'}));
assert.equal(mainLoads,1);

for(const mode of ['success','foreign-target','foreign-parent','wrong-frame','owner-changed','read-error','non-frame','document-changed','missing-loader']){
 const tab=Object.create(CdpTab.prototype),calls=[];tab.targetId='owned-page';let owners=0,frameReads=0;
 tab.send=async(method,params={},timeout,sessionId)=>{
  calls.push({method,params,sessionId});assert(timeout>0&&timeout<=1000);
  if(method==='DOM.describeNode'){owners++;return {node:{nodeName:mode==='non-frame'?'DIV':'IFRAME',frameId:mode==='owner-changed'&&owners===2?'replacement':'owned-frame'}};}
  if(method==='Target.getTargetInfo')return {targetInfo:{type:'iframe',targetId:mode==='foreign-target'?'foreign':'owned-frame',parentId:mode==='foreign-parent'?'other-page':'owned-page'}};
  if(method==='Target.attachToTarget'){assert.equal(params.targetId,'owned-frame');assert.equal(params.flatten,true);return {sessionId:'owned-session'};}
  if(method==='Target.detachFromTarget'){assert.equal(params.sessionId,'owned-session');return {};}
  if(method==='DOM.getBoxModel'){assert.equal(sessionId,undefined);assert.equal(params.backendNodeId,20);return {model:{content:[200,300,700,300,700,400,200,400]}};}
  assert.equal(sessionId,'owned-session','frame reads must use the attached frame session');
  if(method==='Page.getFrameTree'){frameReads++;return {frameTree:{frame:{id:mode==='wrong-frame'?'foreign':'owned-frame',loaderId:mode==='missing-loader'?undefined:mode==='document-changed'&&frameReads===2?'new-document':'owned-document'}}};}
  if(method==='Accessibility.getFullAXTree'){
   if(mode==='read-error')throw Error('Frame disappeared');
   return {nodes:[{nodeId:'1',role:{value:'button'},name:{value:'Probe'},backendDOMNodeId:31}]};
  }
  if(method==='Page.getLayoutMetrics')return {cssLayoutViewport:{clientWidth:500,clientHeight:100}};
  assert.equal(method,'DOM.getContentQuads');assert.equal(params.backendNodeId,31);return {quads:[[8,8,100,8,100,30,8,30]]};
 };
 if(mode==='success'){
  const result=await tab.inspectRemoteFrame(20,{name:'Probe',role:'button'});assert.equal(result.frameId,'owned-frame');assert.equal(result.loaderId,'owned-document');assert.equal(result.nodes.length,1);
  assert.deepEqual(result.frameOwnerQuad,[200,300,700,300,700,400,200,400]);
 }else await assert.rejects(()=>tab.inspectRemoteFrame(20,{name:'Probe',role:'button'}));
 const attached=calls.filter(c=>c.method==='Target.attachToTarget').length;
 assert.equal(attached,['foreign-target','foreign-parent','non-frame'].includes(mode)?0:1);
 assert.equal(calls.filter(c=>c.method==='Target.detachFromTarget').length,attached,'every attached session must be released on success and failure');
 assert.equal(calls.filter(c=>c.method.startsWith('Input.')).length,0,'inspection must never send input');
}
console.log('CDP session routing, owner checks, child event isolation and cleanup checks passed');

for(const budget of [0,-1,NaN,Infinity]){
 const tab=Object.create(CdpTab.prototype);let sent=0;
 tab.send=async()=>{sent++;throw Error('Must not dispatch');};
 await assert.rejects(()=>tab.inspectRemoteFrame(20,undefined,budget),/finite positive budget/);
 assert.equal(sent,0,'Invalid inspection budget must fail before native requests');
}
{
 const tab=Object.create(CdpTab.prototype);let sent=0;
 const realNow=Date.now;let tick=0;
 Date.now=()=>{tick+=1001;return tick;};
 tab.send=async(method)=>{
  sent++;
  if(method==='DOM.describeNode')return {node:{nodeName:'IFRAME',frameId:'frame'}};
  if(method==='Target.getTargetInfo')return {targetInfo:{targetId:'frame',type:'iframe'}};
  throw Error('Inspection exceeded expected bounded requests');
 };
 try{
  await assert.rejects(()=>tab.inspectRemoteFrame(20,undefined,1e9),/deadline exceeded/);
  assert.equal(sent,2,'Oversized caller budget must still obey three-second deadline');
 }finally{Date.now=realNow;}
}

for (const mode of ['success','foreign-parent','changed-owner','read-error']) {
 const tab=Object.create(CdpTab.prototype);tab.targetId='top-page';const calls=[];let owners=0;
 tab.send=async(method,params={},timeout,sessionId)=>{
  calls.push({method,sessionId});assert(timeout>0&&timeout<=1000);
  if(['DOM.describeNode','Target.getTargetInfo','Target.attachToTarget','Target.detachFromTarget','DOM.getBoxModel'].includes(method))assert.equal(sessionId,'parent-session','Nested owner operations must stay in their parent process');
  else assert.equal(sessionId,'inner-session','Nested document operations must stay in the inner process');
  if(method==='DOM.describeNode')return {node:{nodeName:'IFRAME',frameId:mode==='changed-owner'&&++owners===2?'replacement':'inner-frame'}};
  if(method==='Target.getTargetInfo')return {targetInfo:{type:'iframe',targetId:'inner-frame',parentId:mode==='foreign-parent'?'foreign':'parent-frame',parentFrameId:'parent-frame'}};
  if(method==='Target.attachToTarget')return {sessionId:'inner-session'};
  if(method==='Target.detachFromTarget')return {};
  if(method==='DOM.getBoxModel')return {model:{content:[0,0,100,0,100,100,0,100]}};
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'inner-frame',loaderId:'inner-loader'}}};
  if(method==='Accessibility.getFullAXTree'){if(mode==='read-error')throw Error('Inner frame unavailable');return {nodes:[{nodeId:'1'}]};}
  if(method==='Page.getLayoutMetrics')return {cssLayoutViewport:{clientWidth:100,clientHeight:100}};
  throw Error('Unexpected request '+method);
 };
 const inspect=()=>tab.inspectRemoteFrame(20,undefined,2000,{sessionId:'parent-session',targetId:'parent-frame'});
 if(mode==='success')assert.equal((await inspect()).loaderId,'inner-loader');else await assert.rejects(inspect);
 const attached=calls.filter(c=>c.method==='Target.attachToTarget').length;
 assert.equal(attached,mode==='foreign-parent'?0:1);
 assert.equal(calls.filter(c=>c.method==='Target.detachFromTarget').length,attached);
 assert.equal(calls.filter(c=>c.method.startsWith('Input.')).length,0);
}
console.log('Nested remote inspection parent scoping and failure cleanup passed');

for (const failInner of [false,true]) {
 const tab=Object.create(CdpTab.prototype);tab.targetId='page';const calls=[];
 tab.send=async(method,params={},timeout,sessionId)=>{
  calls.push({method,sessionId});assert(timeout>0&&timeout<=1000);
  const inner=sessionId==='outer-session',frame=inner?'inner':'outer';
  if(method==='DOM.describeNode')return {node:{nodeName:'IFRAME',frameId:frame}};
  if(method==='Target.getTargetInfo')return {targetInfo:{type:'iframe',targetId:frame,parentId:inner?'outer':'page',parentFrameId:inner?'outer':'main'}};
  if(method==='Target.attachToTarget')return {sessionId:frame+'-session'};
  if(method==='Target.detachFromTarget')return {};
  if(method==='DOM.getBoxModel')return {model:{content:[0,0,100,0,100,100,0,100]}};
  if(method==='Page.getFrameTree')return {frameTree:{frame:{id:sessionId==='inner-session'?'inner':'outer',loaderId:'loader'}}};
  if(method==='Accessibility.getFullAXTree'){
   if(sessionId==='inner-session'){if(failInner)throw Error('Inner disappeared');return {nodes:[{nodeId:'same-id',role:{value:'button'},name:{value:'Inner target'},backendDOMNodeId:80}]};}
   return {nodes:[{nodeId:'same-id',role:{value:'Iframe'},backendDOMNodeId:30}]};
  }
  if(method==='Page.getLayoutMetrics')return {cssLayoutViewport:{clientWidth:100,clientHeight:100}};
  throw Error('Unexpected request '+method);
 };
 const result=await tab.inspectRemoteFrame(20);
 assert.equal(result.nestedObserved,failInner?0:1);
 assert.equal(result.nestedUnavailable,failInner?1:0);
 if(!failInner){const node=result.nodes.find(n=>n.name?.value==='Inner target');assert(node);assert.equal(node.nodeId,'inner:same-id');assert.equal(node.parentId,'same-id');assert.equal(node.cuReadOnlyRemote,false);assert.equal(node.cuRemoteFrameRoute.frameId,'inner');assert.equal(node.cuRemoteFrameRoute.ancestor.frameId,'outer');}
 assert.equal(calls.filter(c=>c.method==='Target.attachToTarget').length,2);
 assert.equal(calls.filter(c=>c.method==='Target.detachFromTarget').length,2);
 assert(!calls.some(c=>c.method.startsWith('Input.')));
}
console.log('Recursive remote observation ID isolation and inner failure cleanup passed');

{
 const nodes=[{nodeId:'1',role:{value:'RootWebArea'},childIds:['2']},{nodeId:'2',parentId:'1',role:{value:'button'},name:{value:'Original'},backendDOMNodeId:20}];
 const first=cdpSnapshotOutline('first',nodes);
 const second=cdpSnapshotOutline('second',nodes.map(n=>n.nodeId==='2'?{...n,name:{value:'Replacement'},backendDOMNodeId:21}:n));
 const oldRef=first.targets[0].ref;
 assert(/^@e\d+$/.test(oldRef));
 assert.notEqual(second.targets[0].ref,oldRef,'Successor state must never reuse an old browser element ref');
 const restored=restoreOutline(second.outline);
 assert.equal(nodeByRef(restored,oldRef),undefined,'Old ref paired with new state cannot resolve to a replacement');
 assert.equal(nodeByRef(restored,second.targets[0].ref)?.title,'Replacement');
 assert.equal(restored.refToWireRef.get(second.targets[0].ref),'cdp:2');
}
console.log('Browser snapshot refs remain disjoint across state refresh and serialization');

{
 const nodes=[{nodeId:'1',role:{value:'RootWebArea'},childIds:['2']},{nodeId:'2',parentId:'1',role:{value:'button'},name:{value:'Same'},backendDOMNodeId:20}];
 const first=restoreOutline(cdpSnapshotOutline('diff-first',nodes).outline);
 const second=restoreOutline(cdpSnapshotOutline('diff-second',nodes).outline);
 assert.notEqual(first.root.ref,second.root.ref);
 assert.equal(changesBetween(first,second,'wire').changedNodeCount,0,'Fresh browser refs alone must not generate UI changes');
 const changed=restoreOutline(cdpSnapshotOutline('diff-third',nodes.map(n=>n.nodeId==='2'?{...n,name:{value:'Changed'}}:n)).outline);
 const diff=changesBetween(second,changed,'wire');assert.equal(diff.changedNodeCount,1);assert.equal(diff.changes[0].ref,changed.nodes.find(n=>n.title==='Changed').ref,'Delta must use current actionable ref');
 assert.equal(nodeByRef(changed,second.nodes.find(n=>n.title==='Same').ref),undefined,'Compact diffs must not restore stale input references');
}
console.log('Browser wire-identity diffs avoid ref-renumbering noise while preserving stale-ref rejection');

{
 const tree=[{nodeId:'1',role:{value:'RootWebArea'},childIds:['2','3']},{nodeId:'2',parentId:'1',role:{value:'group'},childIds:['4']},{nodeId:'3',parentId:'1',role:{value:'group'},childIds:[]},{nodeId:'4',parentId:'2',role:{value:'button'},name:{value:'Moved'},backendDOMNodeId:40}];
 const before=restoreOutline(cdpSnapshotOutline('move-before',tree).outline);
 const moved=tree.map(n=>n.nodeId==='2'?{...n,childIds:[]}:n.nodeId==='3'?{...n,childIds:['4']}:n.nodeId==='4'?{...n,parentId:'3'}:n);
 const moveDiff=changesBetween(before,restoreOutline(cdpSnapshotOutline('move-after',moved).outline),'wire');
 assert.equal(moveDiff.useFullView,true);assert.equal(moveDiff.reason,'structure_changed','Reparenting must not silently return an empty UI diff');
 const reordered=tree.map(n=>n.nodeId==='1'?{...n,childIds:['3','2']}:n);
 assert.equal(changesBetween(before,restoreOutline(cdpSnapshotOutline('reorder',reordered).outline),'wire').reason,'structure_changed');
 assert.equal(changesBetween(before,restoreOutline(cdpSnapshotOutline('same-tree',tree).outline),'wire').changedNodeCount,0);
}
console.log('Browser reparenting and sibling reorder request current full structure without ref noise');
