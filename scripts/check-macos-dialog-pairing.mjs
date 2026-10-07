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
assert(source.includes('entries: cgEntries, includeFloating: true'), 'Discovery must include floating CG windows');
assert(source.includes('var usedWindows = Set(dialogs.map'), 'Unpaired dialogs must not fall through to title ranking');
assert(source.includes('if candidate.layer != 0 { continue }'), 'Ordinary windows retain layer-zero matching');
assert(source.includes('uniqueVisibleWindowPairs(axNodes: snapshots'), 'Standard floating windows require strict bidirectional matching');
assert(source.includes('let floatingIds = Set(candidates.filter { $0.layer != 0 && $0.isOnscreen && !usedCandidateIds.contains($0.windowId) }'), 'The added path is limited to floating CG windows');
assert(source.includes('strictFrameForWindow(window)'), 'Floating mapping must use readable finite AX geometry');
const resolver = source.slice(source.indexOf('\tprivate func windowElement('), source.indexOf('\tprivate func findDescendant('));
assert(resolver.includes('matches.count == 1'), 'Stored dialog must remain a unique current AX window');
assert(resolver.includes('candidate?.windowId == windowId'), 'Stored dialog must retain its exact visible CG identity');
const swift = `import Foundation
import CoreGraphics
final class Harness {
${source.slice(start, end)}
 func check() {
  let dialog = CGRect(x: 748, y: 257, width: 232, height: 200)
  let document = CGRect(x: 391, y: 34, width: 1152, height: 1083)
  assert(dialogWindowPairIndices(dialogFrames: [dialog], candidateFrames: [document, dialog]) == [1: 0])
  assert(dialogWindowPairIndices(dialogFrames: [dialog], candidateFrames: [document]).isEmpty)
  assert(dialogWindowPairIndices(dialogFrames: [dialog, dialog], candidateFrames: [dialog]).isEmpty)
  assert(dialogWindowPairIndices(dialogFrames: [dialog], candidateFrames: [dialog, dialog]).isEmpty)
  assert(dialogWindowPairIndices(dialogFrames: [dialog.offsetBy(dx: 50, dy: 0)], candidateFrames: [dialog]).isEmpty)
  assert(dialogWindowPairIndices(dialogFrames: [.zero], candidateFrames: [dialog]).isEmpty)
  assert(dialogWindowPairIndices(dialogFrames: [CGRect(x: CGFloat.nan, y: 257, width: 232, height: 200)], candidateFrames: [dialog]).isEmpty)
  assert(dialogWindowPairIndices(dialogFrames: [dialog], candidateFrames: [CGRect(x: 748, y: 257, width: CGFloat.infinity, height: 200)]).isEmpty)

 }
}
Harness().check()
print("PASS production dialog pairing: document exclusion, absent/moved dialog, ambiguity and invalid geometry")
`;
if (process.platform !== 'darwin') {
 console.log('SKIP compiled Mac dialog pairing: requires Swift on macOS; integration assertions passed');
} else {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-dialog-pairing-'));
 try {
  const main = path.join(dir, 'main.swift');
  const binary = path.join(dir, 'tests');
  fs.writeFileSync(main, swift);
  execFileSync('xcrun', ['swiftc', main, '-o', binary], {stdio: 'inherit'});
  execFileSync(binary, [], {stdio: 'inherit'});
 } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
