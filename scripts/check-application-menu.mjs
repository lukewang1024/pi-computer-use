import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {macosBackend} from '../src/platform/macos/backend.ts';
import {macosHelper} from '../src/platform/macos/helper.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind, executeObserve, shutdownComputerUseSession} from '../src/bridge.ts';

const raw={lookId:'menu-look',window:{windowId:10},outline:{ref:'window',role:'AXWindow',children:[{ref:'bar',role:'AXMenuBar',children:[{ref:'file',role:'AXMenuBarItem',title:'File',isEnabled:true,actions:['AXPress']}]}]}};
for(const flag of [undefined,false,'true',1]) assert.equal(parseLookResponse({...raw,applicationMenuIncluded:flag}).applicationMenuIncluded,undefined);
assert.equal(parseLookResponse({...raw,applicationMenuIncluded:true}).applicationMenuIncluded,true);
const oldCommand=macosHelper.command;
const requests=[];
try {
 macosHelper.command=async(command,params)=>{requests.push({command,params});return {...raw,applicationMenuIncluded:params.applicationMenu===true};};
 await macosBackend.observe({target:{pid:7,windowId:10,windowRef:'exact'},readText:'never',includeImage:false});
 assert.equal(requests.at(-1).params.applicationMenu,undefined);
 const look=await macosBackend.observe({target:{pid:7,windowId:10,windowRef:'exact'},readText:'never',includeImage:false,applicationMenu:true});
 assert.equal(requests.at(-1).params.applicationMenu,true);
 assert.equal(requests.at(-1).params.windowRef,'exact');
 assert.equal(look.applicationMenuIncluded,true);
 assert.equal(look.parsedOutline.nodes.find(n=>n.title==='File').role,'AXMenuBarItem');
 assert.equal(requests.length,2);
} finally {macosHelper.command=oldCommand;}

const root={kind:'window',rootRef:'native-root',windowRef:'native-root',windowId:10,pid:7,appName:'Fixture',title:'Owned fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
let inputs=0, verified=true;const observes=[];
const overrides={ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:'Fixture',pid:7}],listRoots:async()=>[root],getFrontmost:async()=>({appName:'Fixture',pid:7,windowId:10,rootRef:'native-root'}),observe:async request=>{observes.push(request);return parseLookResponse({...raw,applicationMenuIncluded:request.applicationMenu===true&&verified});},act:async()=>{inputs++;throw Error('Unexpected input');}};
const original=Object.fromEntries(Object.keys(overrides).map(key=>[key,backend[key]]));const originalName=backend.name;
Object.assign(backend,overrides,{name:'macos'});
const call=(fn,params)=>fn('application-menu-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try {
 const found=await call(executeFind,{text:root.title});const ref=found.details.windows[0].windowRef;
 await call(executeObserve,{root:ref,mode:'semantic'});
 assert.notEqual(observes.at(-1).applicationMenu,true);
 await call(executeObserve,{root:ref,mode:'semantic',applicationMenu:true});
 assert.equal(observes.at(-1).applicationMenu,true);assert.equal(observes.at(-1).includeImage,false);
 verified=false;
 await assert.rejects(call(executeObserve,{root:ref,mode:'semantic',applicationMenu:true}),/did not verify application menu/);
 const count=observes.length;
 await assert.rejects(call(executeObserve,{root:ref,mode:'semantic',applicationMenu:'true'}),/boolean/);
 for(const mode of ['pixels','fused','visual']) await assert.rejects(call(executeObserve,{root:ref,mode,applicationMenu:true}),/semantic mode/);
 await assert.rejects(call(executeObserve,{mode:'semantic',applicationMenu:true}),/exact macOS native window/);
 for(const name of ['windows','linux']) {backend.name=name;await assert.rejects(call(executeObserve,{root:ref,mode:'semantic',applicationMenu:true}),/exact macOS native window/);}
 assert.equal(observes.length,count,'Invalid requests must not dispatch native reads');
 assert.equal(inputs,0);
} finally {Object.assign(backend,original,{name:originalName});await shutdownComputerUseSession();}
console.log('PASS application menu public observation and old-helper refusal');
