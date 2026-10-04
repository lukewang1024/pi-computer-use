import assert from 'node:assert/strict';
import { resolveHelperSocket } from '../src/platform/macos/helper-socket.mjs';
const fallback = '/default/bridge.sock';
assert.deepEqual(resolveHelperSocket({}, fallback), { socketPath: fallback, external: false });
assert.deepEqual(resolveHelperSocket({ PI_CU_SOCKET_PATH: '/external.sock' }, fallback), { socketPath: '/external.sock', external: true });
assert.deepEqual(resolveHelperSocket({ PI_COMPUTER_USE_HELPER_SOCKET_PATH: '/managed.sock' }, fallback), { socketPath: '/managed.sock', external: false });
for (const env of [{ PI_COMPUTER_USE_HELPER_SOCKET_PATH: 'relative.sock' },
  { PI_COMPUTER_USE_HELPER_SOCKET_PATH: '/a\0b' },
  { PI_COMPUTER_USE_HELPER_SOCKET_PATH: '/managed.sock', PI_CU_SOCKET_PATH: '/external.sock' }]) {
  assert.throws(() => resolveHelperSocket(env, fallback));
}
console.log('macOS managed/external socket ownership checks passed');
