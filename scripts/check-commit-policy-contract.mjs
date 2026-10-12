import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(path.join(os.tmpdir(), 'cu-commit-policy-'));
const checker = fileURLToPath(new URL('./check-commit-messages.mjs', import.meta.url));
const git = (...args) => execFileSync('git', ['-c', 'commit.gpgsign=false',
  '-c', 'user.name=CI policy test', '-c', 'user.email=ci-policy@example.invalid', ...args],
  {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
try {
  git('init');
  writeFileSync(path.join(root, 'fixture'), 'baseline');
  git('add', 'fixture'); git('commit', '-m', 'ci: initialize fixture');
  const base = git('rev-parse', 'HEAD');
  writeFileSync(path.join(root, 'fixture'), 'changed');
  git('add', 'fixture'); git('commit', '-m', 'fix(browser): account for launch phases');
  const head = git('rev-parse', 'HEAD');
  const check = (title, event = 'pull_request', revision = head, start = base) => spawnSync(
    process.execPath, [checker], {cwd: root, encoding: 'utf8', env: {...process.env,
      COMMIT_RANGE: `${start}..${revision}`, GITHUB_EVENT_NAME: event,
      GITHUB_BASE_SHA: start, GITHUB_SHA: revision, GITHUB_PR_TITLE: title}});
  assert.equal(check('fix(browser): attribute launch phases').status, 0);
  assert.equal(check('ci: verify source policy').status, 0);
  for (const title of ['fix: measure browser launch phases', '', 'Merge arbitrary changes']) {
    const result = check(title);
    assert.equal(result.status, 1, `Unusable squash title passed: ${title}`);
    assert.match(result.stderr, /pull request squash title/);
  }
  assert.equal(check('', 'push').status, 0, 'Valid merged source must not require PR metadata');
  git('commit', '--allow-empty', '-m', 'fix: invalid source subject');
  const result = check('fix(ci): validate squash titles', 'pull_request', git('rev-parse', 'HEAD'), head);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid commit message/);
  console.log('Commit policy: real Git ranges, valid scoped squash titles, early invalid/missing title rejection and source rejection passed.');
} finally {
  rmSync(root, {recursive: true, force: true});
}
