#!/usr/bin/env python3
"""Pack final checked-out sources and CI-built helpers, never an upstream snapshot."""
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
HELPERS = ['prebuilt/windows/windows-bridge.exe', 'prebuilt/macos/universal/bridge',
           'prebuilt/linux/x64/linux-bridge', 'prebuilt/linux/arm64/linux-bridge']

def main():
    package = json.loads((ROOT / 'package.json').read_text())
    version = package['version']
    if not version or any(c not in '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-' for c in version):
        raise RuntimeError('invalid package version')
    helpers = {}
    for name in HELPERS:
        data = (ROOT / name).read_bytes()
        if not data:
            raise RuntimeError('empty helper: ' + name)
        if name.endswith('.exe') and not data.startswith(b'MZ'):
            raise RuntimeError('Windows helper is not PE')
        if '/linux/' in name and not data.startswith(b'\x7fELF'):
            raise RuntimeError('Linux helper is not ELF')
        helpers[name] = hashlib.sha256(data).hexdigest()
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    result = json.loads(subprocess.check_output(['npm', 'pack', '--ignore-scripts', '--json',
                                                '--pack-destination', str(output)], cwd=ROOT, text=True))
    artifact = output / result[0]['filename']
    with tarfile.open(artifact, 'r:gz') as archive:
        for name, digest in helpers.items():
            if hashlib.sha256(archive.extractfile('package/' + name).read()).hexdigest() != digest:
                raise RuntimeError('packaged helper digest mismatch: ' + name)
        for name in ['src/bridge.ts', 'scripts/setup-helper.mjs', 'src/platform/macos/helper-path.mjs',
                     'native/macos/foreground_gate.swift', 'native/macos/bridge.swift',
                     'native/macos/agent_cursor.swift', 'native/macos/agent_cursor_motion.swift']:
            if archive.extractfile('package/' + name).read() != (ROOT / name).read_bytes():
                raise RuntimeError('packaged source mismatch: ' + name)
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    provenance = {'version': version, 'revision': revision, 'artifact': artifact.name,
                  'sha256': digest, 'helpers': helpers, 'macInstallPolicy': 'LOCAL_BUILD with existing local identity pin'}
    (output / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    (output / 'SHA256SUMS').write_text(digest + '  ' + artifact.name + '\n')
    print(json.dumps(provenance))

if __name__ == '__main__':
    main()
