import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { executeLaunchBrowser, executeFind, executeNavigateBrowser, executeEvaluateBrowser, executeSearchUi, executeExpandUi,executeInspectUi, executeObserve, executeReadText, executeAct, executeWaitFor, shutdownComputerUseSession } from '../src/bridge.ts';
import { ManagedBrowser } from "../src/managed-browser.ts";
import { BROWSER_PERFORMANCE_SAMPLE } from '../src/browser-performance.ts';
import { currentPlatformBackend } from '../src/platform/index.ts';

// Exercise public tool executors and the real CDP transport. Only native
// readiness/enumeration are stubbed, so this test cannot deliver desktop input.
const original = { ensureReady: currentPlatformBackend.ensureReady, listRoots: currentPlatformBackend.listRoots, getFrontmost: currentPlatformBackend.getFrontmost };
currentPlatformBackend.ensureReady = async () => ({lastPermissionCheckAt: Date.now()});
currentPlatformBackend.listRoots = async () => [];
currentPlatformBackend.getFrontmost = async () => {throw Error("Browser search must not query desktop foreground");};
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l0AAAAASUVORK5CYII=';
let port, present = true, badImage = false, axNodes=[], failPerformance=false, axResponseQueue=[], failAx=false;
let driftPixelIdentity=false,pixelIdentityReads=0;
const calls = [], sockets = new Set();
function frame(value) {
  const data = Buffer.from(JSON.stringify(value));
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
}
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(present ? [{id:'page-'+launchCount,type:'page',title:'Owned page',url:'about:blank',webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/page/page-${launchCount}`}] : []));
});
server.on('connection', socket => {sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer,chunk]);
    while(buffer.length >= 2) {
      const opcode=buffer[0]&15, masked=!!(buffer[1]&128);let size=buffer[1]&127, offset=2;
      if(size===126){if(buffer.length<4)return;size=buffer.readUInt16BE(2);offset=4;}
      if(size===127)throw Error('Unexpected large test request');
      if(buffer.length<offset+(masked?4:0)+size)return;
      const mask=masked?buffer.subarray(offset,offset+4):undefined;offset+=masked?4:0;
      const data=Buffer.from(buffer.subarray(offset,offset+size));buffer=buffer.subarray(offset+size);
      if(mask)for(let i=0;i<data.length;i++)data[i]^=mask[i%4];
      if(opcode===8){socket.end();continue;}if(opcode!==1)continue;
      const request=JSON.parse(data);calls.push(request);
      let result={};
      if(request.method==='Runtime.evaluate'){
        if(request.params.expression===BROWSER_PERFORMANCE_SAMPLE){
          if(failPerformance){socket.write(frame({id:request.id,error:{message:'metrics failed'}}));continue;}
          result={result:{value:{navigation:{timeOriginMs:1},observation:{supported:[],entries:{}},loadWait:{complete:true},documentIdentity:{consistent:true,url:"about:blank",timeOriginMs:1,title:"Owned page",heading:"Owned page"}}}};
        }else if(request.params.expression==='({url:location.href,title:document.title,timeOrigin:performance.timeOrigin})') {
          result={result:{value:{url:'about:blank',title:'Owned page',timeOrigin:driftPixelIdentity?++pixelIdentityReads:1}}};
        }else result={result:{value:request.params.expression==='window.devicePixelRatio'?2:'Visible page text'}};
      }
      if(request.method==='Page.navigate')result={frameId:'owned-frame'};
      if(request.method==='Accessibility.getFullAXTree'){
        if(failAx){socket.write(frame({id:request.id,error:{message:'AX observation unavailable'}}));continue;}
        result={nodes:axResponseQueue.length ? axResponseQueue.shift() : axNodes};
      }
      if(request.method==='Page.getLayoutMetrics')result={cssVisualViewport:{clientWidth:1,clientHeight:1,pageX:0,pageY:0}};
      if(request.method==='Page.captureScreenshot')result={data:badImage?'invalid':pixel};
      socket.write(frame({id:request.id,result}));
      if(request.method==='Page.navigate')socket.write(frame({method:'Page.loadEventFired',params:{timestamp:1}}));
    }
  });
});
const ctx={cwd:process.cwd()};
const tool=(fn,params)=>fn('launch-projection',params,undefined,undefined,ctx);
const originalLaunch=ManagedBrowser.launch;
const originalExecutable=process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE;
const originalBrowserUse=process.env.PI_COMPUTER_USE_BROWSER_USE;
process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE=process.execPath;
process.env.PI_COMPUTER_USE_BROWSER_USE='true';
let launchCount=0;
ManagedBrowser.launch=async (executable,browser,args,signal)=>{
  launchCount++;
  if(server.listening)await new Promise(resolve=>server.close(resolve));
  port=Number(args.find(arg=>arg.startsWith('--remote-debugging-port=')).split('=')[1]);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.removeListener('error',reject);resolve()});});
  // Real owned child/profile lifecycle; only the browser application is a fixture.
  return originalLaunch.call(ManagedBrowser,process.execPath,browser,
    ['-e','setInterval(()=>{},1000)','--',...args],signal);
};
try {
  axNodes=[{nodeId:'launch-root',role:{value:'RootWebArea'},childIds:Array.from({length:300},(_,i)=>'launch-'+i)},
    ...Array.from({length:300},(_,i)=>({nodeId:'launch-'+i,parentId:'launch-root',role:{value:'button'},name:{value:'Launch control '+i},backendDOMNodeId:i+1}))];
  await assert.rejects(tool(executeLaunchBrowser,{outlineView:'invalid'}),/outlineView must be/);
  assert.equal(launchCount,0,'Invalid projection must not start a browser');
  assert.equal(calls.length,0,'Invalid projection must not send CDP requests');
  const start=calls.length;
  const folded=await tool(executeLaunchBrowser,{outlineView:'folded'});
  assert.equal(launchCount,1);
  assert.equal(folded.details.outline.view,'folded');
  assert(folded.details.outline.observedNodeCount>300);
  assert(folded.details.outline.returnedNodeCount<=150);
  assert(folded.details.managedBrowser.pid>0);
  assert(folded.details.diagnostics.launchTimings.totalMs>=0);
  assert.equal(calls.slice(start).filter(c=>c.method==='Accessibility.getFullAXTree').length,1);
  assert(!calls.slice(start).some(c=>c.method==='Page.navigate'||c.method.startsWith('Input.')));
  const count=calls.length;
  const searched=await tool(executeSearchUi,{stateId:folded.details.stateId,text:'Launch control 299',role:'button'});
  assert.equal(searched.details.matches[0].label,'Launch control 299');
  const refs=new Set();const visit=n=>{refs.add(n.ref);n.children.forEach(visit)};visit(folded.details.outline.root);
  assert(!refs.has(searched.details.matches[0].ref),'Omitted targets must remain searchable in the complete launch cache');
  assert.equal(calls.length,count,'Cache search must not repeat launch or snapshot');
  const full=await tool(executeLaunchBrowser,{});
  assert.equal(launchCount,2);
  assert.notEqual(full.details.outline.view,'folded','Default response must remain complete');
  assert.notEqual(full.details.stateId,folded.details.stateId);
  const beforeStale=calls.length;
  await assert.rejects(tool(executeAct,{stateId:folded.details.stateId,actions:[{action:'click',x:1,y:1}]}),/stale|disappeared|no longer|unavailable|not found/i);
  assert.equal(calls.length,beforeStale,'Old launch state must never deliver input');
  console.log('Browser launch projection: one startup/snapshot, full-cache lookup, default full, invalid preflight and stale input refusal passed.');
} finally {
  await shutdownComputerUseSession();
  ManagedBrowser.launch=originalLaunch;
  if(originalExecutable===undefined)delete process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE;else process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE=originalExecutable;
  if(originalBrowserUse===undefined)delete process.env.PI_COMPUTER_USE_BROWSER_USE;else process.env.PI_COMPUTER_USE_BROWSER_USE=originalBrowserUse;
  Object.assign(currentPlatformBackend,original);
  for(const socket of sockets)socket.destroy();
  if(server.listening)await new Promise(resolve=>server.close(resolve));
}
