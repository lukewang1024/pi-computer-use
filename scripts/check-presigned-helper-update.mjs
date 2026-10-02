// Newly authored installer regression coverage. Signature callbacks model
// verifier outcomes; these tests do not validate a real macOS signature.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {installPrebuiltHelperApp} from './setup-helper.mjs';
const cache=process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache');
await fs.mkdir(cache,{recursive:true});
const root=await fs.mkdtemp(path.join(cache,'cu-signed-update-test-'));
const source=path.join(root,'candidate.app'),installed=path.join(root,'installed.app');
async function bundle(dir,bytes){await fs.mkdir(path.join(dir,'Contents','MacOS'),{recursive:true});await fs.writeFile(path.join(dir,'Contents','MacOS','bridge'),bytes);await fs.writeFile(path.join(dir,'Contents','Info.plist'),'fixed-info');}
let invalidSignature=false,changedIdentity=false,registered=0;
const options={installPath:installed,
 async verifySignature(dir){if(invalidSignature&&dir===source)throw Error('Invalid candidate signature');},
 async readRequirement(dir){return changedIdentity&&dir===source?'different-identity':'fixed-identity';},
 async readPinnedIdentity(){return undefined;},
 async copyBundle(a,b){await fs.cp(a,b,{recursive:true});},
 async register(){registered++;}};
try{
 await bundle(source,'new-helper');await bundle(installed,'old-helper');
 assert.equal(await installPrebuiltHelperApp(source,options),true);
 assert.equal(await fs.readFile(path.join(installed,'Contents','MacOS','bridge'),'utf8'),'new-helper');
 assert.equal(registered,1);
 assert.equal(await installPrebuiltHelperApp(source,options),false,'identical bundle should not be replaced');
 await bundle(source,'next-helper');invalidSignature=true;
 await assert.rejects(()=>installPrebuiltHelperApp(source,options),/Invalid candidate signature/);
 assert.equal(await fs.readFile(path.join(installed,'Contents','MacOS','bridge'),'utf8'),'new-helper');
 invalidSignature=false;changedIdentity=true;
 await assert.rejects(()=>installPrebuiltHelperApp(source,options),/different designated requirement/);
 assert.equal(await fs.readFile(path.join(installed,'Contents','MacOS','bridge'),'utf8'),'new-helper');
 assert.equal(registered,2,'rejected updates must never register candidate');
 console.log('Pre-signed helper update regression checks passed (modeled signature outcomes)');
}finally{await fs.rm(root,{recursive:true,force:true});}
