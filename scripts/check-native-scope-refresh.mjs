// Controlled backend tests. No actual HWND, screen capture or physical input.
import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeObserve,executeExpandUi,executeSearchUi,shutdownComputerUseSession} from '../src/bridge.ts';
const root={kind:'window',rootRef:'native-root',windowRef:'native-root',windowId:10,pid:7,appName:'Fixture',title:'Owned fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
const node=(ref,title,children=[],extra={})=>({ref,title,role:'group',children,...extra});
let requests=[],inputs=0,sequence=0,mode='fresh',closed=false;
const overrides={name:'windows',ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),
 listApps:async()=>[{appName:root.appName,pid:root.pid}],listRoots:async()=>closed?[]:[root],
 getFrontmost:async()=>({appName:root.appName,pid:root.pid,windowId:10,rootRef:root.rootRef}),
 isBrowserApp:()=>false,isChromeFamilyApp:()=>false,
 observe:async request=>{
  requests.push(request);
  if(request.scopeRef&&mode==='failure')throw Error('Scope ref is stale or outside the target root');
  const scope=request.scopeRef;
  const returnedScope=mode==='wrong-scope'?'other-scope':(backend.name==='macos'?'renewed-mac-scope-'+sequence:scope);
  const outline=scope?node(returnedScope,'Revision menu',[
   node('fresh-a','Accept All Changes',[],{role:'menuItem',isEnabled:true}),
   node('fresh-b','Accept All Changes',[],{role:'menuItem',isEnabled:true})],{truncated:mode==='partial',...(mode==='wrong-role'?{role:'text'}:{}),...(mode==='wrong-identifier'?{identifier:'different'}:{})}):
   node('window','Owned fixture',[node('scope','Revision menu',[node('old','Accept All Changes',[],{role:'menuItem',isEnabled:true})]),node('outside','Outside')],{truncated:true});
  return parseLookResponse({lookId:'scope-look-'+(++sequence),window:{windowId:mode==='wrong-window'&&scope?20:10,rootRef:scope&&mode==='wrong-native-root'?'other-native-window':root.rootRef,framePoints:root.framePoints,scaleFactor:1},outline});
 },act:async()=>{inputs++;throw Error('Unexpected input');},shutdown:async()=>{}};
const original=Object.fromEntries(Object.keys(overrides).map(k=>[k,backend[k]]));Object.assign(backend,overrides);
const call=(fn,params)=>fn('native-scope-refresh',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try{
 const found=await call(executeFind,{text:root.title});const ref=found.details.windows[0].windowRef;
 const observe=()=>call(executeObserve,{root:ref,mode:'semantic'});
 let full=await observe();let stateId=full.details.capture.stateId;
 let scope=full.details.outline.root.children[0].ref;
 const old=full.details.outline.root.children[0].children[0].ref;
 const outside=full.details.outline.root.children[1].ref;
 const cached=await call(executeExpandUi,{stateId,ref:scope,depth:8,includeSubtree:true});
 assert.equal(cached.details.subtree.truncated,false);
 assert.equal(requests.length,1,'Legacy expansion of an unmarked child stays cached');
 const fresh=await call(executeExpandUi,{stateId,ref:scope,refresh:true,depth:8,includeSubtree:true});
 assert.equal(requests.length,2,'Explicit refresh must read even when only the ancestor was truncated');
 const request=requests.at(-1);assert.equal(request.scopeRef,'scope');assert.equal(request.baseLookId,'scope-look-1');
 assert.equal(request.target.windowId,10);assert.equal(request.target.pid,7);
 assert.equal(request.includeImage,false);assert.equal(request.readText,'never');assert.equal(request.maxDimension,1);
 assert.equal(fresh.details.scopeRefresh.requested,true);assert.equal(fresh.details.scopeRefresh.performed,true);
 assert.equal(fresh.details.scopeRefresh.scopeRef,scope);assert.equal(fresh.details.subtree.truncated,false);
 assert.equal(fresh.details.subtree.root.children.length,2,'Fresh duplicate must not disappear behind cached uniqueness');
 assert.notEqual(fresh.details.subtree.root.children[0].ref,old,'Replaced child refs must be retired');
 await assert.rejects(()=>call(executeExpandUi,{stateId,ref:old}),/not available/);
 const retained=await call(executeExpandUi,{stateId,ref:outside,includeSubtree:true});assert.equal(retained.details.target.ref,outside);
 for(const name of ['windows','macos']){
  backend.name=name;full=await observe();stateId=full.details.capture.stateId;scope=full.details.outline.root.children[0].ref;
  mode='partial';const partial=await call(executeExpandUi,{stateId,ref:scope,refresh:true,includeSubtree:true});
  assert.equal(partial.details.scopeRefresh.performed,true);assert.equal(partial.details.subtree.truncated,true,'Native frontier must remain incomplete');mode='fresh';
  assert.equal(partial.details.scopeRefresh.nativeRefRenewed,name==='macos','Receipt must distinguish renewed AX refs from Windows echoed scope refs');
 }
 let count=requests.length;
 await assert.rejects(()=>call(executeExpandUi,{stateId,ref:scope,refresh:'yes'}),/must be boolean/);
 await assert.rejects(()=>call(executeExpandUi,{stateId:'stale-state',ref:scope,refresh:true}),/state|observation/i);
 backend.name='linux';await assert.rejects(()=>call(executeExpandUi,{stateId,ref:scope,refresh:true}),/Windows or macOS native/);
 assert.equal(requests.length,count,'Invalid state/type/platform must reject before native reading');backend.name='windows';
 for(const failure of ['wrong-scope','wrong-window','failure']){
  mode='fresh';full=await observe();stateId=full.details.capture.stateId;scope=full.details.outline.root.children[0].ref;
  mode=failure;await assert.rejects(()=>call(executeExpandUi,{stateId,ref:scope,refresh:true,includeSubtree:true}),/identity mismatch|stale/);
  const unchanged=await call(executeSearchUi,{stateId,text:'Accept All Changes',role:'menuItem'});
  assert.equal(unchanged.details.matches.length,1,'Failed read must not graft mismatched contents');
 }
 backend.name='macos';
 for(const failure of ['wrong-native-root','wrong-window','wrong-role','wrong-identifier']){
  mode='fresh';full=await observe();stateId=full.details.capture.stateId;scope=full.details.outline.root.children[0].ref;
  mode=failure;await assert.rejects(()=>call(executeExpandUi,{stateId,ref:scope,refresh:true,includeSubtree:true}),/identity mismatch/);
 }
 backend.name='windows';
 mode='fresh';full=await observe();stateId=full.details.capture.stateId;scope=full.details.outline.root.children[0].ref;
 count=requests.length;closed=true;await assert.rejects(()=>call(executeExpandUi,{stateId,ref:scope,refresh:true}));
 assert.equal(requests.length,count,'Closed exact root must reject before native reading');
 assert.equal(inputs,0,'Scoped refresh is read-only throughout');
 console.log('PASS explicit native scope read, duplicate discovery, retained frontier, identity/stale/closed guards, no image/OCR/input, legacy caching and ref retirement');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
