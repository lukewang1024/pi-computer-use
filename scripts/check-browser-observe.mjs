import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { executeFind, executeNavigateBrowser, executeSearchUi, executeObserve, executeReadText, executeAct, executeWaitFor, shutdownComputerUseSession } from '../src/bridge.ts';
import { BROWSER_PERFORMANCE_SAMPLE } from '../src/browser-performance.ts';
import { currentPlatformBackend } from '../src/platform/index.ts';

// Exercise public tool executors and the real CDP transport. Only native
// readiness/enumeration are stubbed, so this test cannot deliver desktop input.
const original = { ensureReady: currentPlatformBackend.ensureReady, listRoots: currentPlatformBackend.listRoots, getFrontmost: currentPlatformBackend.getFrontmost };
currentPlatformBackend.ensureReady = async () => ({lastPermissionCheckAt: Date.now()});
currentPlatformBackend.listRoots = async () => [];
currentPlatformBackend.getFrontmost = async () => {throw Error("Browser search must not query desktop foreground");};
const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l0AAAAASUVORK5CYII=';
let port, present = true, badImage = false, axNodes=[], failPerformance=false;
const calls = [], sockets = new Set();
function frame(value) {
  const data = Buffer.from(JSON.stringify(value));
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  const header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
}
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(present ? [{id:'exact-page',type:'page',title:'Owned page',url:'about:blank',webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/page/exact-page`}] : []));
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
          result={result:{value:{navigation:{timeOriginMs:1},observation:{supported:[],entries:{}},loadWait:{complete:true}}}};
        }else result={result:{value:request.params.expression==='window.devicePixelRatio'?2:'Visible page text'}};
      }
      if(request.method==='Page.navigate')result={frameId:'owned-frame'};
      if(request.method==='Accessibility.getFullAXTree')result={nodes:axNodes};
      if(request.method==='Page.getLayoutMetrics')result={cssVisualViewport:{clientWidth:1,clientHeight:1,pageX:0,pageY:0}};
      if(request.method==='Page.captureScreenshot')result={data:badImage?'invalid':pixel};
      socket.write(frame({id:request.id,result}));
      if(request.method==='Page.navigate')socket.write(frame({method:'Page.loadEventFired',params:{timestamp:1}}));
    }
  });
});
const ctx={cwd:process.cwd()};
const tool=(fn,params)=>fn('integration',params,undefined,undefined,ctx);
try {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));port=server.address().port;
  process.env.PI_COMPUTER_USE_CDP_PORT=String(port);process.env.PI_COMPUTER_USE_BROWSER_USE='true';
  const roots=await tool(executeFind,{kind:'browser_page'});
  assert.equal(roots.details.windows.length,1);
  const root=roots.details.windows[0].windowRef;
  const semantic=await tool(executeObserve,{root,mode:'semantic'});
  assert.equal(semantic.content.some(c=>c.type==='image'),false);
  assert.equal(calls.some(c=>c.method==='Page.captureScreenshot'),false,'semantic observation must not capture');
  const emptySearch=await tool(executeSearchUi,{stateId:semantic.details.stateId,role:'textbox'});
  assert.equal(emptySearch.details.matches.length,0);
  assert.equal(emptySearch.details.stateId,semantic.details.stateId,'empty browser search must preserve its browser state');
  await assert.rejects(()=>tool(executeAct,{stateId:semantic.details.stateId,actions:[{action:'press',ref:'@e999999'}]}),/requires an actionable @e ref owned by/);
  await assert.rejects(()=>tool(executeAct,{stateId:semantic.details.stateId,actions:[{action:'keypress',ref:semantic.details.outline.root.ref,keys:['Enter']}]}),/requires an actionable @e ref owned by/);
  await assert.rejects(()=>tool(executeAct,{stateId:'missing-state',actions:[{action:'click',x:1,y:1}]}),/unavailable or was evicted/);
  const waited=await tool(executeWaitFor,{stateId:semantic.details.stateId,text:'Never present',timeoutMs:1});
  assert.equal(waited.details.found,false);
  assert.equal(waited.details.timedOut,true);
  assert.equal(waited.details.baseStateId,semantic.details.stateId);
  assert.equal(calls.some(c=>c.method==='Page.captureScreenshot'),false,'condition polling must not capture');
  const controller=new AbortController();controller.abort();
  await assert.rejects(()=>executeWaitFor('aborted',{stateId:waited.details.stateId,text:'Never present',timeoutMs:1000},controller.signal,undefined,ctx));
  const beforePixels=calls.length;
  await assert.rejects(()=>tool(executeObserve,{root,mode:'pixels'}),/exact Windows native/);
  assert.equal(calls.length,beforePixels,'unsupported pixel mode must not issue a CDP request');
  for(const mode of ['visual','fused',undefined]) {
    const result=await tool(executeObserve,{root,...(mode?{mode}:{})});
    assert.equal(result.content.find(c=>c.type==='image')?.data,pixel);
    assert.equal(result.details.capture.stateId,result.details.stateId);
    assert.equal(result.details.capture.width,1);
    assert.equal(result.details.capture.pixelScale,1);
    assert.equal(result.details.capture.coordinateSpace,'browser-viewport-screenshot-pixels');
    const text=await tool(executeReadText,{stateId:result.details.stateId,ref:result.details.outline.root.ref});
    assert(text.content.some(c=>c.type==='text'&&c.text.includes('Visible page text')),'successor state must remain readable');
  }
  axNodes=[
    {nodeId:'readonly',role:{value:'textbox'},name:{value:'Read only'},backendDOMNodeId:17,properties:[{name:'readonly',value:{value:true}}]},
    {nodeId:'disabled',role:{value:'button'},name:{value:'Disabled'},backendDOMNodeId:18,properties:[{name:'disabled',value:{value:true}}]},
    {nodeId:'editable',role:{value:'textbox'},name:{value:'Editable'},backendDOMNodeId:19,properties:[{name:'readonly',value:{value:false}}]}
  ];
  const controls=await tool(executeObserve,{root,mode:'semantic'});
  const byTitle=new Map();const collect=n=>{byTitle.set(n.title,n);for(const child of n.children)collect(child);};collect(controls.details.outline.root);
  assert.equal(byTitle.get('Read only').canSetValue,false);
  assert.equal(byTitle.get('Read only').canFocus,true,'read-only text may still receive navigation focus');
  assert.equal(byTitle.get('Disabled').canPress,false);
  assert.equal(byTitle.get('Disabled').canFocus,false);
  assert.equal(byTitle.get('Editable').canSetValue,true);
  const writable=await tool(executeSearchUi,{stateId:controls.details.stateId,role:'textbox',capability:'setText'});
  assert.equal(writable.details.matches.length,1,'writable search must exclude read-only controls');
  assert.equal(writable.details.matches[0].label,'Editable');
  const beforeInvalidBatch=calls.length;
  await assert.rejects(()=>tool(executeAct,{stateId:controls.details.stateId,actions:[{action:'press',ref:writable.details.matches[0].ref},{action:'keypress',ref:writable.details.matches[0].ref,keys:['ctrl']}]}),/requires a base key/);
  assert.equal(calls.slice(beforeInvalidBatch).some(c=>c.method==='DOM.resolveNode'||c.method.startsWith('Input.')),false,'invalid later chord must stop earlier input before dispatch');
  axNodes.push({nodeId:'remote-read-only',role:{value:'button'},name:{value:'Remote read only'},backendDOMNodeId:33,cuReadOnlyRemote:true});
  const remoteView=await tool(executeObserve,{root,mode:'semantic'});
  const remoteMatch=await tool(executeSearchUi,{stateId:remoteView.details.stateId,text:'Remote read only',role:'button'});
  assert.equal(remoteMatch.details.matches.length,1,'remote controls remain observable');
  const beforeRemoteInput=calls.length;
  await assert.rejects(()=>tool(executeAct,{stateId:remoteView.details.stateId,actions:[{action:'click',ref:remoteMatch.details.matches[0].ref}]}),/requires an actionable @e ref owned by/);
  assert.equal(calls.slice(beforeRemoteInput).some(c=>c.method==='DOM.resolveNode'||c.method.startsWith('Input.')),false,'read-only frame refs must reject before input preparation');
  axNodes.push({nodeId:'frame-owner',role:{value:'Iframe'},name:{value:'Unavailable frame'},backendDOMNodeId:20});
  const partial=await tool(executeObserve,{root,mode:'semantic'});
  assert.equal(partial.details.diagnostics.accessibilityCoverage.framesUnavailable,1);
  assert(partial.content.some(c=>c.type==='text'&&c.text.includes('Accessibility coverage is partial')),'partial frame coverage must reach the agent');
  const beforeBadOption=calls.length;
  await assert.rejects(()=>tool(executeNavigateBrowser,{stateId:partial.details.stateId,url:'https://example.com/',includePerformance:'yes'}),/must be boolean/);
  assert.equal(calls.length,beforeBadOption,'invalid option must not dispatch navigation');
  const beforeMetrics=calls.length;
  const measured=await tool(executeNavigateBrowser,{stateId:partial.details.stateId,url:'https://example.com/',includePerformance:true});
  const measuredCalls=calls.slice(beforeMetrics);
  assert.equal(measuredCalls.filter(c=>c.method==='Page.navigate').length,1,'one navigation submission');
  assert.equal(measuredCalls.filter(c=>c.method==='Accessibility.getFullAXTree').length,1,'one successor tree, not a second evaluation tree');
  assert(measured.details.performanceSample.loadWait.complete);
  assert.notEqual(measured.details.stateId,partial.details.stateId,'metrics navigation must return a new state');
  const beforeOldInput=calls.length;
  await assert.rejects(()=>tool(executeAct,{stateId:partial.details.stateId,actions:[{action:'click',x:1,y:1}]}),/stale/i);
  assert.equal(calls.slice(beforeOldInput).some(c=>c.method.startsWith('Input.')),false,'old state remains rejected before input');
  failPerformance=true;
  const beforeFailure=calls.length;
  const unavailable=await tool(executeNavigateBrowser,{stateId:measured.details.stateId,url:'https://example.com/',includePerformance:true});
  const failureCalls=calls.slice(beforeFailure);
  assert.equal(failureCalls.filter(c=>c.method==='Page.navigate').length,1,'failed metrics cannot replay navigation');
  assert.equal(failureCalls.filter(c=>c.method==='Accessibility.getFullAXTree').length,1,'metrics failure still returns one successor tree');
  assert.equal(unavailable.details.performanceError.status,'unavailable');
  assert(unavailable.details.stateId,'successful navigation state survives metrics failure');
  failPerformance=false;
  badImage=true;
  await assert.rejects(()=>tool(executeObserve,{root,mode:'visual'}),/not a PNG/);
  present=false;
  await assert.rejects(()=>tool(executeObserve,{root,mode:'visual'}),/no longer available/);
  assert.equal(calls.some(c=>c.method.startsWith('Input.')),false,'observation must not send input');
  console.log('Browser observe executor integration checks passed');
} finally {
  await shutdownComputerUseSession();Object.assign(currentPlatformBackend,original);
  for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));
}
