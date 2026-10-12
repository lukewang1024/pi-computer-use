import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { managedBrowserExecutableCandidates as candidates, managedBrowserOverrideName } from '../src/managed-browser-executable.ts';
import { loadComputerUseConfig } from '../src/config.ts';

const windows = { platform: 'win32', home: 'C:\\Users\\test', env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', PATH: 'D:\\Browsers;D:\\Browsers' } };
assert.deepEqual(candidates('edge', windows), [
 'C:\\Users\\test\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe',
 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
 'D:\\Browsers\\msedge.exe',
]);
assert(candidates('chrome', windows).every(p => p.endsWith('chrome.exe')));
assert(candidates('helium', windows).every(p => p.endsWith('helium.exe')));
assert.deepEqual(candidates('edge', { ...windows, env: { PI_COMPUTER_USE_EDGE_EXECUTABLE: ' D:\\Pinned\\edge.exe ', PI_COMPUTER_USE_CHROME_EXECUTABLE: 'C:\\Chrome.exe' } }), ['D:\\Pinned\\edge.exe']);
assert.equal(managedBrowserOverrideName('edge'), 'PI_COMPUTER_USE_EDGE_EXECUTABLE');
assert.equal(managedBrowserOverrideName('chrome'), 'PI_COMPUTER_USE_CHROME_EXECUTABLE');
assert.equal(managedBrowserOverrideName('helium'), 'PI_COMPUTER_USE_HELIUM_EXECUTABLE');
assert.deepEqual(candidates('edge', { platform: 'darwin', home: '/Users/test', env: {} }), ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Users/test/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']);
assert.deepEqual(candidates('edge', { platform: 'linux', home: '/home/test', env: { PATH: '/usr/bin:/custom' } }), ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge', '/custom/microsoft-edge', '/custom/microsoft-edge-stable']);

const root = await mkdtemp(path.join(os.tmpdir(), 'cu-browser-config-'));
const previous = process.env.PI_COMPUTER_USE_MANAGED_BROWSER;
try {
 delete process.env.PI_COMPUTER_USE_MANAGED_BROWSER;
 await mkdir(path.join(root, '.pi'));
 await writeFile(path.join(root, '.pi', 'computer-use.json'), JSON.stringify({ managed_browser: 'edge' }));
 assert.equal(loadComputerUseConfig(root).config.managed_browser, 'edge');
 process.env.PI_COMPUTER_USE_MANAGED_BROWSER = 'chrome';
 assert.equal(loadComputerUseConfig(root).config.managed_browser, 'chrome');
 process.env.PI_COMPUTER_USE_MANAGED_BROWSER = 'edge';
 assert.equal(loadComputerUseConfig(root).config.managed_browser, 'edge');
} finally {
 if (previous === undefined) delete process.env.PI_COMPUTER_USE_MANAGED_BROWSER;
 else process.env.PI_COMPUTER_USE_MANAGED_BROWSER = previous;
 await rm(root, { recursive: true, force: true });
 loadComputerUseConfig(process.cwd());
}
console.log('Managed browser executable/configuration checks passed');
