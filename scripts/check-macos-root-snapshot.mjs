import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Compile the actual production methods with an enumeration stub. No GUI
// input is needed to reproduce the post-dispatch duplicate-key crash.
const root = fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(path.join(root, 'native/macos/bridge.swift'), 'utf8');
const start = source.indexOf('\tprivate func rootIdentity(');
const end = source.indexOf('\tprivate func rootDelta(', start);
assert(start >= 0 && end > start, 'Production snapshot methods missing');
const deltaStart = source.indexOf('\tprivate func rootDeltaItem(');
const deltaEnd = source.indexOf('\n\t// The AX snapshot', deltaStart);
assert(deltaStart >= 0 && deltaEnd > deltaStart);
const methods = source.slice(start, end) + source.slice(deltaStart, deltaEnd);
const swift = `import Foundation
final class Harness {
 var roots: [[String: Any]] = []
 var failEnumeration = false
 func listRoots(pid: Int32) throws -> [String: Any] {
  if failEnumeration { throw NSError(domain: "test", code: 1) }
  return ["roots": roots]
 }
${methods}
 func check() {
  let window: [String: Any] = ["windowId": 7, "kind": "window", "role": "AXWindow", "title": "Document", "isFocused": false]
  let sheet: [String: Any] = ["windowId": 7, "kind": "sheet", "role": "AXSheet", "title": "Document"]
  roots = [window, sheet]
  assert(rootMetadataSnapshot(pid: 1).count == 2, "Parent and sheet must remain distinct")
  var later = window; later["isFocused"] = true
  roots = [window, later, sheet, sheet]
  let snapshot = rootMetadataSnapshot(pid: 1)
  assert(snapshot.count == 2, "Duplicate physical roots must not crash")
  assert(snapshot[rootIdentity(window)]?["isFocused"] as? Bool == false, "Duplicate focus is not authority")
  let fallback: [String: Any] = ["kind": "window", "role": "AXWindow", "title": "Transient"]
  roots = [fallback, fallback]
  assert(rootMetadataSnapshot(pid: 1).count == 1, "Duplicate fallback metadata must not crash")
  roots = [window, ["windowId": 8, "kind": "window", "role": "AXWindow"]]
  assert(rootMetadataSnapshot(pid: 1).count == 2, "Distinct windows must remain distinct")
  roots = []; assert(rootMetadataSnapshot(pid: 1).isEmpty)
  failEnumeration = true; assert(rootMetadataSnapshot(pid: 1).isEmpty)
  let popup: [String: Any] = ["kind":"window", "windowId":81,"pid":3,"title":"Header","windowRef":"native-popup", "metadata":["pairing":["confidence":"exact"]]]
  let exact = rootDeltaItem(change:"appeared",root:popup,pid:3)
  assert(exact["windowId"] as? Int == 81)
  assert(exact["ref"] as? String == "native-popup")
  for kind in ["sheet","menu"] { var other=popup; other["kind"]=kind; assert(rootDeltaItem(change:"appeared",root:other,pid:3)["windowId"] == nil) }
  for confidence in ["high","low"] { var other=popup; other["metadata"]=["pairing":["confidence":confidence]]; assert(rootDeltaItem(change:"appeared",root:other,pid:3)["windowId"] == nil) }
  var invalid=popup; invalid["windowId"]=0; assert(rootDeltaItem(change:"closed",root:invalid,pid:3)["windowId"] == nil)

 }
}
Harness().check()
print("PASS production Mac root snapshot: duplicates, parent/sheet, focus, distinct and unavailable roots")
`;
if (process.platform !== 'darwin') {
 console.log('SKIP native Mac root snapshot: requires Swift on macOS');
} else {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-root-snapshot-'));
 try {
  const main = path.join(dir, 'main.swift');
  const binary = path.join(dir, 'tests');
  fs.writeFileSync(main, swift);
  execFileSync('xcrun', ['swiftc', main, '-o', binary], {stdio: 'inherit'});
  execFileSync(binary, [], {stdio: 'inherit'});
 } finally { fs.rmSync(dir, {recursive: true, force: true}); }
}
