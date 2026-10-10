// Newly authored build-input invalidation regressions; no compiler is invoked.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createLocalMacBuildInput,verifiedLocalMacHelperSha256,localMacBuildInputsCompatible,helperInfoPlist,installLocalMacBuild} from './setup-helper.mjs';
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
 const sdkUpgrade=await createLocalMacBuildInput('arm64',{...options,getVersion:async()=> 'new-version'});
 assert.notEqual(sdkUpgrade.fingerprint,baseline.fingerprint,'package provenance remains version-specific');
 assert.equal(localMacBuildInputsCompatible(baseline,sdkUpgrade),true,'SDK-only changes reuse the native component');
 for(const changed of [
  {...options,toolchainIdentity:{...options.toolchainIdentity,swiftcSha256:'new-compiler'}},
  {...options,toolchainIdentity:{...options.toolchainIdentity,sdkVersion:'new-sdk'}},
  {...options,getVersion:async()=> 'new-version'},
  {...options,compilerArgs:['different-compiler-argument']},
 ]) {
  const next=await createLocalMacBuildInput('arm64',changed);
  assert.notEqual(next.fingerprint,baseline.fingerprint);
  if(!changed.getVersion || changed.getVersion===options.getVersion)assert.equal(localMacBuildInputsCompatible(baseline,next),false);
 }
 assert.notEqual((await createLocalMacBuildInput('x86_64',options)).fingerprint,baseline.fingerprint);
 assert.equal(localMacBuildInputsCompatible(baseline,await createLocalMacBuildInput('x86_64',options)),false);
 await fs.writeFile(a,'changed source');
 assert.notEqual((await createLocalMacBuildInput('arm64',options)).fingerprint,baseline.fingerprint);
 assert.equal(localMacBuildInputsCompatible(baseline,await createLocalMacBuildInput('arm64',options)),false);
 await fs.writeFile(a,'first source');await fs.writeFile(rules,'changed installer');
 assert.notEqual((await createLocalMacBuildInput('arm64',options)).fingerprint,baseline.fingerprint);
 assert.equal(localMacBuildInputsCompatible(baseline,await createLocalMacBuildInput('arm64',options)),false);
 const app=path.join(root,'local.app'),resources=path.join(app,'Contents/Resources');
 await fs.mkdir(resources,{recursive:true});await fs.mkdir(path.join(app,'Contents/MacOS'),{recursive:true});
 const executable=path.join(app,'Contents/MacOS/bridge'),metadata=path.join(resources,'local-build-input.json');
 const identity='A'.repeat(40),input=await createLocalMacBuildInput('arm64',options);
 await fs.writeFile(executable,'locally compiled signed binary');
 await fs.writeFile(metadata,JSON.stringify(input,null,2)+'\n');
 await fs.writeFile(path.join(app,'Contents/Info.plist'),helperInfoPlist('fixture-version'));
 await fs.writeFile(path.join(resources,'signing-identity.sha1'),identity+'\n');
 let signatureChecks=0;
 const verifyOptions={arch:'arm64',buildInputProvider:arch=>createLocalMacBuildInput(arch,options),
  readPinnedIdentity:async()=>identity,readInstalledIdentity:async()=>identity,
  verifySignature:async candidate=>{assert.equal(candidate,app);signatureChecks++;}};
 const digest=await verifiedLocalMacHelperSha256(app,verifyOptions);
 assert.equal(digest,createHash('sha256').update(await fs.readFile(executable)).digest('hex'));
 assert.equal(signatureChecks,1,'a matching build seal alone cannot admit a helper');
 const nextOptions={...options,getVersion:async()=> 'new-version'};
 assert.equal(await verifiedLocalMacHelperSha256(app,{...verifyOptions,buildInputProvider:arch=>createLocalMacBuildInput(arch,nextOptions)}),digest);
 const before=await fs.readFile(metadata);
 const reused=await installLocalMacBuild({arch:'arm64',installPath:app,getVersion:nextOptions.getVersion,
  buildInputProvider:arch=>createLocalMacBuildInput(arch,nextOptions),readPinnedIdentity:async()=>identity,
  resolveSigningIdentity:async()=>identity,checkIdentityAvailable:async()=>true,readInstalledIdentity:async()=>identity,
  readRequirement:async()=> 'signed fixture requirement',verifySignature:verifyOptions.verifySignature,register:async()=>{},
  compileHelper:async()=>{throw Error('SDK-only upgrade must not compile');},signBundle:async()=>{throw Error('SDK-only upgrade must not sign');}});
 assert.equal(reused,false);
 assert.deepEqual(await fs.readFile(metadata),before,'retain original signed package provenance');
 assert.equal(createHash('sha256').update(await fs.readFile(executable)).digest('hex'),digest);
 await fs.writeFile(path.join(app,'Contents/Info.plist'),helperInfoPlist('new-version'));
 await assert.rejects(()=>verifiedLocalMacHelperSha256(app,verifyOptions),/build inputs/,'bundle metadata must match its original seal');
 await fs.writeFile(path.join(app,'Contents/Info.plist'),helperInfoPlist('fixture-version'));
 const forged=structuredClone(input);forged.inputs.sources[0].sha256='0'.repeat(64);
 assert.equal(localMacBuildInputsCompatible(forged,input),false,'reject forged seal fingerprints');
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
