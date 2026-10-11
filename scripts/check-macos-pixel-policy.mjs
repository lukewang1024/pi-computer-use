import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const source=fs.readFileSync(new URL('../native/macos/bridge.swift',import.meta.url),'utf8');
const start=source.indexOf('\t\tlet includeElements = boolArg(request, "includeElements")');
const end=source.indexOf('\n\t\tlet allowImageFailure',start);
assert(start>=0&&end>start,'production pixel request policy must exist');
const policy=source.slice(start,end);
if(process.platform!=='darwin') {
 console.log('macOS pixel request policy found; execution requires macOS Swift');
} else {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cu-pixel-policy-'));
 try {
  const swift=`import Foundation
struct BridgeFailure: Error { let message: String; let code: String }
func boolArg(_ request: [String: Any], _ name: String) -> Bool? { request[name] as? Bool }
func optionalStringArg(_ request: [String: Any], _ name: String) -> String? { request[name] as? String }
func validate(_ request: [String: Any]) throws {
 let readText = optionalStringArg(request, "readText") ?? "auto"
 let baseLookId = optionalStringArg(request, "baseLookId")
 let includeImage = boolArg(request, "includeImage") ?? true
${policy}
}
let good: [String: Any] = ["includeElements": false, "includeImage": true, "readText": "never"]
try validate(good)
try validate([:]) // existing semantic default is preserved
for (name, value) in [("readText", "always" as Any), ("readText", "auto" as Any), ("includeImage", false as Any), ("scopeRef", "owned-ref" as Any), ("baseLookId", "previous-look" as Any), ("focusContext", true as Any)] {
 var request = good; request[name] = value
 do { try validate(request); fatalError("Unsafe pixel request accepted: " + name) }
 catch let error as BridgeFailure { precondition(error.code == "invalid_args") }
}
print("Production macOS pixel request policy passed; no helper/capture/input launched")
`;
  const file=path.join(dir,'policy.swift'), binary=path.join(dir,'policy');fs.writeFileSync(file,swift);
  execFileSync('/usr/bin/xcrun',['swiftc',file,'-o',binary],{stdio:'inherit',timeout:120000});
  execFileSync(binary,[],{stdio:'inherit',timeout:10000});
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
}
