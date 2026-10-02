// Newly authored build-input invalidation regressions; no compiler is invoked.
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createLocalMacBuildInput} from './setup-helper.mjs';
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
 console.log('Local build fingerprint invalidation checks passed (new coverage; no macOS compilation)');
}finally{await fs.rm(root,{recursive:true,force:true});}
