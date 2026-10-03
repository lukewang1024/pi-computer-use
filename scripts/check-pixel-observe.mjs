// Controlled backend contract tests; no real HWND, capture, or physical input.
import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {executeFind,executeObserve,executeSearchUi,executeAct,shutdownComputerUseSession} from '../src/bridge.ts';
import {currentPlatformBackend} from '../src/platform/index.ts';
const original={...currentPlatformBackend};
const root={kind:'window',rootRef:'pixel-root',windowId:71,pid:100071,appName:'Pixel fixture',title:'Owned pixel fixture',zOrder:0,framePoints:{x:0,y:0,w:1,h:1},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
const node=(ref,role,title,extra={})=>({ref,role,title,subrole:'',identifier:'',description:'',value:'',actions:[],canPress:false,canFocus:false,canSetValue:false,canScroll:false,canIncrement:false,canDecrement:false,isTextInput:false,focused:false,offscreen:false,pictureOnly:false,truncated:false,text:[],children:[],rect:{x:0,y:0,w:1,h:1},...extra});
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l0AAAAASUVORK5CYII=';
let looks=0,requests=[],acts=0,ack=true,image=true;
Object.assign(currentPlatformBackend,{name:'windows',
 ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:root.appName,pid:root.pid,isFrontmost:true}],listRoots:async()=>[root],
 getFrontmost:async()=>({appName:root.appName,pid:root.pid,windowTitle:root.title,windowId:root.windowId,rootRef:root.rootRef}),
 isBrowserApp:()=>false,isChromeFamilyApp:()=>false,
 observe:async(request)=>{requests.push(request);const pixels=request.includeElements===false;return parseLookResponse({lookId:'pixel-look-'+(++looks),window:{windowId:root.windowId,rootRef:root.rootRef,framePoints:root.framePoints,scaleFactor:1,role:'window'},outline:node('@w1','window',root.title,{truncated:pixels,pictureOnly:pixels,children:pixels?[]:[node('native-save','button','Save',{canPress:true})]}),image:request.includeImage!==false&&image?{jpegBase64:png,mimeType:'image/png',width:1,height:1}:undefined,uiaDiagnostics:pixels&&ack?{status:'skipped',reason:'pixel_only_observation'}:undefined,timings:{totalMs:1}});},
 act:async()=>{acts++;return {outcome:'unknown',performed:{grounding:'coordinates',delivery:'hid'}};},shutdown:async()=>{},
});
const ctx={cwd:process.cwd()};const call=(fn,params)=>fn('pixels-test',params,undefined,undefined,ctx);
try{
 const found=await call(executeFind,{text:root.title});const ref=found.details.windows[0].windowRef;
 const semantic=await call(executeObserve,{root:ref,mode:'semantic'});
 const search=await call(executeSearchUi,{text:'Save',stateId:semantic.details.capture.stateId});const oldRef=search.details.matches[0].ref;
 requests=[];const pixels=await call(executeObserve,{root:ref,mode:'pixels'});
 assert.equal(requests.length,1,'pixel capture must not do a preliminary semantic read');
 assert.equal(requests[0].includeElements,false);assert.equal(requests[0].includeImage,true);assert.equal(requests[0].allowImageFailure,false);assert.equal(requests[0].readText,'never');
 assert.equal(pixels.details.observation.status,'pixels_only');assert.equal(pixels.details.uiaDiagnostics.status,'skipped');assert.equal(pixels.details.outline.root.children.length,0);assert.equal(pixels.details.outline.root.truncated,true);assert(pixels.content.some(c=>c.type==='image'));
 await assert.rejects(()=>call(executeAct,{stateId:pixels.details.capture.stateId,actions:[{action:'press',ref:oldRef}]}));assert.equal(acts,0,'prior semantic refs cannot be grounded in the pixel-only state');
 requests=[];await assert.rejects(()=>call(executeSearchUi,{text:'Save',stateId:pixels.details.capture.stateId}),/no semantic elements/);assert.equal(requests.length,0);
 await assert.rejects(()=>call(executeAct,{stateId:pixels.details.capture.stateId,actions:[{action:'click',x:0,y:0}],expect:{text:'Save'}}),/semantic postconditions/);assert.equal(acts,0);
 const acted=await call(executeAct,{stateId:pixels.details.capture.stateId,actions:[{action:'click',x:0,y:0}]});assert.equal(acted.details.execution.outcome,'unknown');assert.equal(acted.details.uiaDiagnostics.status,'skipped');assert.equal(requests.length,1);assert.equal(requests[0].includeElements,false);assert.equal(acts,1,'controlled input completion remains unverified; no batch replay');
 requests=[];await assert.rejects(()=>call(executeObserve,{mode:'pixels'}),/exact Windows native/);assert.equal(requests.length,0);
 currentPlatformBackend.name='macos';await assert.rejects(()=>call(executeObserve,{root:ref,mode:'pixels'}),/exact Windows native/);assert.equal(requests.length,0);currentPlatformBackend.name='windows';
 ack=false;await assert.rejects(()=>call(executeObserve,{root:ref,mode:'pixels'}),/did not confirm/);ack=true;
 image=false;await assert.rejects(()=>call(executeObserve,{root:ref,mode:'pixels'}),/did not confirm/);image=true;
 requests=[];const restored=await call(executeObserve,{root:ref,mode:'semantic'});assert.notEqual(requests[0].includeElements,false);assert.equal(restored.details.outline.root.children.length,1);
 console.log('Windows pixel-only contract checks passed (controlled backend; no native performance claim)');
}finally{await shutdownComputerUseSession();Object.assign(currentPlatformBackend,original);}
