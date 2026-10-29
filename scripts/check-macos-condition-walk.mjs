import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.platform !== 'darwin') {
 console.log('SKIP native macOS condition traversal: requires Swift on macOS');
} else {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-condition-tests-'));
 try {
  const binary = path.join(dir, 'tests');
  execFileSync('xcrun', ['swiftc', '-parse-as-library',
   path.join(root, 'native/macos/outline_walk.swift'),
   path.join(root, 'scripts/macos-condition-walk-tests.swift'), '-o', binary], {stdio: 'inherit'});
  execFileSync(binary, [], {stdio: 'inherit'});
 } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
