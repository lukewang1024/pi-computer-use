import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, symlink, stat, rm } from 'node:fs/promises';
import { prepareManagedDownloadDirectory } from '../src/browser-downloads.ts';
import { CdpTab } from '../src/cdp.ts';

const temp = await mkdtemp(path.join(os.tmpdir(), 'cu-download-contract-'));
try {
  assert.equal(await prepareManagedDownloadDirectory(undefined), undefined);
  for (const root of ['', '.', 'relative/path', temp + '\0']) {
    await assert.rejects(prepareManagedDownloadDirectory(root), /existing absolute directory/);
  }
  await assert.rejects(prepareManagedDownloadDirectory(path.join(temp, 'absent')), /ENOENT/);
  const file = path.join(temp, 'file'); await writeFile(file, 'not a directory');
  await assert.rejects(prepareManagedDownloadDirectory(file), /not a redirected leaf/);
  const root = path.join(temp, 'downloads'); await mkdir(root);
  const first = await prepareManagedDownloadDirectory(root);
  const second = await prepareManagedDownloadDirectory(root);
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), root);
  assert((await stat(first)).isDirectory());
  if (process.platform !== 'win32') assert.equal((await stat(first)).mode & 0o777, 0o700);
  const redirected = path.join(temp, 'redirected');
  await symlink(root, redirected, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepareManagedDownloadDirectory(redirected), /not a redirected leaf/);

  const tab = Object.create(CdpTab.prototype), calls = [];
  tab.send = async (method, params) => { calls.push({ method, params }); };
  await tab.setManagedDownloadDirectory(first);
  assert.deepEqual(calls, [{ method: 'Browser.setDownloadBehavior',
    params: { behavior: 'allow', downloadPath: first, eventsEnabled: false } }]);
  calls.length = 0;
  tab.send = async method => { calls.push(method); throw new Error('unsupported protocol'); };
  await assert.rejects(tab.setManagedDownloadDirectory(first), /unsupported protocol/);
  assert.deepEqual(calls, ['Browser.setDownloadBehavior'], 'no deprecated fallback or replay');
} finally {
  await rm(temp, { recursive: true, force: true });
}
console.log('Managed downloads: scoped unique directories, redirects denied, exact protocol, no fallback passed.');
