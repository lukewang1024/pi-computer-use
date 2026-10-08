#!/usr/bin/env python3
"""Publish only the exact source-bound tarball already checked by this CI run."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parents[1]
HELPERS = [
    'prebuilt/windows/windows-bridge.exe',
    'prebuilt/windows/arm64/windows-bridge.exe',
    'prebuilt/macos/universal/bridge',
    'prebuilt/linux/x64/linux-bridge',
    'prebuilt/linux/arm64/linux-bridge',
]
APP = 'prebuilt/macos/universal/pi-computer-use.app/Contents/MacOS/bridge'
REQUIRED_SOURCE = ['package.json', 'src/bridge.ts', 'src/platform/windows/helper.ts',
                   'native/windows/bridge-rs/src/uia.rs',
                   'native/windows/bridge-rs/src/uia_resolution.rs',
                   'native/windows/bridge-rs/src/action_trace.rs',
                   'src/platform/windows/action-diagnostics.ts',
                   'scripts/setup-helper.mjs', 'src/platform/macos/helper-path.mjs']


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify(directory, revision, run_id, root=ROOT):
    receipt = json.loads((directory / 'candidate-build-receipt.json').read_text())
    if (receipt.get('sourceCommit') != revision or receipt.get('runId') != str(run_id)
            or receipt.get('published') is not False):
        raise RuntimeError('candidate receipt source/run/publication mismatch')
    archives = list(directory.glob('*.tgz'))
    if len(archives) != 1:
        raise RuntimeError('expected exactly one checked package')
    artifact = archives[0]
    hashes = receipt['files']
    archive_digest = digest(artifact.read_bytes())
    if hashes.get(artifact.name) != archive_digest:
        raise RuntimeError('checked package digest mismatch')
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    tracked = set(filter(None, tracked))
    source_version = json.loads((root / 'package.json').read_text())['version']
    helpers = {}
    with tarfile.open(artifact, 'r:gz') as archive:
        members = {}
        for member in archive.getmembers():
            path = PurePosixPath(member.name)
            if (path.is_absolute() or '..' in path.parts or '\\' in member.name
                    or not member.name.startswith('package/') or member.name in members
                    or not (member.isfile() or member.isdir())):
                raise RuntimeError('unsafe or duplicate package member')
            members[member.name] = member

        def content(name):
            member = members.get('package/' + name)
            if member is None or not member.isfile():
                raise RuntimeError('missing package file: ' + name)
            return archive.extractfile(member).read()

        if json.loads(content('package.json'))['version'] != source_version:
            raise RuntimeError('package version mismatch')
        for name in REQUIRED_SOURCE:
            if name not in tracked or content(name) != (root / name).read_bytes():
                raise RuntimeError('required source mismatch: ' + name)
        for name in tracked:
            if name.startswith('prebuilt/'):
                continue
            member = members.get('package/' + name)
            if member is not None and member.isfile() and content(name) != (root / name).read_bytes():
                raise RuntimeError('packaged source mismatch: ' + name)
        for name in HELPERS + [APP]:
            data = content(name)
            if not data:
                raise RuntimeError('empty helper: ' + name)
            actual = digest(data)
            if name != 'prebuilt/macos/universal/bridge' and hashes.get(name) != actual:
                raise RuntimeError('helper receipt mismatch: ' + name)
            if name in HELPERS:
                helpers[name] = actual
    provenance = dict(version=source_version, revision=revision, artifact=artifact.name,
                      sha256=archive_digest, helpers=helpers,
                      macInstallPolicy='LOCAL_BUILD with existing local identity pin')
    (directory / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')
    (directory / 'SHA256SUMS').write_text(archive_digest + '  ' + artifact.name + '\n')
    return provenance


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if actual != args.revision:
        raise RuntimeError('checkout revision mismatch')
    print(json.dumps(verify(args.directory, args.revision, args.run_id)))


if __name__ == '__main__':
    main()
