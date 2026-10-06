import assert from 'node:assert/strict';
import {executeFind,executeObserve,executeAct,executeInspectUi,executeSearchUi,shutdownComputerUseSession} from '../src/bridge.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {parseLookResponse} from '../src/outline.ts';
const original={...backend};
const makeRoot=(windowId,rootRef,title,extra={})=>({kind:'window',windowId,rootRef,windowRef:rootRef,pid:100029,appName:'Root pin fixture',title,zOrder:5,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:false,isMain:true,isMinimized:false,isModal:false,...extra});
const owned=makeRoot(71,'native-owned','Owned root pin fixture');
const other=makeRoot(72,'native-other','Another document dialog',{kind:'sheet',zOrder:0,isFocused:true,isModal:true});
let roots=[owned,other],inputs=[],looks=0,nodeEnabled, nativeOutcome="worked", nativeError;const lookRoots=new Map();
const node=(ref,role,title,extra={})=>({ref,role,title,subrole:'',identifier:'',description:'',value:'',actions:[],canPress:false,canFocus:false,canSetValue:false,canScroll:false,canIncrement:false,canDecrement:false,isTextInput:false,focused:false,offscreen:false,pictureOnly:false,truncated:false,text:[],children:[],rect:{x:0,y:0,w:20,h:20},...extra});
Object.assign(backend,{
 name:"macos",
 ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),
 listApps:async()=>[{appName:owned.appName,pid:owned.pid,isFrontmost:true}],listRoots:async()=>roots,
 getFrontmost:async()=>({appName:owned.appName,pid:owned.pid,windowId:owned.windowId,rootRef:owned.rootRef}),
 isBrowserApp:()=>false,isChromeFamilyApp:()=>false,actBatch:undefined,
 observe:async request=>{
  const root=roots.find(r=>r.rootRef===request.target.windowRef)??roots.find(r=>r.windowId===request.target.windowId);assert(root,'Observation must address an existing exact root');
  const lookId='root-pin-look-'+(++looks);lookRoots.set(lookId,root);return parseLookResponse({lookId,capturedAt:Date.now(),window:{windowId:root.windowId,rootRef:root.rootRef,framePoints:root.framePoints,scaleFactor:1,isModal:root.isModal,role:root.kind,subrole:''},outline:node(root.rootRef,'window',root.title,{children:[node(root.rootRef+'-button','AXComboBox','Font Size',{isTextInput:true,canFocus:true,canPress:true,actions:['AXConfirm','AXPress'],isEnabled:nodeEnabled})]}),timings:{}});
 },
 act:async request=>{inputs.push(request);if(nativeError)throw nativeError;return {outcome:nativeOutcome,performed:{grounding:'description',delivery:'ax'},evidence:{selectionVerified:nativeOutcome==='worked'}};},shutdown:async()=>{},
});
const call=(fn,params)=>fn('root-pin-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
async function observeOwned(){const found=await call(executeFind,{text:owned.title});const target=found.details.windows.filter(r=>r.windowId===owned.windowId);assert.equal(target.length,1);return await call(executeObserve,{root:target[0].windowRef,mode:'semantic'});}
const button=d=>{const children=d.details.outline.root.children;assert.equal(children.length,1);return children[0].ref;};

import {preflightActionSequence,canRetryInForeground} from '../src/actions.ts';
import computerUseExtension from '../extensions/computer-use.ts';
import {Value} from 'typebox/value';
const value=' 1 First🙂\n 2 中文 Second🙂\n';
const action=ref=>({action:'selectText',ref,text:'中文 Second🙂',expectedValue:value,selectionMode:'end'});
const editor={wireRef:'native-text',isTextInput:true,actions:[],children:[]};
const env={platform:'macos',headless:false,node(ref){if(ref!=='@e1')throw Error('Stale reference');return editor;},center(){throw Error('No pointer');},validatePoint(){throw Error('No pointer');}};
const prepared=preflightActionSequence([action('@e1')],false,env)[0];
assert.deepEqual(prepared.target,{ref:'native-text'});
assert.equal(prepared.establishesFocus,false,'Selection must not authorize later targetless typing');
assert.throws(()=>preflightActionSequence([action('@e1'),{action:'typeText',text:'no target'}],false,env),/requires either ref/);
for(const outcome of ['worked','didnt','unknown'])assert.equal(canRetryInForeground(prepared,outcome,false),false);
for(const platform of ['windows','linux'])assert.throws(()=>preflightActionSequence([action('@e1')],false,{...env,platform}),/macOS/);
assert.throws(()=>preflightActionSequence([action('@e1')],false,{...env,headless:true}),/macOS/);
for(const node of [{...editor,isEnabled:false},{...editor,isTextInput:false},{...editor,pictureOnly:true},{...editor,wireRef:undefined}])assert.throws(()=>preflightActionSequence([action('@e1')],false,{...env,node(){return node;}}),/disabled|native text editor/);
for(const bad of [{text:''},{text:'absent'},{expectedValue:'aaa',text:'aa'},{expectedValue:undefined},{selectionMode:'bad'},{x:1,y:2},{ref:'@missing'}])assert.throws(()=>preflightActionSequence([{...action('@e1'),...bad}],false,env));
const tools=new Map();computerUseExtension({registerTool(t){tools.set(t.name,t);},registerCommand(){},on(){}});
assert(Value.Check(tools.get('act_ui').parameters,{stateId:'S1',actions:[action('@e1')]}));
assert(!Value.Check(tools.get('act_ui').parameters,{stateId:'S1',actions:[{...action('@e1'),x:1,y:2}]}));
try {
 roots=[owned];inputs=[];
 let observed=await observeOwned();
 let result=await call(executeAct,{stateId:observed.details.capture.stateId,actions:[action(button(observed))],observationMode:'semantic'});
 assert.equal(inputs.length,1);assert.equal(inputs[0].action,'selectText');
 assert.equal(lookRoots.get(inputs[0].lookId).windowId,71);assert.equal(inputs[0].target.ref,owned.rootRef+'-button');
 assert.equal(inputs[0].params.expectedValue,value);assert.equal(inputs[0].params.selectionMode,'end');
 assert.equal(result.details.execution.outcome,'worked');
 roots=[owned];inputs=[];nativeOutcome='unknown';observed=await observeOwned();
 result=await call(executeAct,{stateId:observed.details.capture.stateId,actions:[action(button(observed)),{action:'typeText',ref:button(observed),text:'must not be sent'}]});
 assert.equal(inputs.length,1,'Unverified selection stops later typing with no fallback/replay');
 assert.equal(result.details.execution.outcome,'unknown');
 roots=[owned];inputs=[];observed=await observeOwned();nativeError=Object.assign(new Error('foreground request forbidden'),{code:'foreground_required'});
 await assert.rejects(()=>call(executeAct,{stateId:observed.details.capture.stateId,actions:[action(button(observed))]}),/foreground request forbidden/);assert.equal(inputs.length,1,'Native selection must not retry a foreground request');nativeError=undefined;
 for(const changed of [{...owned,windowId:73},{...owned,rootRef:'replacement',windowRef:'replacement'}]){
  roots=[owned];inputs=[];observed=await observeOwned();roots=[changed];
  await assert.rejects(()=>call(executeAct,{stateId:observed.details.capture.stateId,actions:[action(button(observed))]}));assert.equal(inputs.length,0);
 }
 roots=[owned];inputs=[];observed=await observeOwned();
 await assert.rejects(()=>call(executeAct,{stateId:observed.details.capture.stateId,actions:[action(button(observed)),action('@e999999')]}));assert.equal(inputs.length,0,'Whole batch rejects stale later ref before any dispatch');
 nodeEnabled=false;observed=await observeOwned();
 await assert.rejects(()=>call(executeAct,{stateId:observed.details.capture.stateId,actions:[action(button(observed))]}),/disabled/);assert.equal(inputs.length,0);
 console.log('PASS public native selection routing, exact roots, stale/disabled guards and unknown stops typing (mocked backend)');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
