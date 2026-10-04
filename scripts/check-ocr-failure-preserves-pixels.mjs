import assert from 'node:assert/strict';
import {parseLookResponse} from '../src/outline.ts';
import {currentPlatformBackend as backend} from '../src/platform/index.ts';
import {executeFind,executeObserve,executeSearchUi,shutdownComputerUseSession} from '../src/bridge.ts';
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=';
const root={kind:'window',rootRef:'ocr-root',windowId:71,pid:100071,appName:'OCR fixture',title:'Owned OCR failure fixture',zOrder:0,framePoints:{x:0,y:0,w:100,h:100},scaleFactor:1,isOnscreen:true,isFocused:true,isMinimized:false,isMain:true,isModal:false};
const requests=[];let completion='completed';let busy=false;
const overrides={
 ensureReady:async()=>({lastPermissionCheckAt:Date.now()}),listApps:async()=>[{appName:root.appName,pid:root.pid}],listRoots:async()=>[root],
 getFrontmost:async()=>({appName:root.appName,pid:root.pid,windowId:root.windowId,rootRef:root.rootRef}),isBrowserApp:()=>false,isChromeFamilyApp:()=>false,
 observe:async(request)=>{
  requests.push(request);const pixels=request.includeImage!==false;
  return parseLookResponse({lookId:'ocr-look-'+requests.length,capturedAt:Date.now(),window:{windowId:root.windowId,rootRef:root.rootRef,framePoints:root.framePoints,scaleFactor:1,isModal:false},
   outline:{ref:'window',role:'AXWindow',title:root.title,children:[{ref:'body',role:'AXTextArea',title:'Document body',value:'Native text remains',children:[]}]},
   readText:{requested:request.readText||'auto',executed:false},
   ocrDiagnostics:pixels?{status:'failed',nativeCompletion:completion,readOnly:true,errorKind:busy?'text_recognition_busy':'text_recognition_timeout',operationNotStarted:busy,cancellationRequested:!busy,errorDomain:'TextRecognition.CRImageReaderError',errorCode:1,error:'x'.repeat(2000)}:undefined,
   image:pixels?{jpegBase64:png,mimeType:'image/png',width:1,height:1}:undefined,timings:{}});
 },act:async()=>{throw Error('Read-only OCR regression must not dispatch input');},
};
const original=Object.fromEntries(Object.keys(overrides).map(key=>[key,backend[key]]));Object.assign(backend,overrides);
const call=(fn,params)=>fn('ocr-regression',params,undefined,undefined,{cwd:process.cwd(),hasUI:false});
try{
 const roots=await call(executeFind,{text:root.title});const ref=roots.details.windows[0].windowRef;
 for(const scenario of [{completion:'completed',busy:false},{completion:'unconfirmed',busy:false},{completion:'unconfirmed',busy:true}]){
  const expected=scenario.completion;completion=expected;busy=scenario.busy;const before=requests.length;const result=await call(executeObserve,{root:ref,mode:'visual'});
  assert.equal(requests.length,before+2,'Semantic-first and one capture only; OCR failure must not recapture');
  assert.equal(result.details.capture.width,1);assert.equal(result.content.filter(x=>x.type==='image').length,1);
  assert.equal(result.details.ocrDiagnostics.status,'failed');assert.equal(result.details.ocrDiagnostics.nativeCompletion,expected);
  assert.equal(result.details.ocrDiagnostics.error.length,1024);assert.equal(result.details.ocrDiagnostics.readOnly,true);
  assert.equal(result.details.ocrDiagnostics.operationNotStarted,busy);assert.equal(result.details.ocrDiagnostics.cancellationRequested,!busy);
  assert.equal(result.details.ocrDiagnostics.errorKind,busy?'text_recognition_busy':'text_recognition_timeout');
  assert.ok(JSON.stringify(result.details.outline).includes('Native text remains'));
  assert.ok(result.content.some(x=>x.type==='text'&&x.text.includes('OCR text was not obtained')));
  assert.ok(!result.content.some(x=>x.type==='text'&&x.text.includes('no image was returned')));
  const beforeSearch=requests.length;await call(executeSearchUi,{stateId:result.details.capture.stateId,text:'Missing OCR text'});
  assert.equal(requests.length,beforeSearch,'A failed OCR attempt must not be repeated automatically in the same observation');
 }
 console.log('OCR failure keeps one captured image, native AX evidence and bounded failure/completion diagnostics; no input or recapture');
}finally{Object.assign(backend,original);await shutdownComputerUseSession();}
