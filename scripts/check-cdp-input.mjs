import assert from 'node:assert/strict';
import { CdpTab,validateCdpKeypressKeys,mapRemoteFramePoint } from '../src/cdp.ts';

const tab = Object.create(CdpTab.prototype), events = [];
tab.send = async (method, params) => { events.push({method, params});return {}; };
await tab.keypress(['Enter']);
assert.deepEqual(events.map(e=>e.params.type), ['keyDown','keyUp']);
assert.equal(events[0].params.windowsVirtualKeyCode,13);
assert.equal(events[0].params.text,'\r');
assert.equal(events[1].params.text,undefined);
assert.equal(events[0].params.nativeVirtualKeyCode,undefined,'must not assume native platform key codes');
events.length=0;
await tab.keypress(['CTRL','a']);
assert.equal(events.length,2,'modifiers must not become text keys');
assert.equal(events[0].params.code,'KeyA');
assert.equal(events[0].params.windowsVirtualKeyCode,65);
assert.equal(events[0].params.modifiers,2);
assert.equal(events[0].params.text,undefined);

events.length=0;
await tab.keypress(['Shift','a']);
assert.equal(events[0].params.key,'A');
assert.equal(events[0].params.text,'A','shift alone must still insert printable text');
assert.equal(events[0].params.modifiers,8);
events.length=0;
await tab.keypress(['Shift','ArrowLeft']);
assert.equal(events[0].params.text,undefined,'navigation must not insert text');
events.length=0;
await tab.keypress(['CTRL','Shift','a']);
assert.equal(events[0].params.text,undefined,'shortcut modifiers must suppress text');

for(const invalid of [[],['ctrl'],['no-such-key'],[3]]){
 assert.throws(()=>validateCdpKeypressKeys(invalid));
 events.length=0;await assert.rejects(()=>tab.keypress(invalid));assert.equal(events.length,0,'invalid keys must send no Input event');
}

const scoped=Object.create(CdpTab.prototype), scopedEvents=[];
const document={activeElement:{label:'other'}};
let stealFocus=false;
const target={ownerDocument:document,scrollIntoView(){},getRootNode(){return document;},
  focus(){document.activeElement=stealFocus?{label:'focus thief'}:this;}};
scoped.send=async(method,params)=>{
  if(method==='DOM.resolveNode'){
    assert.equal(params.backendNodeId,17);return {object:{objectId:'exact-target'}};
  }
  if(method==='Runtime.callFunctionOn'){
    assert.equal(params.objectId,'exact-target');
    try{new Function('return ('+params.functionDeclaration+')')().call(target);return {};}
    catch(error){return {exceptionDetails:{text:error.message}};}
  }
  if(method==='Runtime.releaseObject'){assert.equal(params.objectId,'exact-target');return {};}
  assert.equal(method,'Input.dispatchKeyEvent');
  assert.equal(document.activeElement,target,'keys must reach the exact referenced element');
  scopedEvents.push(params);return {};
};
await scoped.keypress(['Enter'],17);
assert.equal(scopedEvents.length,2);
scopedEvents.length=0;stealFocus=true;
await assert.rejects(()=>scoped.keypress(['Enter'],17),/Exact keyboard target did not acquire focus/);
assert.equal(scopedEvents.length,0,'failed focus must send no keydown or keyup');

let value='old', tracked='old', applicationValue='old';
class ControlledInput {
  get value(){return value;}
  set value(next){value=next;}
  scrollIntoView(){}
  focus(){this.focused=true;}
  dispatchEvent(event){if(event.type==='input'&&value!==tracked){applicationValue=value;tracked=value;}}
}
const input=new ControlledInput();
const inputDocument={activeElement:null,hasFocus:()=>true};
input.isConnected=true;input.ownerDocument=inputDocument;
input.getRootNode=()=>inputDocument;
input.focus=function(){this.focused=true;inputDocument.activeElement=this;};
tab.send=async(method,params)=>{
  assert.equal(method,'Input.insertText');
  assert.equal(inputDocument.activeElement,input);
  // Retain the framework tracker until the browser input event.
  Object.getOwnPropertyDescriptor(ControlledInput.prototype,'value').set.call(input,value+params.text);
  input.dispatchEvent(new Event('input'));return {};
};

// Framework value tracking lives on the instance. Direct assignment changes
// both DOM and tracking, making a subsequent input event appear unchanged.
Object.defineProperty(input,'value',{get:()=>value,set:next=>{value=next;tracked=next;}});
tab.withBackendNode=async (id,fn,args)=>{
  assert.equal(id,99);
  class InputEvent {constructor(type,options){this.type=type;Object.assign(this,options);}}
  const run=new Function('InputEvent','Event','return ('+fn+')')(InputEvent,Event);
  run.apply(input,args);
};
await tab.typeIntoBackendNode(99,'中文🙂',true);
assert.equal(applicationValue,'中文🙂','controlled application state must observe replacement');
assert.equal(input.focused,true);
await tab.typeIntoBackendNode(99,' appended',false);
assert.equal(applicationValue,'中文🙂 appended','append must preserve prior value');
const beforeReadonly={value,applicationValue,tracked};
input.readOnly=true;
await assert.rejects(()=>tab.typeIntoBackendNode(99,'unwanted',true),/not editable/);
assert.deepEqual({value,applicationValue,tracked},beforeReadonly);
input.readOnly=false;input.matches=selector=>selector===':disabled';
await assert.rejects(()=>tab.typeIntoBackendNode(99,'unwanted',true),/not editable/);
assert.deepEqual({value,applicationValue,tracked},beforeReadonly);
input.matches=()=>false;
Object.setPrototypeOf(input,Object.create(ControlledInput.prototype));
await tab.typeIntoBackendNode(99,'inherited-中🙂',true);
assert.equal(applicationValue,'inherited-中🙂','inherited native setter must update framework application state');
await tab.typeIntoBackendNode(99,'-append',false);
assert.equal(applicationValue,'inherited-中🙂-append');
console.log('CDP keyboard and controlled-input behavior checks passed');

for (const mode of ['background-success','ancestor-focus-theft','owner-replaced','detached-leaf','write-unknown']) {
  const probe=Object.create(CdpTab.prototype), sent=[];
  const parent={activeElement:null}, child={activeElement:null,hasFocus:()=>false};
  const owner={isConnected:true,ownerDocument:parent,getRootNode:()=>parent};
  parent.activeElement=owner;
  const leaf={isConnected:true,value:'',ownerDocument:child,getRootNode:()=>child,
    scrollIntoView(){},focus(){child.activeElement=this;}};
  probe.withBackendNode=async(id,declaration,args=[])=>{
    if(id===84&&mode==='ancestor-focus-theft')parent.activeElement={};
    if(id===73&&mode==='detached-leaf')leaf.isConnected=false;
    new Function('return ('+declaration+')')().apply(id===84?owner:leaf,args);
  };
  probe.send=async(method,params)=>{
    if(method==='DOM.describeNode')return {node:{nodeName:'IFRAME',frameId:mode==='owner-replaced'?'replacement':'owned-local-frame'}};
    assert.equal(method,'Input.insertText');assert.equal(child.activeElement,leaf);
    assert.equal(parent.activeElement,owner);sent.push(params);
    if(mode==='write-unknown')throw Error('unknown text write');
    return {};
  };
  const operation=()=>probe.typeIntoBackendNode(73,'中文🙂',false,[{backendNodeId:84,frameId:'owned-local-frame'}]);
  if(mode==='background-success')await operation();else await assert.rejects(operation);
  assert.equal(sent.length,['background-success','write-unknown'].includes(mode)?1:0);
}

// Execute the actual generated focus checks. No input may follow a focus
// theft, detached/non-editable target, stale owner route or unknown write.
for (const mode of ['success','focus-theft','detached','readonly','owner-stale','write-unknown']) {
  const probe=Object.create(CdpTab.prototype), inputs=[], checks=[];
  const doc={activeElement:null,hasFocus:()=>true};
  const node={isConnected:true,value:'',ownerDocument:doc,getRootNode:()=>doc,
    scrollIntoView(){},focus(){doc.activeElement=this;}};
  let ownerChecks=0;
  probe.withRemoteFrameDocument=async(route,action)=>{
    assert.equal(route.frameId,'owned-frame');
    return action('owned-session',async()=>{},undefined,async()=>{
      ownerChecks++;
      if(mode==='owner-stale')throw Error('owner route changed');
    });
  };
  probe.withBackendNode=async(id,declaration,args,session)=>{
    assert.equal(id,73);assert.equal(session,'owned-session');
    checks.push(args[0]);
    if(checks.length===2&&mode==='focus-theft')doc.activeElement={};
    if(mode==='detached')node.isConnected=false;
    if(mode==='readonly')node.readOnly=true;
    new Function('return ('+declaration+')')().apply(node,args);
  };
  probe.send=async(method,params,timeout,session)=>{
    assert.equal(method,'Input.insertText');assert.equal(session,'owned-session');
    assert.equal(doc.activeElement,node);assert.equal(params.text,'中文🙂');
    inputs.push(params);
    if(mode==='write-unknown')throw Error('unknown write');
    return {};
  };
  const operation=()=>probe.typeIntoRemoteBackendNode({frameId:'owned-frame'},73,'中文🙂',false);
  if(mode==='success')await operation();else await assert.rejects(operation);
  assert.equal(inputs.length,['success','write-unknown'].includes(mode)?1:0);
  if(mode==='success'){assert.deepEqual(checks,[true,false]);assert.equal(ownerChecks,1);}
}

// Remote handles must be released after both successful and failed operations.
for (const mode of ['success', 'page-error', 'transport-error', 'cleanup-error', 'unresolved']) {
  const probe = Object.create(CdpTab.prototype), calls = [];
  probe.send = async (method, params, timeout) => {
    calls.push({method, params, timeout});
    if (method === 'DOM.resolveNode') return mode === 'unresolved' ? {} : {object:{objectId:'owned-handle'}};
    if (method === 'Runtime.callFunctionOn') {
      assert.equal(params.returnByValue,true);
      if (mode === 'transport-error') throw new Error('unknown dispatch outcome');
      return mode === 'page-error' ? {exceptionDetails:{text:'original page failure'}} : {};
    }
    assert.equal(method,'Runtime.releaseObject');
    assert.deepEqual(params,{objectId:'owned-handle'});
    assert.equal(timeout,1000);
    if (mode === 'cleanup-error') throw new Error('context disappeared');
    return {};
  };
  if (mode === 'page-error') await assert.rejects(()=>probe.clickBackendNode(17),/original page failure/);
  else if (mode === 'transport-error') await assert.rejects(()=>probe.clickBackendNode(17),/unknown dispatch outcome/);
  else if (mode === 'unresolved') await assert.rejects(()=>probe.clickBackendNode(17),/could not resolve/);
  else await probe.clickBackendNode(17);
  assert.equal(calls.filter(c=>c.method==='Runtime.callFunctionOn').length,mode==='unresolved'?0:1,'never replay an operation');
  assert.equal(calls.filter(c=>c.method==='Runtime.releaseObject').length,mode==='unresolved'?0:1);
}
console.log('CDP remote-object cleanup checks passed');

for (const mode of ['left','right-double','shadow-child','occluded','moving','disabled','detached','offscreen','unknown-input','cleanup-error','first-click-detaches','scrolled','viewport-moves']) {
 const pointer=Object.create(CdpTab.prototype), trace=[];
 const element={isConnected:mode!=='detached',disabled:mode==='disabled',scrollIntoView(){},matches(){return false;},getAttribute(){return null;}};
 let hit=mode==='occluded'?{}:mode==='shadow-child'?{parentNode:{host:element}}:element;
 let geometryReads=0, layoutReads=0;
 const quad=mode==='offscreen'?[2000,2000,2100,2000,2100,2100,2000,2100]:[20,20,120,20,120,80,20,80];
 pointer.send=async(method,params)=>{
  trace.push({method,params});
  if(method==='DOM.resolveNode')return {object:{objectId:params.backendNodeId===17?'target':'hit'}};
  if(method==='Runtime.callFunctionOn'){
   try{
    const fn=new Function('return ('+params.functionDeclaration+')')();
    return {result:{value:fn.call(element,...(params.arguments?.[0]?.objectId?[hit]:[]))}};
   }catch(error){return {exceptionDetails:{text:error.message}};}
  }
  if(method==='Runtime.releaseObject')return {};
  if(method==='Runtime.releaseObjectGroup'){
   if(mode==='cleanup-error')throw Error('context destroyed');return {};
  }
  if(method==='Page.getLayoutMetrics'){layoutReads++;return {cssLayoutViewport:{clientWidth:800,clientHeight:600,pageX:mode==='scrolled'?31:0,pageY:mode==='scrolled'?726:mode==='viewport-moves'&&layoutReads>1?1:0}};}
  if(method==='DOM.getContentQuads'){
   geometryReads++;
   return {quads:[mode==='moving'&&geometryReads===2?quad.map(x=>x+1):quad]};
  }
  if(method==='DOM.getNodeForLocation'){
   assert.equal(params.ignorePointerEventsNone,false);assert.equal(params.x,mode==='scrolled'?101:70);assert.equal(params.y,mode==='scrolled'?776:50);return {backendNodeId:18};
  }
  assert.equal(method,'Input.dispatchMouseEvent');
  if(mode==='unknown-input')throw Error('unknown dispatch');
  if(mode==='first-click-detaches'&&params.type==='mouseReleased'){element.isConnected=false;hit={};}
  return {};
 };
 const good=['left','right-double','shadow-child','cleanup-error','scrolled'].includes(mode);
 const operation=()=>pointer.pointerClickBackendNode(17,mode==='right-double'?'right':'left',['right-double','first-click-detaches'].includes(mode)?2:1);
 if(good)await operation();else await assert.rejects(operation);
 const input=trace.filter(x=>x.method==='Input.dispatchMouseEvent');
 assert.equal(input.length,good?(mode==='right-double'?4:2):mode==='unknown-input'?1:mode==='first-click-detaches'?2:0,mode+' must not misdirect or replay input');
 if(mode==='right-double'){
  assert.deepEqual(input.map(x=>x.params.clickCount),[1,1,2,2]);
  assert(input.every(x=>x.params.button==='right'));
 }
 if(good)assert(input.every(x=>x.params.x===70&&x.params.y===50));
 if(!['disabled','detached'].includes(mode))assert.equal(trace.filter(x=>x.method==='Runtime.releaseObjectGroup').length,1);
}
console.log('CDP exact pointer input and failure guards passed');

// Page evaluation exceptions must not look like successful undefined results.
const evaluation=Object.create(CdpTab.prototype);
evaluation.send=async()=>({exceptionDetails:{exception:{description:'SyntaxError: fixture failed'}}});
await assert.rejects(()=>evaluation.evaluate('invalid'),/CDP evaluation failed: SyntaxError/);
evaluation.send=async()=>({exceptionDetails:{text:'Rejected page promise'}});
await assert.rejects(()=>evaluation.evaluate('rejected'),/Rejected page promise/);
evaluation.send=async()=>({result:{value:0}});
assert.equal(await evaluation.evaluate('0'),0);
evaluation.send=async()=>({result:{type:'undefined'}});
assert.equal(await evaluation.evaluate('undefined'),undefined);
console.log('CDP evaluation error reporting checks passed');

// Remote frame coordinates belong to a separate viewport and document session.
assert.deepEqual(mapRemoteFramePoint([218,260,718,260,718,360,218,360],500,100,71,19),{x:289,y:279});
assert.deepEqual(mapRemoteFramePoint([10,20,210,20,210,220,10,220],100,100,50,50),{x:110,y:120});
assert.deepEqual(mapRemoteFramePoint([100,0,100,100,0,100,0,0],100,100,25,50),{x:50,y:25});
const perspective=mapRemoteFramePoint([0,0,100,0,80,100,20,100],100,100,50,50);
assert(Math.abs(perspective.x-50)<1e-9);assert(Math.abs(perspective.y-62.5)<1e-9);
for(const quad of [[0,0,0,0,0,0,0,0],[0,0,100,100,0,100,100,0],[NaN,0,1,0,1,1,0,1]])assert.throws(()=>mapRemoteFramePoint(quad,100,100,50,50));
assert.throws(()=>mapRemoteFramePoint([0,0,100,0,100,100,0,100],100,100,100,50));
for(const mode of ['success','outer-overlay','inner-overlay','loader-change','owner-change','frame-moves','target-moves','disabled','unknown-input','first-click-navigates','scrolled','outer-offscreen']){
 const remote=Object.create(CdpTab.prototype),trace=[];
 remote.targetId='root-target';let loader='loader',frameReads=0,ownerReads=0,boxReads=0,quadReads=0;
 const element={isConnected:true,disabled:mode==='disabled',matches(){return false;},getAttribute(){return null;},scrollIntoView(){}};
 remote.send=async(method,params,timeout,session)=>{
  trace.push({method,params,session});
  if(method==='DOM.describeNode'){ownerReads++;return {node:{nodeName:'IFRAME',frameId:mode==='owner-change'&&ownerReads>1?'other':'child'}};}
  if(method==='Target.getTargetInfo')return {targetInfo:{type:'iframe',targetId:'child',parentFrameId:'parent',parentId:'root-target'}};
  if(method==='Target.attachToTarget'){assert.equal(params.flatten,true);return {sessionId:'child-session'};}
  if(method==='Target.detachFromTarget'){assert.equal(params.sessionId,'child-session');return {};}
  if(method==='Page.getFrameTree'){assert.equal(session,'child-session');frameReads++;return {frameTree:{frame:{id:'child',loaderId:mode==='loader-change'&&frameReads>1?'new':loader}}};}
  if(method==='DOM.resolveNode')return {object:{objectId:params.backendNodeId===5?'target':'hit'}};
  if(method==='Runtime.callFunctionOn'){
   try{const fn=new Function('return ('+params.functionDeclaration+')')();return {result:{value:fn.call(element,...(params.arguments?.[0]?.objectId?[mode==='inner-overlay'?{}:element]:[]))}};}catch(error){return {exceptionDetails:{text:error.message}};}
  }
  if(method==='Runtime.releaseObject'||method==='Runtime.releaseObjectGroup')return {};
  if(method==='Runtime.evaluate'){assert.equal(session,'child-session');return {result:{value:{width:500,height:100}}};}
  if(method==='DOM.getBoxModel'){boxReads++;return {model:{content:[218,260,718,260,718,360,218,360].map(v=>v+(mode==='frame-moves'&&boxReads>1?1:mode==='outer-offscreen'?-500:0))}};}
  if(method==='DOM.getContentQuads'){assert.equal(session,'child-session');quadReads++;return {quads:[[8,8,134,8,134,30,8,30].map(v=>v+(mode==='target-moves'&&quadReads>1?1:0))]};}
  if(method==='Page.getLayoutMetrics')return {cssLayoutViewport:{pageX:mode==='scrolled'?session?11:31:0,pageY:mode==='scrolled'?session?83:726:0,clientWidth:800,clientHeight:600}};
  if(method==='DOM.getNodeForLocation'){assert.equal(params.x,session?mode==='scrolled'?82:71:mode==='scrolled'?320:289);assert.equal(params.y,session?mode==='scrolled'?102:19:mode==='scrolled'?1005:279);return session?{backendNodeId:6}:{backendNodeId:mode==='outer-overlay'?99:44,frameId:'parent'};}
  assert.equal(method,'Input.dispatchMouseEvent');assert.equal(session,undefined,'trusted pointer is dispatched through root compositor');
  if(mode==='unknown-input')throw Error('unknown dispatch outcome');
  if(mode==='first-click-navigates'&&params.type==='mouseReleased')loader='new';
  return {};
 };
 const operation=()=>remote.pointerClickRemoteFrame({ownerBackendNodeId:44,frameId:'child',loaderId:'loader',parentFrameId:'parent'},5,'left',mode==='first-click-navigates'?2:1);
 if(['success','scrolled'].includes(mode))await operation();else await assert.rejects(operation);
 const input=trace.filter(c=>c.method==='Input.dispatchMouseEvent');
 assert.equal(input.length,['success','scrolled'].includes(mode)?2:mode==='unknown-input'?1:mode==='first-click-navigates'?2:0,mode+' must not misdirect or replay input');
 if(mode==='success')assert(input.every(c=>c.params.x===289&&c.params.y===279));
 assert.equal(trace.filter(c=>c.method==='Target.detachFromTarget').length,1);
}
console.log('Cross-process pointer projection, ownership, loader and failure guards passed');

for(const mode of ['success','loader-change','owner-change','child-focus-stolen','parent-focus-stolen','unknown-key','second-key-navigates']){
 const remote=Object.create(CdpTab.prototype), trace=[];remote.targetId='root';let loader='loader',reads=0;
 const child={isConnected:true,disabled:false,matches(){return false;},scrollIntoView(){},focus(){},getRootNode(){return {activeElement:mode==='child-focus-stolen'?{}:this};},ownerDocument:{}};
 const parent={isConnected:true,getRootNode(){return {activeElement:mode==='parent-focus-stolen'?{}:this};},ownerDocument:{}};
 remote.send=async(method,params,timeout,session)=>{
  trace.push({method,params,session});
  if(method==='DOM.describeNode')return {node:{nodeName:'IFRAME',frameId:mode==='owner-change'?'other':'child'}};
  if(method==='Target.getTargetInfo')return {targetInfo:{type:'iframe',targetId:'child',parentFrameId:'parent',parentId:'root'}};
  if(method==='Target.attachToTarget')return {sessionId:'child-session'};
  if(method==='Target.detachFromTarget'||method==='Runtime.releaseObject')return {};
  if(method==='Page.getFrameTree'){reads++;return {frameTree:{frame:{id:'child',loaderId:mode==='loader-change'&&reads>1?'new':loader}}};}
  if(method==='DOM.resolveNode')return {object:{objectId:session?'child':'parent'}};
  if(method==='Runtime.callFunctionOn'){try{return {result:{value:new Function('return ('+params.functionDeclaration+')')().call(session?child:parent)}};}catch(error){return {exceptionDetails:{text:error.message}};}}
  assert.equal(method,'Input.dispatchKeyEvent');assert.equal(session,'child-session');
  if(mode==='unknown-key')throw Error('unknown key dispatch');
  if(mode==='second-key-navigates'&&params.type==='keyUp')loader='new';return {};
 };
 const operation=()=>remote.keypressRemoteBackendNode({ownerBackendNodeId:44,frameId:'child',loaderId:'loader',parentFrameId:'parent'},5,['Enter','Enter']);
 if(['success','scrolled'].includes(mode))await operation();else await assert.rejects(operation);
 assert.equal(trace.filter(c=>c.method==='Input.dispatchKeyEvent').length,mode==='success'?4:mode==='unknown-key'?1:mode==='second-key-navigates'?2:0,mode+' must not misdirect or replay keyboard input');
 assert.equal(trace.filter(c=>c.method==='Target.detachFromTarget').length,mode==='owner-change'?0:1);
}
console.log('Remote keyboard document, focus, session and no-replay guards passed');

for(const mode of ['container','viewport','detached','loader-change','nonfinite']){
 const remote=Object.create(CdpTab.prototype);let verified=0,attached=0;const calls=[];
 remote.withRemoteFrameDocument=async(route,fn)=>{attached++;return fn('child-session',async()=>{verified++;if(mode==='loader-change')throw Error('Document changed');});};
 const win={getComputedStyle(){return {overflowY:'auto',overflowX:'auto'};},scrollBy(params){calls.push({kind:'viewport',params});}};
 const container={scrollHeight:1000,clientHeight:100,scrollWidth:100,clientWidth:100,parentElement:null,scrollBy(params){calls.push({kind:'container',params});}};
 const anchor={isConnected:mode!=='detached',ownerDocument:{defaultView:win},parentElement:mode==='container'?container:null,getRootNode(){return {};}};
 remote.withBackendNode=async(id,fn,args,session)=>{assert.equal(id,5);assert.equal(session,'child-session');new Function('return ('+fn+')')().apply(anchor,args);};
 const operation=()=>remote.scrollRemoteBackendNode({},5,0,mode==='nonfinite'?Infinity:120);
 if(['container','viewport'].includes(mode)){await operation();assert.deepEqual(calls,[{kind:mode,params:{left:0,top:120,behavior:'instant'}}]);}else{await assert.rejects(operation);assert.equal(calls.length,0);}
 assert.equal(attached,mode==='nonfinite'?0:1);
}
console.log('Remote scroll anchor, document and container ownership checks passed');
