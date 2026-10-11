import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ManagedBrowser } from '../src/managed-browser.ts';
import { executeLaunchBrowser, shutdownComputerUseSession } from '../src/bridge.ts';
import { currentPlatformBackend } from '../src/platform/index.ts';
import { CdpTab } from '../src/cdp.ts';

const fixture = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const profile = process.argv.find(a => a.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
HANDLER
fs.writeFileSync(path.join(profile, 'ready'), 'ready');
setInterval(() => {}, 1000);
`;
const canceled = new AbortController(); canceled.abort(new Error('canceled before launch'));
await assert.rejects(ManagedBrowser.launch(process.execPath, 'chrome', [], canceled.signal), /canceled before launch/);
async function launch(handler = '') {
 const browser = await ManagedBrowser.launch(process.execPath, 'chrome', ['-e', fixture.replace('HANDLER', handler), '--']);
 const deadline = Date.now() + 4000;
 while (Date.now() < deadline) {
  try { await access(path.join(browser.profileDir, 'ready')); return browser; }
  catch { await new Promise(r => setTimeout(r, 10)); }
 }
 await browser.close(); throw new Error('Owned test child did not become ready');
}
async function absent(p) { await assert.rejects(access(p), { code: 'ENOENT' }); }
async function ensureStopped(browser) {
 if (browser.child.exitCode === null && browser.child.signalCode === null) {
  browser.child.ref();
  const ended = once(browser.child, 'exit'); browser.child.kill('SIGKILL'); await ended;
 }
}

const first = await launch(), second = await launch();
assert.notEqual(first.profileDir, second.profileDir, 'Each launch must allocate a fresh profile independently of port reuse');
try {
 await Promise.all([first.close(), first.close()]);
 await absent(first.profileDir);
 assert(first.child.exitCode !== null || first.child.signalCode !== null, 'Close must prove exact child exit');
 assert.equal(second.child.exitCode, null, 'Closing one browser must leave other owned/external processes untouched');
 assert.equal(second.child.signalCode, null);
 await access(second.profileDir);
 await first.close(); // Idempotent; never signal an exited child or reused PID.
} finally { await first.close(); await second.close(); }

const failed = await ManagedBrowser.launch(process.execPath + '.missing-cu-executable', 'helium', ['--']);
await once(failed.child, 'error');
await failed.close(); await absent(failed.profileDir);

if (process.platform !== 'win32') {
 const delayed = await launch("process.on('SIGTERM', () => setTimeout(() => process.exit(0), 120));");
 let resolved = false;
 const closing = delayed.close().then(() => { resolved = true; });
 await new Promise(r => setTimeout(r, 30));
 assert.equal(resolved, false, 'Sending SIGTERM is not child exit evidence');
 await access(delayed.profileDir);
 await closing; await absent(delayed.profileDir);

 const stuck = await launch("process.on('SIGTERM', () => {});");
 const originalKill = stuck.child.kill.bind(stuck.child); let stops = 0;
 stuck.child.kill = (signal) => { stops++; return originalKill(signal); };
 try {
  await assert.rejects(stuck.close(60), /did not exit.*profile retained; do not relaunch/);
  assert.equal(stuck.child.exitCode, null); assert.equal(stuck.child.signalCode, null);
  await access(stuck.profileDir);
  await assert.rejects(stuck.close(60), /did not exit/);
  assert.equal(stops, 1, 'Reconciliation must not repeat an uncertain stop');
  stuck.child.ref();
  const exited = once(stuck.child, 'exit'); originalKill('SIGKILL'); await exited;
  await stuck.close(); await absent(stuck.profileDir);
  assert.equal(stops, 1, 'An independently observed exit allows cleanup without replay');
 } finally { await ensureStopped(stuck); await stuck.close(); }
}

const external = await mkdtemp(path.join(os.tmpdir(), 'cu-profile-external-'));
await writeFile(path.join(external, 'keep'), 'unowned');
const nested = await launch();
try {
 await symlink(external, path.join(nested.profileDir, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
 await nested.close(); await absent(nested.profileDir);
 assert.equal(await readFile(path.join(external, 'keep'), 'utf8'), 'unowned', 'Cleanup must not follow nested symlinks');
} finally { await ensureStopped(nested); await nested.close(); }
const swapped = await launch(), original = swapped.profileDir + '-original';
try {
 await rename(swapped.profileDir, original);
 await symlink(external, swapped.profileDir, process.platform === 'win32' ? 'junction' : 'dir');
 await assert.rejects(swapped.close(), /profile identity changed/);
 assert.equal(await readFile(path.join(external, 'keep'), 'utf8'), 'unowned');
 await access(original);
} finally {
 await ensureStopped(swapped);
 await rm(swapped.profileDir, { force: true });
 await rm(original, { recursive: true, force: true });
 await rm(external, { recursive: true, force: true });
}
console.log('Managed browser lifecycle: unique profiles, confirmed exit, bounded reconciliation, spawn failure, and symlink-safe cleanup passed.');

// Public bridge startup failure must close its owner, and an uncertain close
// must block replacement before a second launch. No native input is possible.
const saved = { launch: ManagedBrowser.launch, fetch: globalThis.fetch,
 connect: CdpTab.connect,
 ready: currentPlatformBackend.ensureReady, shutdown: currentPlatformBackend.shutdown,
 executable: process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE, port: process.env.PI_COMPUTER_USE_CDP_PORT };
let owner, launches = 0, blocked = false;
currentPlatformBackend.ensureReady = async () => ({ lastPermissionCheckAt: Date.now() });
currentPlatformBackend.shutdown = async () => {};
process.env.PI_COMPUTER_USE_CHROME_EXECUTABLE = process.execPath;
process.env.PI_COMPUTER_USE_CDP_PORT = 'external-browser-port';
globalThis.fetch = async () => ({ ok: true, json: async () => [] });
ManagedBrowser.launch = async () => {
 launches++;
 // Temporarily restore the original factory used by the child fixture helper.
 ManagedBrowser.launch = saved.launch;
 try { owner = await launch(blocked ? "process.on('SIGTERM', () => {});" : ''); }
 finally { ManagedBrowser.launch = factory; }
 const close = owner.close.bind(owner); owner.close = () => close(60);
 return owner;
};
const factory = ManagedBrowser.launch;
const tool = () => executeLaunchBrowser('lifecycle-test', {}, undefined, undefined, { cwd: process.cwd() });
try {
 await assert.rejects(tool(), /without a CDP page context/);
 await absent(owner.profileDir);
 assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, 'external-browser-port');
 if (process.platform !== 'win32') {
  blocked = true;
  await assert.rejects(tool(), /shutdown is unverified; ownership retained/);
  await access(owner.profileDir);
  const port = process.env.PI_COMPUTER_USE_CDP_PORT;
  assert.notEqual(port, 'external-browser-port');
  await assert.rejects(tool(), /did not exit/);
  assert.equal(launches, 2, 'Failed cleanup must prevent a new browser launch');
  await assert.rejects(shutdownComputerUseSession(), /did not exit/);
  assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, port, 'Unverified shutdown must retain the owned port');
  await ensureStopped(owner);
  await shutdownComputerUseSession();
  await absent(owner.profileDir);
  assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, 'external-browser-port');
 }
 blocked = false;
 globalThis.fetch = async () => ({ ok: true, json: async () => [{ id: 'owned-page', type: 'page', title: 'Owned fixture', url: 'about:blank',
  webSocketDebuggerUrl: `ws://127.0.0.1:${process.env.PI_COMPUTER_USE_CDP_PORT}/devtools/page/owned-page` }] });
 CdpTab.connect = async () => ({ isOpen: true, accessibilityCoverage: {},
  evaluate: async () => '', accessibilityTree: async () => [], close() { this.isOpen = false; } });
 const observed = await tool();
 assert.deepEqual(observed.details.managedBrowser, { pid: owner.child.pid, profileDirectory: owner.profileDir });
 const timing = observed.details.diagnostics.launchTimings;
 assert(timing && Object.values(timing).every(value => Number.isFinite(value) && value >= 0));
 for (const key of ['executableResolutionMs','portAllocationMs','downloadPreparationMs',
  'previousBrowserCloseMs','spawnMs','cdpReadyMs','pageDiscoveryMs','initialObservationMs','totalMs']) {
  assert.equal(typeof timing[key], 'number', key);
 }
 assert(Object.entries(timing).filter(([key]) => key !== 'totalMs').reduce((sum,[,value]) => sum+value,0) <= timing.totalMs+1,
  'Sequential launch phases must fit within the measured operation');
 const replaced = owner;
 await tool();
 await absent(replaced.profileDir);
 assert(replaced.child.exitCode !== null || replaced.child.signalCode !== null, 'Replacement waits for the previous owned child');
 await access(owner.profileDir);
 await shutdownComputerUseSession(); await absent(owner.profileDir);
 assert.equal(process.env.PI_COMPUTER_USE_CDP_PORT, 'external-browser-port', 'Replacing an owned browser preserves the original external endpoint');
} finally {
 if (owner) await ensureStopped(owner);
 await shutdownComputerUseSession();
 ManagedBrowser.launch = saved.launch; globalThis.fetch = saved.fetch;
 CdpTab.connect = saved.connect;
 currentPlatformBackend.ensureReady = saved.ready; currentPlatformBackend.shutdown = saved.shutdown;
 for (const [key, value] of [['PI_COMPUTER_USE_CHROME_EXECUTABLE', saved.executable], ['PI_COMPUTER_USE_CDP_PORT', saved.port]]) {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
 }
}
console.log('Public bridge lifecycle: startup failure cleans up; uncertain exit blocks relaunch and retains ownership for reconciliation.');

// Exercise transient filesystem errors after real owned subprocess exit.
// The hook is scoped to this exact freshly allocated profile, never other paths.
async function cleanupFailureCase(codes, expectedAttempts, expectedFailure) {
 const browser = await launch(), original = fs.promises.rm;
 const kill = browser.child.kill.bind(browser.child); let signals = 0, attempts = 0;
 browser.child.kill = (...args) => { signals++; return kill(...args); };
 fs.promises.rm = async (target, options) => {
  if (target !== browser.profileDir) return original(target, options);
  attempts++;
  const code = codes[attempts - 1];
  if (code) throw Object.assign(new Error('owned fixture ' + code), { code });
  return original(target, options);
 };
 syncBuiltinESMExports();
 try {
  if (expectedFailure) { await assert.rejects(browser.close(), { code: expectedFailure }); await access(browser.profileDir); }
  else { await browser.close(); await absent(browser.profileDir); }
  assert.equal(attempts, expectedAttempts); assert.equal(signals, 1, 'Filesystem retries never repeat child signaling');
  assert(browser.child.exitCode !== null || browser.child.signalCode !== null);
 } finally {
  fs.promises.rm = original; syncBuiltinESMExports(); await ensureStopped(browser);
  await original(browser.profileDir, { recursive: true, force: true });
 }
}
await cleanupFailureCase(['ENOTEMPTY', 'EBUSY'], 3);
await cleanupFailureCase(['ENOTEMPTY', 'ENOTEMPTY', 'ENOTEMPTY', 'ENOTEMPTY'], 4, 'ENOTEMPTY');
await cleanupFailureCase(['EPERM'], 1, 'EPERM');

const changed = await launch(), originalRemoval = fs.promises.rm;
const backup = changed.profileDir + '-original'; let changedAttempts = 0;
fs.promises.rm = async (target, options) => {
 if (target !== changed.profileDir) return originalRemoval(target, options);
 changedAttempts++;
 await rename(changed.profileDir, backup);
 await fs.promises.mkdir(changed.profileDir);
 await writeFile(path.join(changed.profileDir, 'foreign-marker'), 'preserve');
 throw Object.assign(new Error('owned fixture ENOTEMPTY'), { code: 'ENOTEMPTY' });
};
syncBuiltinESMExports();
try {
 await assert.rejects(changed.close(), /profile identity changed/);
 assert.equal(changedAttempts, 1, 'Changed inode blocks the next recursive removal');
 assert.equal(await readFile(path.join(changed.profileDir, 'foreign-marker'), 'utf8'), 'preserve');
} finally {
 fs.promises.rm = originalRemoval; syncBuiltinESMExports(); await ensureStopped(changed);
 await originalRemoval(changed.profileDir, { recursive: true, force: true });
 await originalRemoval(backup, { recursive: true, force: true });
}
console.log('Bounded owned-profile cleanup retries verified');
