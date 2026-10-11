import assert from 'node:assert/strict';
import {executeFind,shutdownComputerUseSession} from '../src/bridge.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
const original={...backend};let inputs=0,reads=0;
const root=(i,subrole='ApplicationFrameWindow')=>({kind:'window',windowId:1000+i,windowRef:'native-'+i,rootRef:'native-'+i,pid:100029,appName:'Root pages fixture',title:'',subrole,zOrder:i,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:false,isMain:false,isMinimized:false,isModal:false});
let roots=Array.from({length:14},(_,i)=>root(i+1));roots[12].subrole='Shell_TrayWnd';roots[13].subrole='Progman';
Object.assign(backend,{name:'windows',ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:'Root pages fixture',pid:100029,isFrontmost:false}],listRoots:async()=>{reads++;return roots;},isBrowserApp:()=>false,isChromeFamilyApp:()=>false,act:async()=>{inputs++;throw new Error('Discovery cannot send input');},focusWindow:async()=>{inputs++;throw new Error('Discovery cannot activate');},shutdown:async()=>{}});
const find=p=>executeFind('root-pages',p,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try {
 const first=(await find({pid:100029})).details;
 assert.equal(first.windows.length,12);assert.equal(first.totalMatches,14);assert.equal(first.hasMore,true);assert.equal(first.nextOffset,12);assert.equal(first.offset,0);
 const second=(await find({pid:100029,offset:first.nextOffset,expectedRootSetDigest:first.rootSetDigest})).details;
 assert.equal(second.rootSetDigest,first.rootSetDigest);assert.match(first.rootSetDigest,/^[a-f0-9]{64}$/);
 assert.equal(second.windows.length,2);assert.equal(second.hasMore,false);assert.equal(second.nextOffset,undefined);
 assert.equal(new Set([...first.windows,...second.windows].map(r=>r.windowId)).size,14);
 const beforeWide=reads;
 const wide=(await find({pid:100029,pageSize:100})).details;
 assert.equal(reads,beforeWide+1);assert.equal(wide.windows.length,14);assert.equal(wide.hasMore,false);
 assert.equal(wide.rootSetDigest,first.rootSetDigest);
 assert.deepEqual(wide.windows.map(r=>r.windowId),[...first.windows,...second.windows].map(r=>r.windowId));
 const small=(await find({pid:100029,pageSize:1})).details;
 assert.equal(small.windows.length,1);assert.equal(small.nextOffset,1);assert.equal(small.totalMatches,14);
 const nextSmall=(await find({pid:100029,pageSize:1,offset:1,expectedRootSetDigest:small.rootSetDigest})).details;
 assert.equal(nextSmall.windows[0].windowId,first.windows[1].windowId);
 for(const pageSize of [0,-1,0.5,NaN,Infinity,101,'12',true]) {
  const before=reads;await assert.rejects(()=>find({pid:100029,pageSize}),/pageSize/);assert.equal(reads,before);
 }
 assert.equal(second.windows[0].subrole,'Shell_TrayWnd');assert.match(second.windows[0].windowRef,/^@r\d+$/);
 const exact=(await find({pid:100029,subrole:'Shell_TrayWnd'})).details;
 assert.equal(exact.totalMatches,1);assert.equal(exact.windows[0].windowId,1013);assert.equal(exact.windows[0].windowRef,second.windows[0].windowRef);
 assert.equal((await find({pid:100029,subrole:'shell_traywnd'})).details.totalMatches,0);
 assert.equal((await find({pid:100029,subrole:'Missing'})).details.windows.length,0);
 const beyond=await find({pid:100029,offset:100});assert.equal(beyond.details.windows.length,0);assert.equal(beyond.details.hasMore,false);assert.match(beyond.content[0].text,/beyond the last root/);
 const beforeRefresh=reads;await assert.rejects(()=>find({pid:100029,expectedRootSetDigest:'invalid'}),/expectedRootSetDigest/);assert.equal(reads,beforeRefresh);
 roots[12]={...root(99,'Shell_TrayWnd'),zOrder:13};
 await assert.rejects(()=>find({pid:100029,offset:12,expectedRootSetDigest:first.rootSetDigest}),e=>e.code==='root_set_changed');
 assert.equal((await find({pid:100029,offset:12})).details.windows[0].windowId,1099,'Pages must re-enumerate live identities');
 await assert.rejects(()=>find({pid:100029,pageSize:100,expectedRootSetDigest:first.rootSetDigest}),e=>e.code==='root_set_changed');
 for(const offset of [-1,0.5,NaN,Infinity,10001,'12']) {const before=reads;await assert.rejects(()=>find({pid:100029,offset}),/offset/);assert.equal(reads,before);}
 for(const subrole of ['', '   ', 'x'.repeat(257)]) {const before=reads;await assert.rejects(()=>find({pid:100029,subrole}),/subrole/);assert.equal(reads,before);}
 const latest=(await find({pid:100029})).details;
 roots=[...roots].reverse().map((r,i)=>({...r,zOrder:i}));
 await assert.rejects(()=>find({pid:100029,offset:12,expectedRootSetDigest:latest.rootSetDigest}),e=>e.code==='root_set_changed');
 roots=Array.from({length:101},(_,i)=>root(i+1));
 const large=(await find({pid:100029,pageSize:100})).details;
 assert.equal(large.windows.length,100);assert.equal(large.totalMatches,101);assert.equal(large.nextOffset,100);
 const tail=(await find({pid:100029,pageSize:100,offset:large.nextOffset,expectedRootSetDigest:large.rootSetDigest})).details;
 assert.equal(tail.windows.length,1);assert.equal(tail.hasMore,false);
 assert.equal(new Set([...large.windows,...tail.windows].map(r=>r.windowId)).size,101);
 assert.equal(inputs,0);console.log('Root pages: bounded 14-root discovery, exact subrole, live refresh, invalid offsets and zero input passed');
} finally {await shutdownComputerUseSession();Object.assign(backend,original);}
