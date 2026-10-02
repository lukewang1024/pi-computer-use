import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executableSha256 } from '../src/platform/macos/helper-identity.ts';

const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
await fs.mkdir(cache, {recursive:true});
const dir = await fs.mkdtemp(path.join(cache, 'cu-owned-build-'));
const priorApp = process.env.PI_COMPUTER_USE_HELPER_APP_PATH;
const priorSocket = process.env.PI_CU_SOCKET_PATH;
delete process.env.PI_CU_SOCKET_PATH;
process.env.PI_COMPUTER_USE_HELPER_APP_PATH = path.join(dir, 'helper.app');
try {
 const {MacosHelperClient, HELPER_APP_EXECUTABLE_PATH} = await import('../src/platform/macos/helper.ts');
 await fs.mkdir(path.dirname(HELPER_APP_EXECUTABLE_PATH), {recursive:true});
 await fs.writeFile(HELPER_APP_EXECUTABLE_PATH, 'new build', {mode:0o755});
 const expected = await executableSha256(HELPER_APP_EXECUTABLE_PATH);
 const client = new MacosHelperClient();
 client.expectedHelperSha256 = async () => expected;
 let running = '0'.repeat(64), commands = [];
 client.command = async cmd => {
  commands.push(cmd);
  if (cmd === 'shutdown') {running = expected; return {};}
  assert.equal(cmd, 'diagnostics');
  return {protocolVersion:6,pid:123,executablePath:HELPER_APP_EXECUTABLE_PATH,executableSha256:running};
 };
 client.ensureDaemon = async () => true;
 await client.ensureInstalled();
 assert.equal(commands.length, 0, 'matching disk fast path performs no native calls/install');
 assert.equal((await client.ensureProtocol()).executableSha256, expected);
 assert.equal(commands.filter(c => c === 'shutdown').length, 1, 'same-path stale daemon restarts once');
 commands = [];
 await client.ensureProtocol();
 assert.deepEqual(commands, ['diagnostics'], 'matching live build has no restart');
 await fs.writeFile(HELPER_APP_EXECUTABLE_PATH, 'stale disk');
 await assert.rejects(() => client.ensureInstalled(), /build is stale/);
 running = '0'.repeat(64); commands = [];
 await assert.rejects(() => client.ensureProtocol(), /build mismatch/);
 assert.deepEqual(commands, ['diagnostics'], 'stale disk cannot relaunch a wrong build');
 console.log('macOS owned stale-daemon restart and matching fast path checks passed');
} finally {
 if (priorApp === undefined) delete process.env.PI_COMPUTER_USE_HELPER_APP_PATH; else process.env.PI_COMPUTER_USE_HELPER_APP_PATH = priorApp;
 if (priorSocket === undefined) delete process.env.PI_CU_SOCKET_PATH; else process.env.PI_CU_SOCKET_PATH = priorSocket;
 await fs.rm(dir, {recursive:true,force:true});
}
