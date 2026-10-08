import assert from 'node:assert/strict';
import { windowsArchitecture, verifyWindowsPe } from './windows-architecture.mjs';
assert.equal(windowsArchitecture('x64', {PROCESSOR_ARCHITEW6432:'ARM64'}), 'arm64');
assert.equal(windowsArchitecture('arm64', {}), 'arm64');
assert.equal(windowsArchitecture('x64', {}), 'x64');
assert.throws(() => windowsArchitecture('ia32', {}));
for (const [arch, machine] of [['x64',0x8664],['arm64',0xaa64]]) {
  const pe = Buffer.alloc(128);
  pe.write('MZ'); pe.writeUInt32LE(64,0x3c);
  pe.writeUInt32LE(0x4550,64); pe.writeUInt16LE(machine,68);
  verifyWindowsPe(pe,arch);
  assert.throws(() => verifyWindowsPe(pe,arch === 'x64' ? 'arm64' : 'x64'));
  const bad = Buffer.from(pe); bad.writeUInt32LE(0xffffffff,0x3c);
  assert.throws(() => verifyWindowsPe(bad,arch));
  assert.throws(() => verifyWindowsPe(pe.subarray(0,32),arch));
}
console.log('Windows native architecture and PE validation passed');
