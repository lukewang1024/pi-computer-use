export function windowsArchitecture(arch = process.arch, env = process.env) {
  const native = (env.PROCESSOR_ARCHITEW6432 || arch).toLowerCase();
  if (['arm64', 'aarch64'].includes(native)) return 'arm64';
  if (['x64', 'amd64', 'x86_64'].includes(native)) return 'x64';
  throw new Error(`Unsupported Windows architecture: ${native}`);
}

export function verifyWindowsPe(bytes, arch) {
  const expected = {x64: 0x8664, arm64: 0xaa64}[arch];
  if (!expected || bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ')
    throw new Error('Invalid Windows PE executable');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset > bytes.length - 6 || bytes.readUInt32LE(offset) !== 0x4550 ||
      bytes.readUInt16LE(offset + 4) !== expected)
    throw new Error(`Windows PE architecture does not match ${arch}`);
}
