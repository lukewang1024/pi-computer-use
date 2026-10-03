import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executableSha256, packagedHelperSha256, helperIdentityMatches } from '../src/platform/macos/helper-identity.ts';

const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
await fs.mkdir(cache, { recursive: true });
const dir = await fs.mkdtemp(path.join(cache, 'cu-build-identity-'));
const priorSocket = process.env.PI_CU_SOCKET_PATH;
process.env.PI_CU_SOCKET_PATH = path.join(dir, 'externally-owned.sock');
try {
 const arm = path.join(dir, 'prebuilt/macos/arm64/bridge');
 const universal = path.join(dir, 'prebuilt/macos/universal/pi-computer-use.app/Contents/MacOS/bridge');
 await fs.mkdir(path.dirname(arm), { recursive: true });
 await fs.writeFile(arm, 'old');
 const oldSha = await executableSha256(arm);
 await fs.mkdir(path.dirname(universal), { recursive: true });
 await fs.writeFile(universal, 'new');
 const sha = await packagedHelperSha256(dir, 'arm64');
 assert.equal(sha, await executableSha256(universal), 'universal selection matches installer');
 assert.notEqual(sha, oldSha);
 assert.equal(helperIdentityMatches(6, true, sha, sha), true);
 for (const [protocol, matches, digest] of [[6,true,oldSha],[6,true,undefined],[6,false,sha],[5,true,sha]]) {
  assert.equal(helperIdentityMatches(protocol, matches, sha, digest), false);
 }
 const { MacosHelperClient, HELPER_APP_EXECUTABLE_PATH } = await import('../src/platform/macos/helper.ts');
 const client = new MacosHelperClient();
 let requests = [], runningSha = oldSha;
 // Model a daemon whose path and protocol remain unchanged after disk update.
 client.expectedHelperSha256 = async () => sha;
 client.command = async cmd => {
  requests.push(cmd);
  assert.equal(cmd, 'diagnostics', 'external mismatch cannot issue shutdown or input');
  return {protocolVersion:6,pid:123,executablePath:HELPER_APP_EXECUTABLE_PATH,executableSha256:runningSha};
 };
 await assert.rejects(() => client.ensureProtocol(), /helper build mismatch/);
 assert.deepEqual(requests, ['diagnostics']);
 runningSha = undefined;
 await assert.rejects(() => client.ensureProtocol(), /running unknown/);
 runningSha = sha;
 const d = await client.ensureProtocol();
 assert.equal(d.executableSha256, sha);
 await assert.rejects(() => client.restart(), /owner must restart/);
 assert(requests.every(cmd => cmd === 'diagnostics'));
 console.log('macOS package/running helper build identity regression checks passed');
} finally {
 if (priorSocket === undefined) delete process.env.PI_CU_SOCKET_PATH; else process.env.PI_CU_SOCKET_PATH = priorSocket;
 await fs.rm(dir, {recursive:true,force:true});
}
