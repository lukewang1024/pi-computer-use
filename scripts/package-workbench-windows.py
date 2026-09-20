#!/usr/bin/env python3
"""Package the Windows repair while retaining upstream Mac/Linux helper bytes."""
import base64
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = '0.5.1-workbench.1'
URL = 'https://registry.npmjs.org/@injaneity/pi-computer-use/-/pi-computer-use-0.5.1.tgz'
INTEGRITY = 'eBYKTUYfLeaCE33TF6CBb0rklXbgS/4GNDsnl+cBTXv6HTkkMc/Gq/ft3RdcDL0hiRmQBwU9Ohx9jWz4r/l9xQ=='


def main():
    with urllib.request.urlopen(URL, timeout=120) as response:
        original = response.read()
    if base64.b64encode(hashlib.sha512(original).digest()).decode() != INTEGRITY:
        raise RuntimeError('upstream package integrity mismatch')
    binary = (ROOT / 'prebuilt/windows/windows-bridge.exe').read_bytes()
    if not binary.startswith(b'MZ'):
        raise RuntimeError('Windows PE helper missing')
    replacements = {
        'package/prebuilt/windows/windows-bridge.exe': binary,
        'package/native/windows/bridge-rs/src/capture.rs':
            (ROOT / 'native/windows/bridge-rs/src/capture.rs').read_bytes(),
    }
    revision = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    output = ROOT / 'dist'
    output.mkdir(exist_ok=True)
    artifact = output / f'pi-computer-use-{VERSION}.tgz'
    found = set()
    with tarfile.open(fileobj=io.BytesIO(original), mode='r:gz') as source, tarfile.open(artifact, 'w:gz') as target:
        for member in source.getmembers():
            data = source.extractfile(member).read() if member.isfile() else None
            if member.name == 'package/package.json':
                package = json.loads(data)
                package['version'] = VERSION
                data = json.dumps(package, indent=2).encode()
            if member.name in replacements:
                found.add(member.name)
                data = replacements[member.name]
            if data is not None:
                member.size = len(data)
            target.addfile(member, io.BytesIO(data) if data is not None else None)
        if found != set(replacements):
            raise RuntimeError('upstream package layout changed')
        provenance = json.dumps({'revision': revision, 'upstreamIntegrity': 'sha512-' + INTEGRITY,
                                 'windowsHelperSha256': hashlib.sha256(binary).hexdigest(),
                                 'unchangedPlatforms': ['macos', 'linux']}).encode()
        member = tarfile.TarInfo('package/workbench-provenance.json')
        member.size = len(provenance)
        member.mode = 0o644
        target.addfile(member, io.BytesIO(provenance))
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    (output / 'SHA256SUMS').write_text(f'{digest}  {artifact.name}\n')
    print(json.dumps({'artifact': str(artifact), 'sha256': digest, 'revision': revision}))


if __name__ == '__main__':
    main()
