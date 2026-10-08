import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('verifier', Path(__file__).resolve().parents[1] / 'scripts/verify-workbench-candidate.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)


class CandidateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.output = self.root / 'dist'
        self.output.mkdir()
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        self.files = {name: b'checked source' for name in v.REQUIRED_SOURCE}
        self.files['package.json'] = b'{"version":"0.5.2-workbench.69"}'
        for name, data in self.files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        subprocess.run(['git', 'add', '.'], cwd=self.root, check=True)
        self.files.update({name: ('built ' + name).encode() for name in v.HELPERS + [v.APP]})
        self.write_package()

    def write_package(self, extra=None):
        artifact = self.output / 'candidate.tgz'
        with tarfile.open(artifact, 'w:gz') as archive:
            for name, data in self.files.items():
                member = tarfile.TarInfo('package/' + name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
            if extra:
                archive.addfile(extra)
        receipt = dict(sourceCommit='exact-sha', runId='123', published=False,
                       files={name: v.digest(self.files[name]) for name in v.HELPERS + [v.APP]})
        receipt['files'][artifact.name] = v.digest(artifact.read_bytes())
        self.receipt = receipt
        self.save_receipt()

    def save_receipt(self):
        (self.output / 'candidate-build-receipt.json').write_text(json.dumps(self.receipt))

    def verify(self):
        return v.verify(self.output, 'exact-sha', '123', self.root)

    def test_checked_archive_preserved_and_provenance_compatible(self):
        before = (self.output / 'candidate.tgz').read_bytes()
        proof = self.verify()
        self.assertEqual(proof['revision'], 'exact-sha')
        self.assertEqual(set(proof['helpers']), set(v.HELPERS))
        self.assertEqual((self.output / 'candidate.tgz').read_bytes(), before)
        self.assertEqual((self.output / 'SHA256SUMS').read_text(), v.digest(before) + '  candidate.tgz\n')

    def test_source_run_publication_and_archive_tampering_denied(self):
        for key, value in [('sourceCommit', 'wrong'), ('runId', '456'), ('published', True)]:
            with self.subTest(key=key):
                original = self.receipt[key]
                self.receipt[key] = value
                self.save_receipt()
                with self.assertRaises(RuntimeError):
                    self.verify()
                self.assertFalse((self.output / 'provenance.json').exists())
                self.receipt[key] = original
        self.save_receipt()
        with (self.output / 'candidate.tgz').open('ab') as stream:
            stream.write(b'tampered')
        with self.assertRaisesRegex(RuntimeError, 'digest mismatch'):
            self.verify()

    def test_wrong_source_and_missing_helpers_denied_even_with_valid_receipt(self):
        self.files['src/bridge.ts'] = b'other source'
        self.write_package()
        with self.assertRaisesRegex(RuntimeError, 'source mismatch'):
            self.verify()
        self.files['src/bridge.ts'] = b'checked source'
        del self.files[v.APP]
        # Construct a tar without the app but preserve a plausible receipt entry.
        self.files[v.APP] = b'fake'
        self.write_package()
        self.receipt['files'][v.APP] = '0' * 64
        self.save_receipt()
        with self.assertRaisesRegex(RuntimeError, 'helper receipt mismatch'):
            self.verify()
        # Missing archive member is independently rejected.
        del self.files[v.APP]
        artifact = self.output / 'candidate.tgz'
        with tarfile.open(artifact, 'w:gz') as archive:
            for name, data in self.files.items():
                member = tarfile.TarInfo('package/' + name)
                member.size = len(data)
                archive.addfile(member, io.BytesIO(data))
        self.receipt['files'][artifact.name] = v.digest(artifact.read_bytes())
        self.save_receipt()
        with self.assertRaisesRegex(RuntimeError, 'missing package file'):
            self.verify()

    def test_unsafe_duplicate_and_link_members_denied(self):
        for name, kind in [('package/../escape', tarfile.REGTYPE),
                           ('package/package.json', tarfile.REGTYPE),
                           ('package/link', tarfile.SYMTYPE)]:
            with self.subTest(name=name):
                member = tarfile.TarInfo(name)
                member.type = kind
                self.write_package(member)
                with self.assertRaisesRegex(RuntimeError, 'unsafe or duplicate'):
                    self.verify()


if __name__ == '__main__':
    unittest.main()
