#!/usr/bin/env node
// Read-only regression against owned windows on an interactive Windows desktop.
import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

if(process.platform!=='win32'||process.env.PI_CU_LIVE!=='1')throw new Error('Use PI_CU_LIVE=1 in an interactive Windows session.');
const helperArg=process.argv.indexOf('--helper');
const helperPath=helperArg<0?undefined:process.argv[helperArg+1];
if(!helperPath||!path.isAbsolute(helperPath))throw new Error('--helper requires an absolute path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pi-cu-observation-'));
const source=String.raw`
using System;using System.IO;using System.Threading;using System.Windows.Forms;using System.Runtime.InteropServices;
public class ObservationFixture {
 [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h,int attribute,ref int value,int size);
 [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h,int attribute,out int value,int size);
 static Form Window(string title){var f=new Form();f.Text=title;f.Width=420;f.Height=260;
 f.Controls.Add(new Button{Text="Read fixture sentinel",Left=40,Top=70,Width=240});
 f.Controls.Add(new TextBox{Text="Repeated read sentinel",Left=40,Top=120,Width=240});return f;}
 public static void Run(string dir, bool block){
  var main=Window(block?"Unresponsive observation fixture":"Healthy observation fixture");
  Form hidden=null;
  main.Shown+=(s,e)=>{
   File.WriteAllText(Path.Combine(dir,block?"target.txt":"healthy.txt"),main.Handle.ToInt64().ToString());
   if(!block){hidden=Window("Cloaked observation fixture");hidden.Show();
    File.WriteAllText(Path.Combine(dir,"cloaked.txt"),hidden.Handle.ToInt64().ToString());}
  };
  var timer=new System.Windows.Forms.Timer();timer.Interval=50;
  timer.Tick+=(s,e)=>{
   if(!block && File.Exists(Path.Combine(dir,"cloak.request")) && !File.Exists(Path.Combine(dir,"cloak.done"))){
    int cloak=1;Marshal.ThrowExceptionForHR(DwmSetWindowAttribute(hidden.Handle,13,ref cloak,4));
    int actual;Marshal.ThrowExceptionForHR(DwmGetWindowAttribute(hidden.Handle,14,out actual,4));
    File.WriteAllText(Path.Combine(dir,"cloak.done"),actual.ToString());}
   if(block && File.Exists(Path.Combine(dir,"block.request"))){timer.Stop();
   File.WriteAllText(Path.Combine(dir,"blocked.txt"),"blocked");Thread.Sleep(30000);}};
  timer.Start();Application.Run(main);
 }

}`;
const ps=`$ErrorActionPreference='Stop';Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:PI_CU_OBSERVATION_SOURCE)) -ReferencedAssemblies System.Windows.Forms,System.Drawing;[ObservationFixture]::Run($env:PI_CU_OBSERVATION_DIR,($env:PI_CU_OBSERVATION_BLOCK -eq '1'))`;
fs.writeFileSync(path.join(dir,'fixture.cs'),source);
const spawnFixture=block=>spawn('powershell.exe',['-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(ps,'utf16le').toString('base64')],{
 windowsHide:false,stdio:['ignore','ignore','pipe'],env:{...process.env,PI_CU_OBSERVATION_SOURCE:path.join(dir,'fixture.cs'),PI_CU_OBSERVATION_DIR:dir,PI_CU_OBSERVATION_BLOCK:block?'1':'0'},
});
const fixture=spawnFixture(true),healthyFixture=spawnFixture(false);
const helper=spawn(helperPath,[],{windowsHide:true,stdio:['pipe','pipe','pipe']});
const lines=readline.createInterface({input:helper.stdout}),pending=new Map();let serial=0,stderr='';
for(const process of [fixture,healthyFixture,helper])process.stderr.on('data',b=>{stderr=(stderr+b).slice(-16000);});
lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{return;}pending.get(value.id)?.(value);});
const request=(cmd,args)=>new Promise((resolve,reject)=>{
 const id=`observation-${++serial}`,start=performance.now();
 const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${cmd} exceeded test deadline`));},12000);
 pending.set(id,value=>{clearTimeout(timer);pending.delete(id);resolve({...value,elapsedMs:Math.round(performance.now()-start)});});
 helper.stdin.write(JSON.stringify({protocolVersion:4,id,cmd,args})+'\n');
});
const waitFile=async name=>{for(let i=0;i<160;i++){if(fs.existsSync(path.join(dir,name)))return fs.readFileSync(path.join(dir,name),'utf8');await new Promise(r=>setTimeout(r,50));}throw new Error(`Missing fixture ${name}: ${stderr}`);};
try{
 const hwnd=Number(await waitFile('target.txt')),healthy=Number(await waitFile('healthy.txt')),cloaked=Number(await waitFile('cloaked.txt'));
 let roots;
 for(let i=0;i<40;i++){
  roots=await request('listRoots',{});assert.equal(roots.ok,true);
  if([hwnd,healthy,cloaked].every(id=>roots.result.roots.some(root=>root.windowId===id)))break;
  await new Promise(resolve=>setTimeout(resolve,50));
 }
 assert([hwnd,healthy,cloaked].every(id=>roots.result.roots.some(root=>root.windowId===id)),JSON.stringify(roots));
 const previouslyVisibleRoot=roots.result.roots.find(root=>root.windowId===cloaked);
 fs.writeFileSync(path.join(dir,'cloak.request'),'cloak');assert.equal(Number(await waitFile('cloak.done')),1);
 const hiddenFocus=await request('focusWindow',{rootRef:previouslyVisibleRoot.rootRef,pid:healthyFixture.pid});
 assert.equal(hiddenFocus.ok,true,JSON.stringify(hiddenFocus.error));
 assert.equal(hiddenFocus.result.focused,false,'Cloaked fixture was treated as focused');
 assert.equal(hiddenFocus.result.activationDiagnostics.final.eligible,false,'Cloaked fixture was eligible for activation');
 assert.equal(hiddenFocus.result.activationDiagnostics.attempts.length,1,'Cloaked fixture triggered an activation attempt');
 roots=await request('listRoots',{});assert.equal(roots.ok,true);
 assert(!roots.result.roots.some(root=>root.windowId===cloaked),'Cloaked fixture was advertised as visible');
 const before=await request('look',{windowId:hwnd,includeImage:true,includeElements:true});
 assert.equal(before.ok,true,JSON.stringify(before.error));assert(before.result.image?.jpegBase64);
 assert.match(JSON.stringify(before.result.outline),/Read fixture sentinel/);
 fs.writeFileSync(path.join(dir,'block.request'),'block');await waitFile('blocked.txt');
 const blocked=await request('look',{windowId:hwnd,includeImage:true,includeElements:false});
 assert.equal(blocked.ok,false);assert.equal(blocked.error.code,'capture_failed');
 assert.match(blocked.error.message,/GDI read worker deadline exceeded; terminated and reaped/);
 assert(blocked.elapsedMs<8000);
 const semantic=await request('look',{windowId:hwnd,includeImage:false,includeElements:true});
 assert.equal(semantic.ok,true,JSON.stringify(semantic.error));
 assert.equal(semantic.result.uiaDiagnostics?.status,'incomplete');
 roots=await request('listRoots',{});assert.equal(roots.ok,true);
 const healthyRoot=roots.result.roots.find(root=>root.windowId===healthy);
 assert(healthyRoot,JSON.stringify(roots));
 const after=await request('look',{rootRef:healthyRoot.rootRef,includeImage:true,includeElements:true});
 assert.equal(after.ok,true,JSON.stringify(after.error));assert(after.result.image?.jpegBase64);
 assert.match(JSON.stringify(after.result.outline),/Read fixture sentinel/);
 const nodes=value=>!value||typeof value!=='object'?[]:Array.isArray(value)?value.flatMap(nodes):[value,...Object.values(value).flatMap(nodes)];
 const editor=nodes(after.result.outline).find(node=>node.role==='edit');assert(editor);
 const read=async()=>{
  const result=await request('uiaReadText',{lookId:after.result.lookId,elementRef:editor.ref});
  assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.result.text,'Repeated read sentinel');
 };
 const usage=()=>JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${helper.pid};@{threads=$p.Threads.Count;handles=$p.HandleCount}|ConvertTo-Json -Compress`],{windowsHide:true,encoding:'utf8'}));
 for(let i=0;i<8;i++)await read();
 const beforeReads=usage();for(let i=0;i<32;i++)await read();const afterReads=usage();
 assert(afterReads.threads<=beforeReads.threads+8,`UIA read threads accumulate: ${JSON.stringify({beforeReads,afterReads})}`);
 assert(afterReads.handles<=beforeReads.handles+64,`UIA read handles accumulate: ${JSON.stringify({beforeReads,afterReads})}`);
 const children=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter "ParentProcessId=${helper.pid}" | ForEach-Object { @{name=$_.Name;readWorker=($_.CommandLine -match '--read-only-(uia|capture)')} })`],{windowsHide:true,encoding:'utf8'}).trim());
 assert.equal(children.filter(child=>child.readWorker).length,0,`read worker survived its completed request: ${JSON.stringify(children)}`);
 assert.match(stderr,/print_window_started/);assert.match(stderr,/uia_element_from_handle_started/);
 console.log(JSON.stringify({status:'passed',cloakedRootExcluded:true,cloakedActivation: hiddenFocus.result.activationDiagnostics.final,captureFailure:blocked.error,captureElapsedMs:blocked.elapsedMs,
  semantic:semantic.result.uiaDiagnostics,healthyCaptureElapsedMs:after.elapsedMs,ownedReadWorkers:0,helperChildren:children,
  repeatedReads:{count:40,beforeReads,afterReads}}));
}catch(error){console.error(`${error.stack}\n${stderr}`);process.exitCode=1;}
finally{
 lines.close();
 await Promise.all([helper,fixture,healthyFixture].map(async child=>{if(child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}}));
 fs.rmSync(dir,{recursive:true,force:true});
}
