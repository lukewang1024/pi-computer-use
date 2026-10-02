import assert from 'node:assert/strict';
import http from 'node:http';
import {discoverLocalCdpPages} from '../src/cdp.ts';
for (const address of ['127.0.0.1','::1']) {
 const server=http.createServer((request,response)=>{
  assert.equal(request.url,'/json/list');
  const port=server.address().port;
  response.setHeader('Content-Type','application/json');
  response.end(JSON.stringify([
   {id:'local',type:'page',title:'fixture',webSocketDebuggerUrl:`ws://localhost:${port}/devtools/page/local`},
   {id:'remote',type:'page',webSocketDebuggerUrl:`ws://example.com:${port}/remote`},
   {id:'wrong-port',type:'page',webSocketDebuggerUrl:'ws://localhost:1/wrong'}
  ]));
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,address,resolve)});
 try {
  const port=String(server.address().port),pages=await discoverLocalCdpPages(port);
  assert.equal(pages.length,1);assert.equal(pages[0].id,'local');
  assert.equal(new URL(pages[0].webSocketDebuggerUrl).hostname,address==='::1'?'[::1]':address);
  await assert.rejects(()=>discoverLocalCdpPages('0'),/Invalid CDP port/);
 } finally {await new Promise(resolve=>server.close(resolve))}
}
console.log('IPv4 and IPv6 numeric loopback discovery passed; no input sent');
