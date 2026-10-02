// New protocol-level capture diagnostic regression. A local fake daemon
// supplies native capture outcomes; this does not exercise ScreenCaptureKit.
import assert from 'node:assert/strict';
import net from 'node:net';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const cache=process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache');await fs.mkdir(cache,{recursive:true});
const dir=await fs.mkdtemp(path.join(cache,'cu-trace-'));
const socketPath=path.join(dir,'bridge.sock'),sockets=new Set();let looks=0;
const trace={requestId:'native-capture-id',windowId:41,readOnly:true,completed:false,stages:[{stage:'fallbackEnd',fallbackHasImage:false}]};
const server=net.createServer(socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));let buffer='';socket.on('data',chunk=>{buffer+=chunk;const newline=buffer.indexOf('\n');if(newline<0)return;const r=JSON.parse(buffer.slice(0,newline));if(r.cmd==='look')looks++;socket.end(JSON.stringify(r.cmd==='look'?{id:r.id,ok:false,error:{code:'capture_timeout',message:'Read-only capture completion unconfirmed',details:trace}}:{id:r.id,ok:true,result:{protocolVersion:6}})+'\n');});});
const prior=process.env.PI_CU_SOCKET_PATH;process.env.PI_CU_SOCKET_PATH=socketPath;
try{
 await new Promise(resolve=>server.listen(socketPath,resolve));
 const {MacosHelperClient,HelperCommandError,HelperTransportError}=await import('../src/platform/macos/helper.ts');
 const client=new MacosHelperClient();
 await assert.rejects(()=>client.command('look',{windowId:41}),error=>{
  assert(error instanceof HelperCommandError);assert(!(error instanceof HelperTransportError),'native capture timeout is not unknown input dispatch');
  assert.equal(error.code,'capture_timeout');assert.deepEqual(error.details,trace);assert.equal(error.details.completed,false);return true;
 });
 assert.equal(looks,1,'native read failure must not silently replay capture');
 console.log('Capture trace protocol preservation checks passed (new coverage; fake daemon, no native capture)');
}finally{
 if(prior===undefined)delete process.env.PI_CU_SOCKET_PATH;else process.env.PI_CU_SOCKET_PATH=prior;
 for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await fs.rm(dir,{recursive:true,force:true});
}
