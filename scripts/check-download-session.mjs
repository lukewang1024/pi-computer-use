import assert from 'node:assert/strict';
import { CdpTab, cdpSetManagedDownloadDirectory, cdpNavigateContext, disconnectCdp } from '../src/cdp.ts';

const originalConnect = CdpTab.connect, originalFetch = globalThis.fetch;
const oldPort = process.env.PI_COMPUTER_USE_CDP_PORT;
const tabs = []; let policyActive = false, stopped = 0;
process.env.PI_COMPUTER_USE_CDP_PORT = '9222';
globalThis.fetch = async () => ({ ok: true, json: async () => [
  { id: 'owned', type: 'page', title: '', url: 'about:blank', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/owned' },
] });
CdpTab.connect = async () => {
  const tab = { isOpen: true, closes: 0, configured: false, handler: undefined,
    setDisconnectHandler(handler) { this.handler = handler; },
    async setManagedDownloadDirectory() { this.configured = true; policyActive = true; },
    async navigate() { assert(policyActive, 'Chromium must retain the live configuration session'); },
    close() { this.closes++; this.isOpen = false;
      if (this.configured) policyActive = false;
      this.handler?.(); },
  };
  tabs.push(tab); return tab;
};
try {
  assert(await cdpSetManagedDownloadDirectory('browser:owned', '/managed/owned', () => stopped++));
  assert(policyActive, 'closing the configuration connection resets the browser download policy');
  assert.equal(tabs[0].closes, 0);
  assert(await cdpNavigateContext('browser:owned', 'https://example.test/'));
  assert(policyActive, 'closing a transient navigation session must preserve the policy session');
  assert.equal(tabs[0].closes, 0);
  tabs[0].isOpen = false; policyActive = false; tabs[0].handler();
  assert.equal(stopped, 1, 'unexpected disconnect stops the owned browser');
  const before = tabs.length;
  await assert.rejects(cdpNavigateContext('browser:owned', 'https://example.test/'), /do not replay browser input/);
  assert.equal(tabs.length, before, 'lost policy must not silently reconnect and send input');
  disconnectCdp();
  assert.equal(tabs[0].closes, 1);
  assert.equal(stopped, 1, 'intentional cleanup must not repeat the disconnect callback');
} finally {
  disconnectCdp(); CdpTab.connect = originalConnect; globalThis.fetch = originalFetch;
  if (oldPort === undefined) delete process.env.PI_COMPUTER_USE_CDP_PORT;
  else process.env.PI_COMPUTER_USE_CDP_PORT = oldPort;
}
console.log('Download policy session: retained through navigation, disconnect stops input, cleanup owns its socket.');

// Exercise the real transport hooks, including errors before readyState changes.
const originalWebSocket = globalThis.WebSocket, sockets = [];
class Socket {
  static OPEN = 1;
  readyState = 1;
  constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
  send(data) { const { id } = JSON.parse(data);
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, result: {} }) })); }
  close() { this.readyState = 3; this.onclose?.(); }
}
globalThis.WebSocket = Socket;
try {
  const tab = await CdpTab.connect('ws://owned.test/', 'owned', 'owned');
  let notifications = 0; tab.setDisconnectHandler(() => notifications++);
  assert(tab.isOpen);
  sockets[0].onerror();
  assert.equal(sockets[0].readyState, 1);
  assert.equal(tab.isOpen, false, 'errors revoke control before the socket close event');
  sockets[0].onclose(); tab.close();
  assert.equal(notifications, 1, 'error followed by close notifies the owner exactly once');
} finally { globalThis.WebSocket = originalWebSocket; }
console.log('Real CDP transport hooks: errors revoke liveness immediately and close notifies once.');
