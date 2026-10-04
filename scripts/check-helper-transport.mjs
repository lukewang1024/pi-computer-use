// New transport regression coverage using an actual subprocess speaking the
// helper protocol. No desktop helper or physical input is involved.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
const cache=process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache');await fs.mkdir(cache,{recursive:true});
const root=await fs.mkdtemp(path.join(cache,'cu-helper-transport-test-'));
const helper=path.join(root,'fake-helper');
const linuxHelperPath=path.join(root,'linux-helper');
const closedPipeHelper=path.join(root,'closed-pipe-helper');
const closedPipeScript=`#!/bin/sh
IFS= read -r request || exit 1
exec 0<&-
node -e 'const r=JSON.parse(process.argv[1]);console.log(JSON.stringify({id:r.id,protocolVersion:r.protocolVersion,ok:true,result:r.args.value}));' "$request" || exit 1
exec sleep 60
`;
await fs.writeFile(helper,`#!/usr/bin/env node
const readline=require('node:readline');
const fs=require('node:fs');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.cmd==='exit')return process.exit(0);
 if(r.cmd==='silent')return;
 if(r.cmd==='stderr-pressure'){const chunk=Buffer.alloc(65536,120);for(let i=0;i<64;i++)fs.writeSync(2,chunk);}
 const value={id:r.id,protocolVersion:r.cmd==='wrong-version'?99:r.protocolVersion,ok:true,result:r.args.value};
 const output=JSON.stringify(value)+'\\n';
 setTimeout(()=>{process.stdout.write('not-json\\n');process.stdout.write(output.slice(0,9));setTimeout(()=>process.stdout.write(output.slice(9)),1);},r.args.delay||0);
});
`,{mode:0o755});
await fs.copyFile(helper,linuxHelperPath);
await fs.writeFile(closedPipeHelper,closedPipeScript,{mode:0o755});
execFileSync('/bin/sh',['-n',closedPipeHelper]);
const prior=process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH;process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH=helper;
const {WindowsHelperClient}=await import('../src/platform/windows/helper.ts');
const client=new WindowsHelperClient();
// This suite deliberately bypasses installer behavior, covered separately.
client.ensureInstalled=async()=>{};
try{
 assert.equal(await client.command('stderr-pressure',{value:'windows-drained'},{timeoutMs:3000}),'windows-drained');
 assert.equal(await client.command('echo',{value:'fragmented'}),'fragmented');
 const slow=client.command('echo',{value:'slow',delay:30});
 const fast=client.command('echo',{value:'fast'});
 assert.deepEqual(await Promise.all([slow,fast]),['slow','fast']);
 await assert.rejects(()=>client.command('wrong-version',{}),/protocol mismatch/);
 const cancelled=new AbortController();cancelled.abort();
 await assert.rejects(()=>client.command('exit',{}, {signal:cancelled.signal}),/before dispatch/);
 assert.equal(await client.command('echo',{value:'still-alive'}),'still-alive');
 const active=new AbortController();const pending=client.command('silent',{}, {signal:active.signal,timeoutMs:300});
 await new Promise(resolve=>setTimeout(resolve,10));active.abort();
 await assert.rejects(()=>pending,/aborted after dispatch.*unknown/);
 assert.equal(await client.command('echo',{value:'other-request'}),'other-request','one cancellation must not kill unrelated requests');
 await assert.rejects(()=>client.command('echo',{value:'late',delay:40},{timeoutMs:5}),/timed out.*unknown/);
 await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal(await client.command('echo',{value:'after-late'}),'after-late');
 await assert.rejects(()=>client.command('exit',{}, {timeoutMs:300}),error=>{assert.match(error.message,/helper exited.*unknown/);assert.equal(error.code,'helper_transport_unknown');assert.equal(error.outcome,'unknown');assert.equal(error.command,'exit');assert.equal(typeof error.requestId,'string');assert.equal(error.requestWriteAttempted,true);return true;});
 assert.equal(await client.command('echo',{value:'fresh-process'}),'fresh-process','a later explicit command may start a new helper');
 client.dispose();
 // Closing Node's active stdin FD directly is not portable across libuv runtimes.
 // A POSIX helper closes its input and stays alive with the same PID.
 await fs.writeFile(helper,closedPipeScript,{mode:0o755});
 assert.equal(await client.command('close-input',{value:'closed'}),'closed');
 assert.equal(client.child.exitCode,null,'closed-input fixture must remain alive');
 await assert.rejects(()=>client.command('echo',{value:'broken-pipe'},{timeoutMs:300}),error=>{assert.equal(error.code,'helper_transport_unknown');assert.equal(error.outcome,'unknown');assert.match(error.message,/EPIPE|ECONNRESET/);return true;});
 await new Promise(resolve=>setTimeout(resolve,20));
 assert.equal(await client.command('echo',{value:'after-broken-pipe'}),'after-broken-pipe');
 const {LinuxHelperClient}=await import('../src/platform/linux/helper.ts');
 const linux=new LinuxHelperClient({helperPath:linuxHelperPath});linux.ensureInstalled=async()=>{};
 try {assert.equal(await linux.command('stderr-pressure',{value:'linux-drained'},{timeoutMs:3000}),'linux-drained');assert.equal(await linux.command('echo',{value:'linux-after-pressure'}),'linux-after-pressure');} finally {linux.dispose();}
 const closedLinux=new LinuxHelperClient({helperPath:closedPipeHelper});closedLinux.ensureInstalled=async()=>{};
 try {assert.equal(await closedLinux.command('close-input',{value:'closed'}),'closed');assert.equal(closedLinux.child.exitCode,null,'closed-input fixture must remain alive');await assert.rejects(()=>closedLinux.command('echo',{value:'broken-pipe'},{timeoutMs:300}),error=>{assert.equal(error.code,'helper_transport_unknown');assert.equal(error.outcome,'unknown');assert.match(error.message,/EPIPE|ECONNRESET/);return true;});} finally {closedLinux.dispose();}
 console.log('Helper subprocess transport regression checks passed (new coverage; no desktop input)');
}finally{client.dispose();if(prior===undefined)delete process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH;else process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH=prior;await fs.rm(root,{recursive:true,force:true});}
