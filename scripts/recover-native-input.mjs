#!/usr/bin/env node
// Native administrative recovery. No key-downs, action replay, queue content updates,
// availability changes or user application shutdown are performed here.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, open, unlink, writeFile, link, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { resolveMacosHelperAppPath } from '../src/platform/macos/helper-path.mjs';
import { verifiedLocalMacHelperSha256 } from './setup-helper.mjs';

const execute = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const uid = () => process.getuid();

export function validateRecoveryQueue(queue, owner, bootId, epoch = queue.epoch) {
  assert(queue && queue.blocked === true && queue.inFlight === false, 'Recovery requires an idle quarantined native queue');
  assert(owner && queue.maintenanceOwner === owner, 'This operator does not own native maintenance');
  assert(queue.bootId === bootId && typeof bootId === 'string' && bootId.length > 0, 'Kernel boot identity changed');
  assert(Number.isSafeInteger(queue.epoch) && queue.epoch === epoch, 'Native queue epoch changed');
  assert(Array.isArray(queue.jobs) && queue.jobs.every(job => !['active', 'draining'].includes(job.state)), 'A native consumer still owns the desktop');
  return queue;
}

export function observedRecoveryInput(probe) {
  assert(probe?.schemaVersion === 1 && probe.readOnly === true && Array.isArray(probe.samples) && probe.samples.length === 2, 'Invalid native input probe');
  assert.deepEqual(probe.samples.map(sample => sample.source).sort(), [0, 1], 'Both OS input tables are required');
  const keys = new Set(), buttons = new Set();
  for (const sample of probe.samples) {
    assert(Array.isArray(sample.heldKeys) && Array.isArray(sample.heldMouseButtons), 'Incomplete native input sample');
    for (const code of sample.heldKeys) { assert(Number.isInteger(code) && code >= 0 && code <= 127); keys.add(code); }
    for (const button of sample.heldMouseButtons) { assert(Number.isInteger(button) && button >= 0 && button <= 4); buttons.add(button); }
  }
  return { keys: [...keys].sort((a, b) => a - b), mouseButtons: [...buttons].sort((a, b) => a - b) };
}

export function selectRecoveryScope(observed, records, options = {}) {
  const valid = values => Array.isArray(values) && values.every(Number.isInteger) && new Set(values).size === values.length;
  let keys, mouseButtons, mode;
  if (options.scopedReset) {
    assert(typeof options.reason === 'string' && options.reason.trim().length >= 8 && options.reason.length <= 512, 'A scoped repair reason is required');
    assert(valid(options.keys) && valid(options.mouseButtons), 'A scoped reset requires explicit unique key/button codes');
    keys = options.keys; mouseButtons = options.mouseButtons; mode = 'scoped-reset';
  } else {
    const ownedKeys = new Set(), ownedButtons = new Set();
    for (const record of records) {
      assert(record.schemaVersion === 1 && record.scope === 'native_transaction' && valid(record.ownedKeys) && valid(record.ownedMouseButtons), 'Input journal is incomplete');
      assert(record.bootId === options.bootId && options.executables.includes(record.executablePath), 'Input journal belongs to another boot/helper');
      // A prepared down was not acknowledged and is never silently adopted.
      for (const key of record.ownedKeys) ownedKeys.add(key);
      for (const button of record.ownedMouseButtons) ownedButtons.add(button);
    }
    keys = observed.keys.filter(key => ownedKeys.has(key));
    mouseButtons = observed.mouseButtons.filter(button => ownedButtons.has(button)); mode = 'owned-journal';
  }
  assert(keys.length <= 16 && keys.every(key => key >= 0 && key <= 127 && ![57, 63].includes(key)), 'Recovery key scope is invalid');
  assert(mouseButtons.every(button => button >= 0 && button <= 4), 'Recovery button scope is invalid');
  assert(observed.keys.every(key => keys.includes(key)) && observed.mouseButtons.every(button => mouseButtons.includes(button)),
    'Observed input is outside the recorded ownership/reset scope; quarantine retained');
  return { mode, keys: keys.filter(key => observed.keys.includes(key)), mouseButtons: mouseButtons.filter(button => observed.mouseButtons.includes(button)) };
}

export function verifiedNativeResetReceipt(native, scope, operationId, finalProbe) {
  const finalInput = observedRecoveryInput(finalProbe);
  return native?.status === 'verified' && native.operationId === operationId && native.mode === scope.mode
    && native.downEventsDispatched === 0 && native.inputReplayed === false && native.oldHelpersStopped === true
    && native.quarantinePreserved === true && Number.isInteger(native.neutralSamples) && native.neutralSamples >= 2
    && Array.isArray(native.releaseEvents) && native.releaseEvents.length <= scope.keys.length + scope.mouseButtons.length
    && native.releaseEvents.every(event => (event.kind === 'keyUp' && scope.keys.includes(event.code))
      || (event.kind === 'mouseUp' && scope.mouseButtons.includes(event.button)))
    && finalInput.keys.length === 0 && finalInput.mouseButtons.length === 0;
}

async function privateFile(file, max = 1024 * 1024) {
  const status = await lstat(file);
  assert(status.isFile() && !status.isSymbolicLink() && status.uid === uid() && (status.mode & 0o077) === 0 && status.size <= max, 'Recovery state is not a private regular file');
  return await readFile(file);
}

export async function readRecoveryQueue(file, owner, bootId, epoch) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = await handle.stat();
    assert(status.isFile() && status.uid === uid() && (status.mode & 0o022) === 0 && status.size <= 16 * 1024 * 1024,
      'Native queue ownership or permissions are unsafe');
    const queue = validateRecoveryQueue(JSON.parse(await handle.readFile('utf8')), owner, bootId, epoch);
    // Older Fabric versions atomically replaced this file with mode 0644.
    // Harden metadata after admission verification; never change its contents.
    if ((status.mode & 0o077) !== 0) await handle.chmod(0o600);
    return queue;
  } finally { await handle.close(); }
}

async function processIdentity(pid) {
  try {
    const result = await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart=,comm='], { maxBuffer: 8192, timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
    return result.stdout.trim();
  } catch (error) { if (error.code === 1) return null; throw error; }
}

async function helperInventory(executables) {
  const result = await execute('/bin/ps', ['-axww', '-o', 'pid=,comm='], { maxBuffer: 8 * 1024 * 1024, timeout: 5000 });
  const matches = [];
  for (const line of result.stdout.trim().split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    assert(match, 'Native helper process inventory is incomplete');
    if (executables.includes(match[2].trim())) matches.push({ pid: Number(match[1]), identity: await processIdentity(Number(match[1])) });
  }
  return matches;
}

export async function stopOldHelpers(executables, validate, operations = {}) {
  const inventory = operations.inventory || (() => helperInventory(executables));
  const identity = operations.identity || processIdentity;
  const sendSignal = operations.kill || ((pid, signal) => process.kill(pid, signal));
  const pause = operations.pause || (() => new Promise(resolve => setTimeout(resolve, 50)));
  const before = await inventory();
  const signals = [];
  for (const process of before) {
    await validate();
    const current = await identity(process.pid);
    if (current === null) continue;
    assert(current === process.identity, 'Native helper PID was reused; shutdown refused');
    try { sendSignal(process.pid, 'SIGTERM'); signals.push({ pid: process.pid, signal: 'SIGTERM' }); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await inventory()).length === 0) return { inventoryComplete: true, stopped: before, signals, remaining: [] };
    await pause();
  }
  for (const process of before) {
    await validate(); const current = await identity(process.pid);
    if (current === null) continue;
    assert(current === process.identity, 'Native helper PID was reused during shutdown; forced termination refused');
    try { sendSignal(process.pid, 'SIGKILL'); signals.push({ pid: process.pid, signal: 'SIGKILL' }); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await inventory()).length === 0) return { inventoryComplete: true, stopped: before, signals, remaining: [] };
    await pause();
  }
  throw new Error('Old native helper has not stopped; no recovery input was sent');
}

async function acquireRecoveryLock(file, operationId, bootId) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const identity = await processIdentity(process.pid); assert(identity, 'Recovery process identity unavailable');
    await handle.writeFile(JSON.stringify({ pid: process.pid, identity, bootId, operationId })); await handle.sync();
    try { await link(temporary, file); return handle; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const before = await privateFile(file, 8192);
    const owner = JSON.parse(before);
    assert(Number.isInteger(owner.pid) && typeof owner.identity === 'string' && typeof owner.bootId === 'string', 'Recovery lock ownership is incomplete');
    const current = owner.bootId === bootId ? await processIdentity(owner.pid) : null;
    assert(current === null || current !== owner.identity, 'Another recovery process is still running');
    assert((await privateFile(file, 8192)).equals(before), 'Recovery lock changed during reconciliation');
    await writeFile(`${file}.abandoned-${operationId}.json`, before, { mode: 0o600, flag: 'wx' });
    await unlink(file); await link(temporary, file); return handle;
  } catch (error) { await handle.close(); throw error; }
  finally { await unlink(temporary); }
}

export async function recoverNativeInput(options) {
  assert(process.platform === 'darwin', 'Native input recovery is currently supported on macOS');
  const app = await realpath(options.helperApp || resolveMacosHelperAppPath());
  const executable = path.join(app, 'Contents/MacOS/bridge');
  const expected = await verifiedLocalMacHelperSha256(app);
  assert(expected === sha256(await readFile(executable)), 'Selected native helper build identity differs');
  const inspect = async () => {
    const { stdout } = await execute(executable, ['inspect-input'], { maxBuffer: 1024 * 1024, timeout: 15_000, env: process.env });
    const probe = JSON.parse(stdout); assert(probe.executableSha256 === expected, 'Native inspection build identity mismatch');
    observedRecoveryInput(probe); return probe;
  };
  let probe = await inspect();
  if (!options.apply) return { ...probe, observed: observedRecoveryInput(probe) };
  assert(options.queueFile && options.maintenanceOwner && options.receipt, 'Apply requires the managed queue, maintenance owner and private receipt');
  const queueFile = await realpath(options.queueFile);
  assert(path.basename(queueFile) === 'desktop-queue.json', 'Expected the original native desktop queue');
  let queue = await readRecoveryQueue(queueFile, options.maintenanceOwner, probe.bootId);
  const epoch = queue.epoch;
  const validate = async () => { queue = await readRecoveryQueue(queueFile, options.maintenanceOwner, probe.bootId, epoch); };
  const root = path.resolve(probe.journalRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStatus = await lstat(root);
  assert(rootStatus.isDirectory() && !rootStatus.isSymbolicLink() && rootStatus.uid === uid() && (rootStatus.mode & 0o077) === 0, 'Input recovery directory is not private');
  const operationId = options.operationId || randomUUID();
  const lock = await acquireRecoveryLock(path.join(root, 'recovery.lock'), operationId, probe.bootId);
  const planFile = path.join(root, `recovery-${operationId}.json`);
  let attempted = false;
  try {
    const executables = [...new Set([executable, ...(options.oldHelperApps || [resolveMacosHelperAppPath()]).map(app => path.join(path.resolve(app), 'Contents/MacOS/bridge'))])];
    assert(executables.length <= 4);
    const stopped = await stopOldHelpers(executables, validate);
    probe = await inspect(); await validate();
    const records = [];
    const names = (await readdir(root)).filter(name => /^[a-f\d-]{36}\.json$/i.test(name));
    assert(names.length <= 1024, 'Input journal inventory exceeds its bound');
    for (const name of options.scopedReset ? [] : names) {
      if (!/^[a-f\d-]{36}\.json$/i.test(name)) continue;
      const record = JSON.parse(await privateFile(path.join(root, name), 64 * 1024));
      if (record.terminal?.status !== 'verified' && record.bootId === probe.bootId) records.push(record);
    }
    const scope = selectRecoveryScope(observedRecoveryInput(probe), records, { ...options, bootId: probe.bootId, executables });
    const plan = { schemaVersion: 1, operationId, mode: scope.mode, bootId: probe.bootId, queuePath: queueFile,
      queueEpoch: epoch, maintenanceOwner: options.maintenanceOwner, expiresAtMs: Date.now() + 60_000,
      executableSha256: expected, helperExecutables: executables, keys: scope.keys, mouseButtons: scope.mouseButtons,
      reason: options.scopedReset ? options.reason : 'Release input recorded by the native transaction journal' };
    await writeFile(planFile, JSON.stringify(plan), { mode: 0o600, flag: 'wx' });
    await writeFile(options.receipt, JSON.stringify({ operationId, phase: 'started', plan, stoppedOldHelpers: stopped,
      originalInputProbe: probe, inputReplayed: false }), { mode: 0o600, flag: 'wx' });
    attempted = true;
    let stdout;
    try { ({ stdout } = await execute(executable, ['recover-input', '--plan-file', planFile], { maxBuffer: 1024 * 1024, timeout: 20_000, env: process.env })); }
    catch (error) { stdout = error.stdout; if (!stdout) throw error; }
    const native = JSON.parse(stdout);
    const finalProbe = await inspect(); await validate();
    const verified = verifiedNativeResetReceipt(native, scope, operationId, finalProbe);
    const retiredJournals = [];
    if (verified) {
      const retired = path.join(root, 'retired'); await mkdir(retired, { recursive: true, mode: 0o700 });
      for (const name of names) {
        await validate();
        const source = path.join(root, name); const status = await lstat(source);
        assert(status.isFile() && !status.isSymbolicLink() && status.uid === uid(), 'Journal ownership changed');
        const destination = path.join(retired, `${name.slice(0, -5)}.${operationId}.json`);
        await rename(source, destination); retiredJournals.push({ name, destination, bytes: status.size });
      }
    }
    const receipt = { operationId, phase: verified ? 'verified' : native.status === 'unknown' ? 'unknown' : 'blocked', mode: scope.mode, native,
      stoppedOldHelpers: stopped, retiredJournals, finalProbe, quarantinePreserved: true, inputReplayed: false };
    await writeFile(options.receipt, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    return receipt;
  } catch (error) {
    if (attempted) await writeFile(options.receipt, JSON.stringify({ operationId, phase: 'unknown', inputReplayed: false,
      quarantinePreserved: true, error: String(error), instruction: 'Inspect existing receipt and system state; do not replay the interrupted action' }) + '\n', { mode: 0o600 });
    throw error;
  } finally {
    const owned = await lock.stat(); const current = await lstat(path.join(root, 'recovery.lock'));
    if (owned.ino === current.ino && owned.dev === current.dev) await unlink(path.join(root, 'recovery.lock'));
    await lock.close();
  }
}

async function main(args) {
  const options = { apply: false, keys: [], mouseButtons: [] };
  const values = new Map([['--helper-app', 'helperApp'], ['--queue-file', 'queueFile'], ['--maintenance-owner', 'maintenanceOwner'],
    ['--receipt', 'receipt'], ['--reason', 'reason'], ['--operation-id', 'operationId']]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--inspect') options.apply = false;
    else if (arg === '--scoped-reset') options.scopedReset = true;
    else if (arg === '--keys' || arg === '--mouse-buttons') {
      assert(i + 1 < args.length); const value = args[++i];
      options[arg === '--keys' ? 'keys' : 'mouseButtons'] = value === '' ? [] : value.split(',').map(value => { assert(/^\d+$/.test(value)); return Number(value); });
    } else if (arg === '--old-helper-app') { assert(i + 1 < args.length); (options.oldHelperApps ??= []).push(args[++i]); }
    else { assert(values.has(arg) && i + 1 < args.length, 'Unknown or incomplete argument'); options[values.get(arg)] = args[++i]; }
  }
  const receipt = await recoverNativeInput(options); console.log(JSON.stringify(receipt));
  if (options.apply && receipt.phase !== 'verified') process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
