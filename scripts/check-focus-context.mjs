import assert from 'node:assert/strict';
import {parseFocusContext, serializeFocusContext} from '../src/focus-context.ts';
import {parseLookResponse} from '../src/outline.ts';
import {macosBackend} from '../src/platform/macos/backend.ts';
import {macosHelper} from '../src/platform/macos/helper.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind, executeObserve, executeAct, executeWaitFor, shutdownComputerUseSession} from '../src/bridge.ts';

const raw = {lookId:'owned-look', window:{windowId:10}, outline:{ref:'window', role:'AXWindow', children:[{ref:'body',role:'AXTextArea',description:'Page 1 content',isEnabled:false,canSetValue:true,isTextInput:true}]}, focusContext:{status:'matched',scopeVerified:true,wireRef:'body',isEnabled:false,canSetValue:true,isSecure:false,value:'MUST NOT LEAK',title:'Body'}};
const parsed = parseLookResponse(raw);
const context = serializeFocusContext(parsed.focusContext, parsed.parsedOutline);
assert.equal(context.isEnabled,false);
assert.equal(context.ref,parsed.parsedOutline.nodes.find(n=>n.wireRef==='body').ref);
assert.equal(context.value,undefined); assert.equal(context.wireRef,undefined);
assert.equal(serializeFocusContext({...parsed.focusContext,wireRef:'old-body'},parsed.parsedOutline).ref,undefined);
assert.equal(serializeFocusContext({...parsed.focusContext,wireRef:'old-body'},parsed.parsedOutline).status,'unobserved');
for (const status of ['unobserved','outside_window','unavailable','ambiguous','budget_exceeded']) {
 const c=parseFocusContext({...raw.focusContext,status});
 assert.equal(serializeFocusContext(c,parsed.parsedOutline).ref,undefined);
}
for (const isSecure of [true,undefined]) {
 const c=parseFocusContext({...raw.focusContext,isSecure,description:'SECRET'});
 assert.equal(c.title,undefined); assert.equal(c.description,undefined);
}
assert.equal(parseFocusContext({status:'garbage'}),undefined);
assert.equal(parseFocusContext({...raw.focusContext,isEnabled:'false'}).isEnabled,undefined);
assert.equal(parseFocusContext({...raw.focusContext,scopeVerified:false}).wireRef,undefined);
assert.equal(parseFocusContext({...raw.focusContext,title:'x'.repeat(1000)}).title.length,256);

const helperOriginal=macosHelper.command;
const requests=[];
try {
 macosHelper.command=async(command,params)=>{requests.push({command,params});return raw;};
 await macosBackend.observe({target:{pid:7,windowId:10,windowRef:'exact-native-window'},readText:'never',includeImage:false});
 assert.equal(requests.at(-1).params.focusContext,undefined);
 await macosBackend.observe({target:{pid:7,windowId:10,windowRef:'exact-native-window'},readText:'never',includeImage:false,focusContext:true});
 assert.equal(requests.at(-1).params.focusContext,true);
 assert.equal(requests.at(-1).params.windowRef,'exact-native-window');
 assert.equal(requests.at(-1).command,'look');
 assert.equal(requests.length,2,'No separate private helper command or fallback read');
} finally {macosHelper.command=helperOriginal;}

const root={kind:'window',rootRef:'native-root',windowRef:'native-root',windowId:10,pid:7,appName:'Fixture',title:'Owned fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
let inputs=0, nativeWaits=0;const observes=[];
const overrides={waitFor:async()=>{nativeWaits++;throw Error('Unexpected native wait');},ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:'Fixture',pid:7}],listRoots:async()=>[root],getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:10,rootRef:'native-root'}),observe:async(request)=>{observes.push(request);return parseLookResponse({...raw,focusContext:request.focusContext?raw.focusContext:undefined});},act:async()=>{inputs++;throw Error('Unexpected input');}};
const original=Object.fromEntries(Object.keys(overrides).map(key=>[key,backend[key]])); const originalName=backend.name;
Object.assign(backend,overrides,{name:'macos'});
const call=(fn,params)=>fn('focus-context-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try {
 const found=await call(executeFind,{text:root.title});const ref=found.details.windows[0].windowRef;
 const ordinary=await call(executeObserve,{root:ref,mode:'semantic'});
 assert.equal(observes.at(-1).focusContext,undefined);assert.equal(ordinary.details.focusContext,undefined);
 const diagnosis=await call(executeObserve,{root:ref,mode:'semantic',focusContext:true});
 assert.equal(observes.at(-1).focusContext,true);assert.equal(observes.at(-1).includeImage,false);
 await assert.rejects(call(executeWaitFor,{stateId:diagnosis.details.capture.stateId,text:'Body',includeOutline:false}),/browser root/);
 assert.equal(nativeWaits,0,'Compact browser mode must reject before native dispatch');
 const body=diagnosis.details.outline.root.children[0];
 assert.equal(diagnosis.details.focusContext.ref,body.ref);assert.equal(diagnosis.details.focusContext.isEnabled,false);
 await assert.rejects(call(executeAct,{stateId:diagnosis.details.capture.stateId,actions:[{action:'typeText',ref:body.ref,text:'BLOCKED'}]}),/disabled; input was not sent/);
 assert.equal(inputs,0,'Focused diagnosis must not bypass enabled-state guards');
 const count=observes.length;
 await assert.rejects(call(executeObserve,{root:ref,mode:'semantic',focusContext:'true'}),/boolean/);
 for(const name of ['windows','linux']){
  backend.name=name;
  await assert.rejects(call(executeObserve,{root:ref,mode:'semantic',focusContext:true}),/macOS native root/);
 }
 assert.equal(observes.length,count,'Unsupported/invalid requests fail before any native read');
 console.log('PASS scoped focus-context parsing, current refs, secure redaction, opt-in transport, exact root, disabled zero-input guard and unsupported platforms');
} finally {Object.assign(backend,original,{name:originalName});await shutdownComputerUseSession();}
