import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile, stat, chmod, symlink } from 'node:fs/promises';
import { validateRecoveryQueue, observedRecoveryInput, selectRecoveryScope, verifiedNativeResetReceipt, stopOldHelpers, readRecoveryQueue } from './recover-native-input.mjs';

const queue = { blocked: true, inFlight: false, maintenanceOwner: 'owner', bootId: 'boot', epoch: 1, jobs: [{ state: 'queued' }] };
assert.equal(validateRecoveryQueue(queue, 'owner', 'boot'), queue);
for (const changed of [{ blocked: false }, { inFlight: true }, { maintenanceOwner: 'other' }, { bootId: 'other' }, { jobs: [{ state: 'active' }] }, { jobs: [{ state: 'draining' }] }, { jobs: null }, { epoch: 2 }]) {
  assert.throws(() => validateRecoveryQueue({ ...queue, ...changed }, 'owner', 'boot', 1));
}
const samples = [0, 1].map(source => ({ source, heldKeys: [31, 53], heldMouseButtons: [] }));
const probe = { schemaVersion: 1, readOnly: true, samples };
const observed = observedRecoveryInput(probe);
assert.deepEqual(observed, { keys: [31, 53], mouseButtons: [] });
for (const bad of [{ ...probe, samples: [samples[0]] }, { ...probe, samples: [samples[0], samples[0]] }, { ...probe, readOnly: false }, { ...probe, samples: [{ source: 0 }, samples[1]] }]) {
  assert.throws(() => observedRecoveryInput(bad));
}
const record = { schemaVersion: 1, scope: 'native_transaction', bootId: 'boot', executablePath: '/helper', ownedKeys: [31, 53], ownedMouseButtons: [] };
assert.deepEqual(selectRecoveryScope(observed, [record], { bootId: 'boot', executables: ['/helper'] }), { mode: 'owned-journal', keys: [31, 53], mouseButtons: [] });
assert.throws(() => selectRecoveryScope(observed, [{ ...record, ownedKeys: [31] }], { bootId: 'boot', executables: ['/helper'] }));
assert.throws(() => selectRecoveryScope(observed, [{ ...record, bootId: 'old-boot' }], { bootId: 'boot', executables: ['/helper'] }));
assert.throws(() => selectRecoveryScope(observed, [{ ...record, executablePath: '/other-helper' }], { bootId: 'boot', executables: ['/helper'] }));
assert.throws(() => selectRecoveryScope(observed, [{ ...record, ownedKeys: [], preparedEvent: { kind: 'keyDown', code: 31 } }], { bootId: 'boot', executables: ['/helper'] }));
assert.throws(() => selectRecoveryScope(observed, [], {}));
assert.deepEqual(selectRecoveryScope(observed, [], { scopedReset: true, reason: 'Repair this observed legacy native input residue', keys: [31, 53], mouseButtons: [] }), { mode: 'scoped-reset', keys: [31, 53], mouseButtons: [] });
for (const options of [{ keys: [31] }, { keys: [31, 53, 53] }, { keys: [31, 53, 57] }, { keys: [31, 53, 128] }, { reason: '' }]) {
  assert.throws(() => selectRecoveryScope(observed, [], { scopedReset: true, reason: 'Repair observed input residue', keys: [31, 53], mouseButtons: [], ...options }));
}
assert.deepEqual(selectRecoveryScope({ keys: [], mouseButtons: [] }, [], { bootId: 'boot', executables: ['/helper'] }), { mode: 'owned-journal', keys: [], mouseButtons: [] });
const neutral = { ...probe, samples: [0, 1].map(source => ({ source, heldKeys: [], heldMouseButtons: [] })) };
const scope = { mode: 'scoped-reset', keys: [31, 53], mouseButtons: [] };
const receipt = { status: 'verified', operationId: 'operation', mode: scope.mode, downEventsDispatched: 0,
  inputReplayed: false, oldHelpersStopped: true, quarantinePreserved: true, neutralSamples: 2,
  releaseEvents: [{ kind: 'keyUp', code: 31 }, { kind: 'keyUp', code: 53 }] };
assert(verifiedNativeResetReceipt(receipt, scope, 'operation', neutral));
for (const changed of [{ status: 'blocked' }, { operationId: 'other' }, { mode: 'owned-journal' }, { downEventsDispatched: 1 },
  { inputReplayed: true }, { oldHelpersStopped: false }, { quarantinePreserved: false }, { neutralSamples: 1 },
  { releaseEvents: [{ kind: 'keyDown', code: 31 }] }, { releaseEvents: [{ kind: 'keyUp', code: 12 }] }]) {
  assert(!verifiedNativeResetReceipt({ ...receipt, ...changed }, scope, 'operation', neutral));
}
assert(!verifiedNativeResetReceipt(receipt, scope, 'operation', probe));
for (const hangs of [false, true]) {
  let alive = true; const signals = [];
  const stopped = await stopOldHelpers(['/helper'], async () => {}, {
    inventory: async () => alive ? [{ pid: 11, identity: 'exact-original-start-and-executable' }] : [],
    identity: async () => alive ? 'exact-original-start-and-executable' : null,
    kill: (pid, signal) => { assert.equal(pid, 11); signals.push(signal); if (!hangs || signal === 'SIGKILL') alive = false; },
    pause: async () => {},
  });
  assert.deepEqual(signals, hangs ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM']);
  assert(stopped.inventoryComplete && stopped.remaining.length === 0);
}
let signals = 0;
await assert.rejects(() => stopOldHelpers(['/helper'], async () => {}, {
  inventory: async () => [{ pid: 11, identity: 'old-process' }], identity: async () => 'different-start-or-executable',
  kill: () => { signals++; }, pause: async () => {},
}));
assert.equal(signals, 0, 'PID reuse cannot authorize killing an unrelated process');
if (process.platform !== 'win32') {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cu-recovery-queue-'));
  try {
    const file = path.join(temporary, 'desktop-queue.json'); await writeFile(file, JSON.stringify(queue), { mode: 0o644 });
    assert.deepEqual(await readRecoveryQueue(file, 'owner', 'boot'), queue);
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'legacy queue permissions are hardened without rewriting contents');
    await chmod(file, 0o644); await assert.rejects(() => readRecoveryQueue(file, 'other-owner', 'boot'));
    assert.equal((await stat(file)).mode & 0o777, 0o644, 'another operator cannot mutate queue metadata');
    await chmod(file, 0o666); await assert.rejects(() => readRecoveryQueue(file, 'owner', 'boot'));
    await chmod(file, 0o600); const linked = path.join(temporary, 'linked-queue.json'); await symlink(file, linked);
    await assert.rejects(() => readRecoveryQueue(linked, 'owner', 'boot'));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.platform === 'darwin') {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cu-input-recovery-tests-'));
  try {
    const binary = path.join(temporary, 'tests');
    execFileSync('xcrun', ['swiftc', '-parse-as-library', '-framework', 'ApplicationServices',
      path.join(root, 'native/macos/foreground_gate.swift'), path.join(root, 'native/macos/input_recovery.swift'),
      path.join(root, 'native/macos/input_recovery_tests.swift'), '-o', binary], { stdio: 'inherit' });
    execFileSync(binary, [], { stdio: 'inherit' });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
} else console.log('SKIP native macOS reset policy compilation: requires Swift on macOS; JS recovery guards ran');
console.log('Native input recovery admission, ownership and scoped reset tests passed without OS input');
