import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(path.join(root, 'native/macos/bridge.swift'), 'utf8');
const start = source.indexOf('\tprivate func popupMenuFrameMatches(');
const end = source.indexOf('\tprivate func openMenuElements(', start);
assert(start >= 0 && end > start, 'Production popup pairing methods missing');
assert(source.includes('let menuElement = menuPairs[index].map'), 'Root discovery must use verified pairing');
assert(!source.includes('index < menuElements.count ? menuElements[index]'), 'Enumeration order is not menu identity');
const act = source.slice(source.indexOf('\tprivate func act('), source.indexOf('\tprivate func rootIdentity('));
assert(act.includes('func validateObservedMenu('), 'Menu must be revalidated before input');
assert(act.includes('sameElement(activeMenu, menuRoot)'), 'Same PID is not the observed menu');
assert(act.includes('isElement(candidateElement, descendantOf: menuRoot)'), 'Ref must belong to that menu');
assert(act.includes('try validateObservedMenu(element)'), 'Menu must be checked immediately before invocation');
assert(act.includes('\"inputRetryProhibited\": true'), 'Menu invocations must not retry or fall through to physical input');
const swift = `import Foundation
import CoreGraphics
final class Harness {
${source.slice(start, end)}
 func check() {
  let first = CGRect(x: 1101, y: 84, width: 109, height: 34)
  let second = CGRect(x: 900, y: 120, width: 160, height: 80)
  // The static Apple menu precedes the actual Ribbon popup in the AX tree.
  assert(popupMenuPairIndices(menuFrames: [.zero, first], candidateFrames: [first]) == [0: 1])
  assert(popupMenuPairIndices(menuFrames: [second, first], candidateFrames: [first, second]) == [0: 1, 1: 0])
  assert(popupMenuPairIndices(menuFrames: [first, .zero], candidateFrames: [first]) == [0: 0])
  assert(popupMenuPairIndices(menuFrames: [.zero], candidateFrames: [first]).isEmpty)
  assert(popupMenuPairIndices(menuFrames: [first], candidateFrames: []).isEmpty)
  assert(popupMenuPairIndices(menuFrames: [], candidateFrames: [first]).isEmpty)
  // Either-direction ambiguity must remain unpaired, regardless of ordering.
  assert(popupMenuPairIndices(menuFrames: [first, first], candidateFrames: [first]).isEmpty)
  assert(popupMenuPairIndices(menuFrames: [first], candidateFrames: [first, first]).isEmpty)
  assert(popupMenuPairIndices(menuFrames: [first, first, second], candidateFrames: [first, second]) == [1: 2])
  let moved = first.offsetBy(dx: 100, dy: 0)
  assert(popupMenuPairIndices(menuFrames: [moved], candidateFrames: [first]).isEmpty)
  let bordered = CGRect(x: 1100, y: 83, width: 111, height: 36)
  assert(popupMenuPairIndices(menuFrames: [bordered], candidateFrames: [first]) == [0: 0])
  assert(!popupMenuFrameMatches(axFrame: CGRect(x: CGFloat.nan, y: 84, width: 109, height: 34), cgFrame: first))
  assert(!popupMenuFrameMatches(axFrame: CGRect(x: 1101, y: 84, width: CGFloat.infinity, height: 34), cgFrame: first))
  assert(!popupMenuFrameMatches(axFrame: CGRect(x: 1101, y: 84, width: 109, height: 0), cgFrame: first))
 }
}
Harness().check()
print("PASS production popup menu pairing: hidden Apple menu, reordered/cascading popups, movement, ambiguity and invalid geometry")
`;
if (process.platform !== 'darwin') {
 console.log('SKIP compiled Mac popup pairing: requires Swift on macOS; integration assertions passed');
} else {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-menu-pairing-'));
 try {
  const main = path.join(dir, 'main.swift');
  const binary = path.join(dir, 'tests');
  fs.writeFileSync(main, swift);
  execFileSync('xcrun', ['swiftc', main, '-o', binary], {stdio: 'inherit'});
  execFileSync(binary, [], {stdio: 'inherit'});
 } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
