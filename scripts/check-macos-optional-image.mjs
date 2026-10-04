// Original Mac helper client/backend over a bounded fake daemon; no desktop input.
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const cache=process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache');await fs.mkdir(cache,{recursive:true});
const dir=await fs.mkdtemp(path.join(cache,'cu-optional-image-'));
const socketPath=path.join(dir,'bridge.sock');const connections=new Set();const requests=[];
const prior=process.env.PI_CU_SOCKET_PATH;process.env.PI_CU_SOCKET_PATH=socketPath;
const root={kind:'window',rootRef:'optional-image-root',windowId:71,pid:100071,appName:'Optional image fixture',title:'Owned optional image fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=';
let failure=null,completion='completed',capable=true,sequence=0,inputRequests=0;
const server=net.createServer(socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket));let buffer='';socket.on('data',chunk=>{
 buffer+=chunk;const newline=buffer.indexOf('\n');if(newline<0)return;const r=JSON.parse(buffer.slice(0,newline));requests.push(r);let result;let error;
 if(r.cmd==='diagnostics')result={protocolVersion:6,pid:100071,optionalImageFailure:capable};
 else if(r.cmd==='listApps')result=[{appName:root.appName,pid:root.pid}];
 else if(r.cmd==='listRoots')result=[root];
 else if(r.cmd==='getFrontmost')result={appName:root.appName,pid:root.pid,windowId:root.windowId,rootRef:root.rootRef};
 else if(r.cmd==='look') {
  const image=r.includeImage!==false;
  if(image&&failure&&(!r.allowImageFailure||failure==='window_not_found'))error={code:failure,message:'Controlled exact-root failure'};
  else result={lookId:'optional-image-'+(++sequence),capturedAt:Date.now(),window:{windowId:root.windowId,rootRef:root.rootRef,framePoints:root.framePoints,scaleFactor:1,isModal:false},
   outline:{ref:'native-window',role:'AXWindow',title:root.title,children:[{ref:'native-field',role:'AXTextField',title:'Owned field',value:'Fresh native text',canSetValue:true,children:[]}]},
   image:image&&!failure?{jpegBase64:png,mimeType:'image/png',width:1,height:1}:undefined,
   imageError:image&&failure?'x'.repeat(3000):undefined,
   imageDiagnostics:image&&failure?{code:failure,nativeCompletion:completion,readOnly:true}:undefined,timings:{describeMs:3}};
 } else if(r.cmd==='act'||r.cmd==='actBatch'){inputRequests++;error={code:'input_forbidden',message:'Read-only fixture'};}
 else error={code:'unsupported_fixture_command',message:r.cmd};
 socket.end(JSON.stringify(error?{id:r.id,ok:false,error}:{id:r.id,ok:true,result})+'\n');
});});
let backend,original,shutdown;
try {
 await new Promise(resolve=>server.listen(socketPath,resolve));
 const {macosHelper}=await import('../src/platform/macos/helper.ts');
 const {macosBackend}=await import('../src/platform/macos/backend.ts');
 const {currentPlatformBackend}=await import('../src/platform/index.ts');
 const {executeFind,executeObserve,executeSearchUi,executeAct,shutdownComputerUseSession}=await import('../src/bridge.ts');
 shutdown=shutdownComputerUseSession;backend=currentPlatformBackend;original={...backend};
 Object.assign(backend,macosBackend,{name:'macos',ensureReady:async()=>({lastPermissionCheckAt:Date.now(),helperDiagnostics:await macosHelper.diagnosticsCommand()}),isBrowserApp:()=>false,isChromeFamilyApp:()=>false,shutdown:async()=>{}});
 const call=(fn,p)=>fn('optional-image-test',p,undefined,undefined,{cwd:process.cwd(),hasUI:false});
 let roots=await call(executeFind,{text:root.title});let ref=roots.details.windows[0].windowRef;
 const before=requests.length;const good=await call(executeObserve,{root:ref,mode:'visual'});
 assert.equal(requests.slice(before).filter(x=>x.cmd==='look').length,1,'Capable Mac helper performs one native look');
 assert.equal(good.content.filter(x=>x.type==='image').length,1);
 const foundField=await call(executeSearchUi,{stateId:good.details.capture.stateId,text:'Owned field'});assert.equal(foundField.details.matches.length,1);
 for(const expected of ['completed','unconfirmed','invalid-status']) {
  failure='capture_timeout';completion=expected;const count=requests.filter(x=>x.cmd==='look').length;
  const result=await call(executeObserve,{root:ref,mode:'visual'});
  assert.equal(requests.filter(x=>x.cmd==='look').length,count+1,'Optional failure cannot recapture');
  const wire=requests.filter(x=>x.cmd==='look').at(-1);assert.equal(wire.allowImageFailure,true);
  assert.equal(result.details.observation.status,'semantic_only');assert.equal(result.details.observation.imageError.length,1024);
  assert.equal(result.details.observation.nativeCompletion,expected==='completed'?'completed':'unconfirmed');
  assert.equal(result.details.observationTimings.semanticObservationMs,0);assert(result.details.outline.root);
  assert(JSON.stringify(result.details.outline).includes('Fresh native text'));assert(!result.content.some(x=>x.type==='image'));
  await assert.rejects(()=>call(executeAct,{stateId:result.details.capture.stateId,actions:[{action:'setText',ref:'@e999999',text:'Must not dispatch'}]}));assert.equal(inputRequests,0);
 }
 failure='window_not_found';let count=requests.filter(x=>x.cmd==='look').length;
 await assert.rejects(()=>call(executeObserve,{root:ref,mode:'visual'}),/exact-root failure/);assert.equal(requests.filter(x=>x.cmd==='look').length,count+1);
 failure='capture_failed';count=requests.filter(x=>x.cmd==='look').length;
 await assert.rejects(()=>macosBackend.observe({target:{windowId:71,rootRef:root.rootRef},readText:'never',includeImage:true,allowImageFailure:false}),/exact-root failure/);
 assert.equal(requests.filter(x=>x.cmd==='look').length,count+1);assert.equal(inputRequests,0);
 // Older helper diagnostics retain the semantic-first compatibility path.
 await shutdown();capable=false;failure=null;roots=await call(executeFind,{text:root.title});ref=roots.details.windows[0].windowRef;count=requests.filter(x=>x.cmd==='look').length;
 await call(executeObserve,{root:ref,mode:'visual'});assert.equal(requests.filter(x=>x.cmd==='look').length,count+2);
 console.log('PASS actual Mac helper/backend protocol and public CU executors: one look, semantic fallback, completion truth, no recapture/invalid-reference input, strict root error and legacy compatibility');
} finally {
 if(shutdown)await shutdown();if(backend&&original)Object.assign(backend,original);
 if(prior===undefined)delete process.env.PI_CU_SOCKET_PATH;else process.env.PI_CU_SOCKET_PATH=prior;
 for(const socket of connections)socket.destroy();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});
}
