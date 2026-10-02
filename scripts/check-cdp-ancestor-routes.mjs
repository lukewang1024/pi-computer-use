import assert from 'node:assert/strict';
import {CdpTab} from '../src/cdp.ts';
const outer={ownerBackendNodeId:20,frameId:'outer',loaderId:'outer-loader',parentFrameId:'main'};
const inner={ownerBackendNodeId:30,frameId:'inner',loaderId:'inner-loader',parentFrameId:'outer',ancestor:outer};
for(const mode of ['success','outer-navigation','inner-read-failure','foreign-inner-parent']){
 const tab=Object.create(CdpTab.prototype);tab.targetId='page';const calls=[];let actionCalls=0,outerReads=0;
 tab.send=async(method,params={},timeout,sessionId)=>{
  calls.push({method,params,sessionId});assert(timeout>0&&timeout<=5000);
  if(method==='DOM.describeNode'){
   assert.equal(sessionId,params.backendNodeId===20?undefined:'outer-session');return {node:{nodeName:'IFRAME',frameId:params.backendNodeId===20?'outer':'inner'}};
  }
  if(method==='Target.getTargetInfo'){
   const child=params.targetId==='inner';assert.equal(sessionId,child?'outer-session':undefined);
   return {targetInfo:{type:'iframe',targetId:params.targetId,parentFrameId:child?'outer':'main',parentId:child?(mode==='foreign-inner-parent'?'foreign':'outer'):'page'}};
  }
  if(method==='Target.attachToTarget')return {sessionId:params.targetId+'-session'};
  if(method==='Target.detachFromTarget')return {};
  assert.equal(method,'Page.getFrameTree');
  const child=sessionId==='inner-session';
  if(child&&mode==='inner-read-failure')throw Error('Inner read failed');
  if(!child)outerReads++;
  return {frameTree:{frame:{id:child?'inner':'outer',loaderId:!child&&mode==='outer-navigation'&&outerReads>1?'replacement':child?'inner-loader':'outer-loader'}}};
 };
 const run=()=>tab.withRemoteFrameDocument(inner,async(sessionId,verify,ownerSessionId)=>{actionCalls++;assert.equal(sessionId,'inner-session');assert.equal(ownerSessionId,'outer-session');await verify();return 'verified';});
 if(mode==='success')assert.equal(await run(),'verified');else await assert.rejects(run);
 assert.equal(actionCalls,mode==='success'?1:0,'Failed ancestry must stop before action callback');
 const attaches=calls.filter(c=>c.method==='Target.attachToTarget');
 const detaches=calls.filter(c=>c.method==='Target.detachFromTarget');
 assert.equal(detaches.length,attaches.length);
 assert.deepEqual(detaches.map(c=>c.params.sessionId),attaches.map(c=>c.params.targetId+'-session').reverse());
 assert(!calls.some(c=>c.method.startsWith('Input.')));
}
const tab=Object.create(CdpTab.prototype);let sent=0;tab.send=async()=>{sent++;};
const cyclic={...outer};cyclic.ancestor=cyclic;
await assert.rejects(()=>tab.withRemoteFrameDocument(cyclic,async()=>{}),/cyclic/);assert.equal(sent,0);
console.log('CDP ancestor route ownership, navigation rejection, reverse cleanup and cycle guards passed');

for(const stolen of [undefined,20,30]){
 const tab=Object.create(CdpTab.prototype);tab.targetId='page';const trace=[];
 tab.send=async(method,params={},timeout,sessionId)=>{
  trace.push({method,params,sessionId});
  if(method==='DOM.describeNode')return {node:{nodeName:'IFRAME',frameId:params.backendNodeId===20?'outer':'inner'}};
  if(method==='Target.getTargetInfo'){const child=params.targetId==='inner';return {targetInfo:{type:'iframe',targetId:params.targetId,parentFrameId:child?'outer':'main',parentId:child?'outer':'page'}};}
  if(method==='Target.attachToTarget')return {sessionId:params.targetId+'-session'};
  if(method==='Target.detachFromTarget')return {};
  if(method==='Page.getFrameTree'){const child=sessionId==='inner-session';return {frameTree:{frame:{id:child?'inner':'outer',loaderId:child?'inner-loader':'outer-loader'}}};}
  assert.equal(method,'Input.dispatchKeyEvent');assert.equal(sessionId,'inner-session');return {};
 };
 const owners=[];
 tab.withBackendNode=async(id,fn,args=[],sessionId)=>{
  if(id===80){assert.equal(sessionId,'inner-session');return;}
  owners.push({id,sessionId});assert.equal(sessionId,id===20?undefined:'outer-session');
  if(id===stolen)throw Error('Ancestor focus stolen');
 };
 if(stolen===undefined)await tab.keypressRemoteBackendNode(inner,80,['Enter']);else await assert.rejects(()=>tab.keypressRemoteBackendNode(inner,80,['Enter']),/focus stolen/);
 assert.equal(trace.filter(c=>c.method==='Input.dispatchKeyEvent').length,stolen===undefined?2:0,'Every owner focus must be proven before keyboard dispatch');
 if(stolen===undefined)assert.deepEqual(owners.map(x=>x.id),[20,30]);
 assert.equal(trace.filter(c=>c.method==='Target.detachFromTarget').length,2);
}
console.log('Nested keyboard checks every ancestor focus in its owning session before input');

for(const mode of ['success','middle-overlay','outer-overlay','middle-moved','unknown-input','scrolled','outer-offscreen']){
 const tab=Object.create(CdpTab.prototype),trace=[];let checks=0,middleBoxes=0;
 const frames=[{route:outer,sessionId:'outer-session',parentTargetId:'page'},{route:inner,sessionId:'inner-session',parentSessionId:'outer-session',parentTargetId:'outer'}];
 tab.withRemoteFrameDocument=async(route,fn)=>fn('inner-session',async()=>{checks++;},'outer-session',async()=>{},frames);
 tab.withBackendNode=async()=>{};
 tab.send=async(method,params={},timeout,sessionId)=>{
  trace.push({method,params,sessionId});
  if(method==='DOM.getContentQuads')return {quads:[[10,10,30,10,30,30,10,30]]};
  if(method==='DOM.resolveNode')return {object:{objectId:params.backendNodeId===80?'target':'hit'}};
  if(method==='Runtime.callFunctionOn')return {result:{value:true}};
  if(method==='Runtime.evaluate')return {result:{value:{width:100,height:100}}};
  if(method==='Runtime.releaseObjectGroup')return {};
  if(method==='DOM.getBoxModel'){
   if(params.backendNodeId===30){assert.equal(sessionId,'outer-session');middleBoxes++;return {model:{content:mode==='middle-moved'&&middleBoxes>1?[11,10,111,10,111,110,11,110]:[10,10,110,10,110,110,10,110]}};}
   assert.equal(sessionId,undefined);return {model:{content:mode==='outer-offscreen'?[-400,100,-200,100,-200,300,-400,300]:[100,100,300,100,300,300,100,300]}};
  }
  if(method==='Page.getLayoutMetrics')return {cssLayoutViewport:{pageX:mode==='scrolled'?sessionId==='inner-session'?3:sessionId==='outer-session'?7:11:0,pageY:mode==='scrolled'?sessionId==='inner-session'?83:sessionId==='outer-session'?123:726:0,clientWidth:800,clientHeight:600}};
  if(method==='DOM.getNodeForLocation'){
   if(mode==='scrolled'){assert.equal(params.x,sessionId==='inner-session'?23:sessionId==='outer-session'?37:171);assert.equal(params.y,sessionId==='inner-session'?103:sessionId==='outer-session'?153:886);}
   if(sessionId==='inner-session')return {backendNodeId:80};
   if(sessionId==='outer-session')return {frameId:'outer',backendNodeId:mode==='middle-overlay'?99:30};
   return {frameId:'main',backendNodeId:mode==='outer-overlay'?99:20};
  }
  assert.equal(method,'Input.dispatchMouseEvent');assert.equal(sessionId,undefined);
  if(mode==='unknown-input')throw Error('Unknown dispatch');return {};
 };
 const run=()=>tab.pointerClickRemoteFrame(inner,80);
 if(['success','scrolled'].includes(mode))await run();else await assert.rejects(run);
 const inputs=trace.filter(c=>c.method==='Input.dispatchMouseEvent');
 assert.equal(inputs.length,['success','scrolled'].includes(mode)?2:mode==='unknown-input'?1:0);
 if(mode==='success')assert(inputs.every(c=>c.params.x===160&&c.params.y===160),'Two ancestor transforms compose to top page coordinates');
 assert.equal(trace.filter(c=>c.method==='Runtime.releaseObjectGroup').length,1);
 assert(checks>0);
}
console.log('Nested pointer transform composition, intermediate overlays, movement and no-replay guards passed');
