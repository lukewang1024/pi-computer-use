#!/usr/bin/env node
// Live regression on a disposable, owned WinForms control. Run only in an
// interactive Windows session: PI_CU_LIVE=1 node this-script --helper PATH.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';

if (process.platform !== 'win32' || process.env.PI_CU_LIVE !== '1') {
 throw new Error('Set PI_CU_LIVE=1 in an interactive Windows session.');
}
const index = process.argv.indexOf('--helper');
const helperPath = index < 0 ? undefined : process.argv[index + 1];
if (!helperPath || !path.isAbsolute(helperPath)) throw new Error('--helper requires an absolute path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-cu-pointer-fixture-'));
const eventsPath = path.join(temp, 'events.txt');
const fixtureLogPath = path.join(temp, 'fixture.log');
const title = `PI CU Pointer Fixture ${randomUUID()}`;
const powershell = `
$ErrorActionPreference = 'Stop'
try {
[IO.File]::WriteAllText($env:PI_CU_FIXTURE_LOG,'starting')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[IO.File]::WriteAllText($env:PI_CU_FIXTURE_LOG,'assemblies loaded')
$form = New-Object System.Windows.Forms.Form
$form.Text = $env:PI_CU_FIXTURE_TITLE
$form.Size = New-Object System.Drawing.Size(520,300)
$form.StartPosition = 'CenterScreen'
$button = New-Object System.Windows.Forms.Button
$button.Text = 'Pointer test button'
$button.SetBounds(100,90,250,80)
$button.Add_MouseUp({ param($sender,$eventArgs) if($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Right){Add-Content -LiteralPath $env:PI_CU_FIXTURE_EVENTS -Value 'right_up'} elseif($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left){Add-Content -LiteralPath $env:PI_CU_FIXTURE_EVENTS -Value 'left_up'} })
$button.Add_Click({ Add-Content -LiteralPath $env:PI_CU_FIXTURE_EVENTS -Value 'activated' })
$form.Controls.Add($button)
$menuButton = New-Object System.Windows.Forms.Button
$menuButton.Text = 'Menu test button'
$menuButton.SetBounds(100,190,250,50)
$menu = New-Object System.Windows.Forms.ContextMenu
$open = New-Object System.Windows.Forms.MenuItem '&Open with'
$choice = New-Object System.Windows.Forms.MenuItem '&Choice'
$choice.Add_Click({ Add-Content -LiteralPath $env:PI_CU_FIXTURE_EVENTS -Value 'menu_selected' })
[void]$open.MenuItems.Add($choice)
[void]$menu.MenuItems.Add($open)
$menuButton.ContextMenu = $menu
$form.Controls.Add($menuButton)
$form.Add_Shown({ [IO.File]::WriteAllText($env:PI_CU_FIXTURE_LOG,'shown'); $form.Activate() })
[void]$form.ShowDialog()
} catch { [IO.File]::WriteAllText($env:PI_CU_FIXTURE_LOG,$_.Exception.ToString()); exit 1 }
`;
const fixture = spawn('powershell.exe', ['-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(powershell,'utf16le').toString('base64')], {
 windowsHide:false, stdio:['ignore','pipe','pipe'], env:{...process.env,PI_CU_FIXTURE_TITLE:title,PI_CU_FIXTURE_EVENTS:eventsPath,PI_CU_FIXTURE_LOG:fixtureLogPath},
});
const helper = spawn(helperPath, [], {windowsHide:true,stdio:['pipe','pipe','pipe']});
const lines = readline.createInterface({input:helper.stdout});
const pending = new Map(); let serial=0; let helperError=''; let fixtureError='';
fixture.stderr.on('data', chunk => { fixtureError=(fixtureError+chunk.toString()).slice(-4000); });
fixture.stdout.on('data', chunk => { fixtureError=(fixtureError+chunk.toString()).slice(-4000); });
fixture.on('error', error => { fixtureError+=`\nfixture spawn: ${error.message}`; });
fixture.on('exit', (code,signal) => { fixtureError+=`\nfixture exit: ${code ?? signal}`; });
helper.stderr.on('data', chunk => { helperError=(helperError+chunk.toString()).slice(-4000); });
lines.on('line', line => {
 let value; try { value=JSON.parse(line); } catch { return; }
 const item=pending.get(value.id); if(item){pending.delete(value.id);clearTimeout(item.timer);item.resolve(value);}
});
function request(cmd,args={}) {
 return new Promise((resolve,reject)=>{
  const id=`fixture-${++serial}`;
  const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout: ${cmd}`));},15000);
  pending.set(id,{resolve,reject,timer});
  helper.stdin.write(JSON.stringify({protocolVersion:4,id,cmd,args})+'\n');
 });
}
function findButton(node, title='Pointer test button') {
 if (!node || typeof node !== 'object') return null;
 if (node.title === title && node.ref) return node;
 for (const child of node.children ?? []) { const found=findButton(child,title); if(found)return found; }
 return null;
}
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const results=[];
try {
 let root, fixtureRoots=[];
 for(let i=0;i<100 && !root;i++) {
  const response=await request('listRoots');
  if(!response.ok)throw new Error(`Root enumeration failed: ${JSON.stringify(response.error)}`);
  root=response.result.roots.find(item=>item.title===title);
  fixtureRoots=response.result.roots.filter(item=>item.pid===fixture.pid).map(item=>({title:item.title,subrole:item.subrole,isOnscreen:item.isOnscreen}));
  if(!root)await sleep(200);
 }
 assert(root, `fixture root not found; roots for fixture PID: ${JSON.stringify(fixtureRoots)}`);
 for(const action of ['click','press']) {
  for(const [button,count] of [['right',1],['left',2]]) {
   const look=await request('look',{rootRef:root.rootRef,includeImage:true});
   assert.equal(look.ok,true,JSON.stringify(look.error));
   const node=findButton(look.result.outline); assert(node,'fixture button not found');
   const args={lookId:look.result.lookId,action,target:{ref:node.ref},params:{button,clickCount:count}};
   fs.rmSync(eventsPath,{force:true});
   const background=await request('act',{...args,policy:'background'});
   assert.equal(background.ok,false, 'background request must not activate the button');
   assert.equal(background.error.code,'foreground_required');
   assert.equal(background.error.preflight?.inputDispatched,false);
   assert.equal(fs.existsSync(eventsPath),false, 'background request dispatched input');
   const foreground=await request('act',{...args,policy:'foreground'});
   assert.equal(foreground.ok,true,JSON.stringify(foreground.error));
   assert.equal(foreground.result.performed?.click?.button,button);
   assert.equal(foreground.result.performed?.click?.count,count);
   await sleep(300);
   const events=fs.existsSync(eventsPath)?fs.readFileSync(eventsPath,'utf8').trim().split(/\r?\n/):[];
   if(button==='right') assert.deepEqual(events,['right_up']);
   else {
    assert.equal(events.filter(event=>event==='left_up').length,2);
    assert(!events.includes('right_up'));
   }
   results.push({action,button,count,background:background.error.code,foreground:foreground.result.outcome,events});
  }
 }
 const look=await request('look',{rootRef:root.rootRef,includeImage:true});
 assert.equal(look.ok,true,JSON.stringify(look.error));
 const menuButton=findButton(look.result.outline,'Menu test button'); assert(menuButton);
 fs.rmSync(eventsPath,{force:true});
 const opened=await request('act',{lookId:look.result.lookId,action:'click',target:{ref:menuButton.ref},params:{button:'right'},policy:'foreground'});
 assert.equal(opened.ok,true,JSON.stringify(opened.error));
 const menus=async()=>{
  const response=await request('listRoots'); assert.equal(response.ok,true,JSON.stringify(response.error));
  return response.result.roots.filter(item=>item.pid===fixture.pid&&item.kind==='menu');
 };
 const parent=(await menus())[0]; assert(parent,'context menu missing');
 const key=async(menu,keys,policy='foreground')=>{
  const observed=await request('look',{rootRef:menu.rootRef,includeImage:false});
  assert.equal(observed.ok,true,JSON.stringify(observed.error));
  return request('act',{lookId:observed.result.lookId,action:'keypress',target:{ref:menu.rootRef},params:{keys},policy});
 };
 const background=await key(parent,['DOWN'],'background');
 assert.equal(background.ok,false);
 assert.equal(background.error.code,'foreground_required');
 assert((await menus()).some(item=>item.windowId===parent.windowId),'background refusal dismissed menu');
 for(const keys of [['DOWN'],['RIGHT']]) {
  const response=await key(parent,keys);
  assert.equal(response.ok,true,JSON.stringify(response.error));
 }
 const submenu=(await menus()).find(item=>item.windowId!==parent.windowId);
 assert(submenu,'foreground keyboard input did not open the submenu');
 const selected=await key(submenu,['ENTER']);
 assert.equal(selected.ok,true,JSON.stringify(selected.error));
 await sleep(300);
 const menuEvents=fs.existsSync(eventsPath)?fs.readFileSync(eventsPath,'utf8').trim().split(/\r?\n/):[];
 assert.deepEqual(menuEvents,['menu_selected'],'menu action must select exactly once');
 assert.equal((await menus()).length,0,'selected menu did not close');
 results.push({action:'native-menu-keyboard',background:background.error.code,events:menuEvents});
 console.log(JSON.stringify({status:'passed',results}));
} catch(error) {
 const fixtureLog=fs.existsSync(fixtureLogPath)?fs.readFileSync(fixtureLogPath,'utf8'):'';
 console.error(`Windows pointer regression failed: ${error.message}\n${helperError}\n${fixtureError}\n${fixtureLog}`);
 process.exitCode=1;
} finally {
 for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error('Helper stopped'));}
 lines.close(); helper.kill(); fixture.kill();
 fs.rmSync(temp,{recursive:true,force:true});
}
