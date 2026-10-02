import assert from 'node:assert/strict';
import {CdpTab} from '../src/cdp.ts';
function tabWith(handler){const tab=Object.create(CdpTab.prototype);tab.accessibilityCoverage={};tab.send=(method,params={})=>handler(method,params);return tab;}
const ax=(id,role,backend,children=[],parent)=>({nodeId:String(id),role:{value:role},backendDOMNodeId:backend,childIds:children.map(String),parentId:parent===undefined?undefined:String(parent)});
const main=[ax(1,'RootWebArea',10,[2]),ax(2,'Iframe',20,[],1)];
const child=[ax(1,'RootWebArea',30,[2,3]),ax(2,'button',31,[],1),ax(3,'Iframe',32,[],1)];
const nested=[ax(1,'RootWebArea',40,[2]),ax(2,'button',41,[],1)];
const calls=[];
const tab=tabWith(async(method,params)=>{
 calls.push({method,params});
 if(method==='DOM.describeNode')return {node:{frameId:params.backendNodeId===20?'child':'nested'}};
 assert.equal(method,'Accessibility.getFullAXTree');
 return {nodes:params.frameId==='child'?child:params.frameId==='nested'?nested:main};
});
const nodes=await tab.accessibilityTree();
assert.equal(new Set(nodes.map(n=>n.nodeId)).size,nodes.length,'frame AX IDs must not collide');
assert.deepEqual(nodes.find(n=>n.nodeId==='2').childIds,['child:1']);
assert.equal(nodes.find(n=>n.nodeId==='child:1').parentId,'2');
assert.deepEqual(nodes.find(n=>n.nodeId==='child:3').childIds,['nested:1']);
assert.equal(nodes.find(n=>n.nodeId==='nested:2').backendDOMNodeId,41);
assert.equal(tab.accessibilityCoverage.framesObserved,2);
assert.equal(main[1].childIds.length,0,'never mutate the raw AX response');
assert.equal(calls.length,5);
const unavailable=tabWith(async(method,params)=>{
 if(method==='DOM.describeNode')return {node:{frameId:'gone'}};
 if(params.frameId)throw Error('Frame target is out of process');
 return {nodes:main};
});
const partial=await unavailable.accessibilityTree();
assert.equal(partial.length,2);
assert.equal(unavailable.accessibilityCoverage.framesUnavailable,1);
assert.equal(partial[1].childIds.length,0,'failed frame must not invent action targets');
const many=Array.from({length:13},(_,i)=>ax(i+2,'Iframe',i+100,[],1));
const bounded=tabWith(async(method,params)=>method==='DOM.describeNode'?{node:{frameId:'f'+params.backendNodeId}}:{nodes:params.frameId?[ax(1,'RootWebArea',200)]:[ax(1,'RootWebArea',10,many.map(x=>x.nodeId)),...many]});
await bounded.accessibilityTree();
assert.equal(bounded.accessibilityCoverage.framesObserved,12);
assert.equal(bounded.accessibilityCoverage.framesTruncated,true);
const oversized=tabWith(async(method,params)=>method==='DOM.describeNode'?{node:{frameId:'huge'}}:{nodes:params.frameId?Array.from({length:20000},(_,i)=>ax(i+1,'button',i+100)):main});
assert.equal((await oversized.accessibilityTree()).length,2);
assert.equal(oversized.accessibilityCoverage.framesTruncated,true);
console.log('CDP frame tree ownership, ID collision, unavailable and collection-limit checks passed');

const remoteCalls=[];
const remote=tabWith(async(method,params)=>{
 remoteCalls.push({method,params});
 if(method==='DOM.describeNode')return {node:{frameId:'remote'}};
 if(params.frameId)throw Error('CDP error: Frame with the given frameId is not found.');
 return {nodes:main};
});
remote.inspectRemoteFrame=async owner=>{assert.equal(owner,20);return {frameId:'remote',nodes:child};};
const remoteNodes=await remote.accessibilityTree();
assert(remoteNodes.filter(n=>n.nodeId.startsWith('remote:')).every(n=>n.cuReadOnlyRemote===true));
assert.equal(remote.accessibilityCoverage.readOnlyFrames,1);
assert.equal(remote.accessibilityCoverage.framesObserved,1);
assert.equal(remote.accessibilityCoverage.framesUnavailable,1,'nested remote frames need scoped ownership and must stay unavailable');
assert.equal(remoteCalls.filter(c=>c.method==='DOM.describeNode').length,1,'remote backend IDs must never resolve on the main session');
const timedOut=tabWith(async(method,params)=>{
 if(method==='DOM.describeNode')return {node:{frameId:'remote'}};
 if(params.frameId)throw Error('CDP command timed out');
 return {nodes:main};
});
timedOut.inspectRemoteFrame=async()=>{throw Error('must not attach after an unclassified read timeout');};
await timedOut.accessibilityTree();
assert.equal(timedOut.accessibilityCoverage.framesUnavailable,1);
assert.equal(timedOut.accessibilityCoverage.readOnlyFrames,0);
console.log('CDP remote read-only frame ownership and timeout fallback checks passed');

const budgetOwners=[ax(2,'Iframe',20,[],1),ax(3,'Iframe',21,[],1),ax(4,'Iframe',22,[],1)];
const budgetCalls=[];
const shared=tabWith(async(method,params)=>{
 budgetCalls.push({method,params});
 if(method==='DOM.describeNode')return {node:{frameId:'remote-'+params.backendNodeId}};
 if(params.frameId)throw Error('CDP error: Frame not found');
 return {nodes:[ax(1,'RootWebArea',10,[2,3,4]),...budgetOwners]};
});
let remoteReads=0;
shared.inspectRemoteFrame=async(owner,probe,budget,parent,traversal)=>{
 remoteReads++;assert.equal(traversal.depth,0);
 if(owner===20){assert.equal(traversal.frames,1);traversal.frames+=10;}
 else {assert.equal(owner,21);assert.equal(traversal.frames,12);}
 return {frameId:'remote-'+owner,loaderId:'loader',parentFrameId:'main',nodes:[ax(1,'RootWebArea',90)],nestedObserved:owner===20?10:0};
};
await shared.accessibilityTree();
assert.equal(remoteReads,2,'Nested frame work must consume the same budget as sibling root frames');
assert.equal(shared.accessibilityCoverage.framesObserved,12);
assert.equal(shared.accessibilityCoverage.framesTruncated,true);
assert(!budgetCalls.some(c=>c.params.backendNodeId===22),'Do not dispatch reads for a sibling after nested traversal exhausts the budget');
console.log('CDP nested and sibling frame collection shares one global budget');

const partialRoute=tabWith(async(method,params)=>{
 if(method==='DOM.describeNode')return {node:{frameId:'outer'}};
 if(params.frameId)throw Error('CDP error: Frame not found');
 return {nodes:main};
});
partialRoute.inspectRemoteFrame=async()=>({frameId:'outer',loaderId:'loader',parentFrameId:'main',nestedObserved:1,nestedReadOnly:1,nodes:[ax(1,'RootWebArea',30,[2]),{...ax(2,'button',80,[],1),cuReadOnlyRemote:true}]});
const partialRouteNodes=await partialRoute.accessibilityTree();
assert.equal(partialRoute.accessibilityCoverage.readOnlyFrames,1,'Nested frames missing verified ancestry must be reported read-only even if outer route is actionable');
assert.equal(partialRoute.accessibilityCoverage.framesObserved,2);
assert.equal(partialRouteNodes.find(n=>n.backendDOMNodeId===80).cuReadOnlyRemote,true);
assert.equal(partialRouteNodes.find(n=>n.backendDOMNodeId===80).cuRemoteFrameRoute,undefined);
console.log('Nested read-only frame coverage remains explicit under actionable outer routes');
