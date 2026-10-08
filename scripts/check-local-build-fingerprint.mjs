// Newly authored build-input invalidation regressions; no compiler is invoked.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createLocalMacBuildInput,verifiedLocalMacHelperSha256} from './setup-helper.mjs';
import {createHash} from 'node:crypto';
const cache=process.env.XDG_CACHE_HOME||path.join(os.homedir(),'.cache');await fs.mkdir(cache,{recursive:true});
const root=await fs.mkdtemp(path.join(cache,'cu-build-fingerprint-test-'));
const a=path.join(root,'a.swift'),b=path.join(root,'b.swift'),rules=path.join(root,'installer.mjs');
try{
 await fs.writeFile(a,'first source');await fs.writeFile(b,'second source');await fs.writeFile(rules,'installer rules');
 const options={sourcePaths:[a,b],repositoryRoot:root,installerRulesPath:rules,toolchainIdentity:{sdkVersion:'fixed-sdk',swiftcSha256:'fixed-compiler'},getVersion:async()=> 'fixture-version'};
 const baseline=await createLocalMacBuildInput('arm64',options);
 assert.match(baseline.fingerprint,/^[a-f0-9]{64}$/);
 assert.equal((await createLocalMacBuildInput('arm64',{...options,sourcePaths:[b,a]})).fingerprint,baseline.fingerprint,'enumeration order must not change fingerprint');
 for(const changed of [
  {...options,toolchainIdentity:{...options.toolchainIdentity,swiftcSha256:'new-compiler'}},
  {...options,toolchainIdentity:{...options.toolchainIdentity,sdkVersion:'new-sdk'}},
  {...options,getVersion:async()=> 'new-version'},
  {...options,compilerArgs:['different-compiler-argument']},
 ])assert.notEqual((await createLocalMacBuildInput('arm64',changed)).fingerprint,baseline.fingerprint);
 assert.notEqual((await createLocalMacBuildInput('x86_64',options)).fingerprint,baseline.fingerprint);
 await fs.writeFile(a,'changed source');
 assert.notEqual((await createLocalMacBuildInput('arm64',options)).fingerprint,baseline.fingerprint);
 await fs.writeFile(a,'first source');await fs.writeFile(rules,'changed installer');
 assert.notEqual((await createLocalMacBuildInput('arm64',options)).fingerprint,baseline.fingerprint);
 const app=path.join(root,'local.app'),resources=path.join(app,'Contents/Resources');
 await fs.mkdir(resources,{recursive:true});await fs.mkdir(path.join(app,'Contents/MacOS'),{recursive:true});
 const executable=path.join(app,'Contents/MacOS/bridge'),metadata=path.join(resources,'local-build-input.json');
 const identity='A'.repeat(40),input=await createLocalMacBuildInput('arm64',options);
 await fs.writeFile(executable,'locally compiled signed binary');
 await fs.writeFile(metadata,JSON.stringify(input,null,2)+'\n');
 await fs.writeFile(path.join(resources,'signing-identity.sha1'),identity+'\n');
 let signatureChecks=0;
 const verifyOptions={arch:'arm64',buildInputProvider:arch=>createLocalMacBuildInput(arch,options),
  readPinnedIdentity:async()=>identity,readInstalledIdentity:async()=>identity,
  verifySignature:async candidate=>{assert.equal(candidate,app);signatureChecks++;}};
 const digest=await verifiedLocalMacHelperSha256(app,verifyOptions);
 assert.equal(digest,createHash('sha256').update(await fs.readFile(executable)).digest('hex'));
 assert.equal(signatureChecks,1,'a matching build seal alone cannot admit a helper');
 await fs.writeFile(a,'source changed after deployment');
 await assert.rejects(()=>verifiedLocalMacHelperSha256(app,verifyOptions),/build inputs/);
 await fs.writeFile(a,'first source');
 await assert.rejects(()=>verifiedLocalMacHelperSha256(app,{...verifyOptions,readPinnedIdentity:async()=>undefined}),/pinned signing/);
 await assert.rejects(()=>verifiedLocalMacHelperSha256(app,{...verifyOptions,readInstalledIdentity:async()=>'B'.repeat(40)}),/signature differs/);
 await assert.rejects(()=>verifiedLocalMacHelperSha256(app,{...verifyOptions,verifySignature:async()=>{throw new Error('broken resource seal');}}),/broken resource seal/);
 await fs.writeFile(path.join(resources,'signing-identity.sha1'),'B'.repeat(40));
 await assert.rejects(()=>verifiedLocalMacHelperSha256(app,verifyOptions),/pinned signing/);
 console.log('Local build fingerprint invalidation checks passed (new coverage; no macOS compilation)');
}finally{await fs.rm(root,{recursive:true,force:true});}
