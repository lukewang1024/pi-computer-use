import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Compile the production method against a deterministic AX provider. No GUI,
// permissions, capture, input APIs or application processes are involved.
const root=fileURLToPath(new URL('../',import.meta.url));
const source=fs.readFileSync(path.join(root,'native/macos/bridge.swift'),'utf8');
const start=source.indexOf('\tprivate func focusedContext(');
const end=source.indexOf('\n\tprivate func elapsedMs(',start);
assert(start>=0&&end>start);
const method=source.slice(start,end);
const swift=`import Foundation
import CoreFoundation
final class AXUIElement {
 let pid: Int32
 var attributes: [String: AnyObject] = [:]
 var settable = false
 var settableError = false
 var timeoutRejected = false
 var copies = 0
 var settableReads = 0
 var delay: TimeInterval = 0
 init(_ pid: Int32 = 7) { self.pid = pid }
}
enum AXError { case success, failure }
let kAXFocusedUIElementAttribute = "AXFocusedUIElement"
let kAXParentAttribute = "AXParent"
let kAXRoleAttribute = "AXRole"
let kAXSubroleAttribute = "AXSubrole"
let kAXTitleAttribute = "AXTitle"
let kAXDescriptionAttribute = "AXDescription"
let kAXEnabledAttribute = "AXEnabled"
let kAXValueAttribute = "AXValue"
var application = AXUIElement()
var valueReads = 0
func AXUIElementCreateApplication(_ pid: Int32) -> AXUIElement { application }
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ timeout: Float) -> AXError {
 precondition(timeout == 0.05)
 return element.timeoutRejected ? .failure : .success
}
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ attribute: CFString, _ output: inout AnyObject?) -> AXError {
 element.copies += 1
 let name = attribute as String
 if name == "AXValue" { valueReads += 1 }
 if element.delay > 0 { Thread.sleep(forTimeInterval: element.delay) }
 output = element.attributes[name]
 return output == nil ? .failure : .success
}
func AXUIElementIsAttributeSettable(_ element: AXUIElement, _ attribute: CFString, _ output: inout DarwinBoolean) -> AXError {
 element.settableReads += 1
 output = DarwinBoolean(element.settable)
 return element.settableError ? .failure : .success
}
final class LookNode {
 let element: AXUIElement?
 let ref: String
 var role = "AXTextArea"
 var subrole = ""
 var title = "Title"
 var description = "Description"
 var canSetValue = true
 var isTextInput = true
 var isEnabled: Bool? = false
 var children: [LookNode] = []
 init(_ element: AXUIElement?, _ ref: String) { self.element = element; self.ref = ref }
}
final class Harness {
 func asAXElement(_ value: AnyObject) -> AXUIElement? { value as? AXUIElement }
 func pidForElement(_ element: AXUIElement) -> Int32? { element.pid }
 func sameElement(_ a: AXUIElement, _ b: AXUIElement) -> Bool { a === b }
${method}
 func check() {
  let window = AXUIElement(), editor = AXUIElement(), other = AXUIElement()
  let root = LookNode(window,"window"), body = LookNode(editor,"body")
  root.children = [body]
  application.attributes["AXFocusedUIElement"] = editor
  var result = focusedContext(pid:7,window:window,outline:root)
  precondition(result["status"] as? String == "matched")
  precondition(result["wireRef"] as? String == "body")
  precondition(result["isEnabled"] as? Bool == false)
  precondition(editor.copies == 0 && editor.settableReads == 0,"Reuse observed metadata without extra AX reads")
  body.isEnabled = nil
  result = focusedContext(pid:7,window:window,outline:root)
  precondition(result["isEnabled"] == nil,"Missing enabled stays unknown")
  body.role = "AXSecureTextField"
  result = focusedContext(pid:7,window:window,outline:root)
  precondition(result["isSecure"] as? Bool == true && result["title"] == nil && result["description"] == nil)
  root.children = [body, LookNode(editor,"duplicate")]
  result = focusedContext(pid:7,window:window,outline:root)
  precondition(result["status"] as? String == "ambiguous" && result["wireRef"] == nil)
  root.children = []
  editor.attributes = ["AXParent":window,"AXRole":"AXTextArea" as NSString,"AXSubrole":"" as NSString,"AXEnabled":NSNumber(value:false),"AXValue":"SECRET" as NSString]
  editor.settable = true
  result = focusedContext(pid:7,window:window,outline:root)
  precondition(result["status"] as? String == "unobserved" && result["scopeVerified"] as? Bool == true)
  precondition(result["wireRef"] == nil && result["canSetValue"] as? Bool == true && result["isEnabled"] as? Bool == false)
  editor.attributes.removeValue(forKey:"AXEnabled"); editor.settableError = true
  result = focusedContext(pid:7,window:window,outline:root)
  precondition(result["isEnabled"] == nil && result["canSetValue"] == nil)
  editor.attributes["AXParent"] = other
  result = focusedContext(pid:7,window:window,outline:root)
  precondition(result["scopeVerified"] as? Bool == false && result["role"] == nil && result["wireRef"] == nil)
  editor.attributes["AXParent"] = editor
  let reads = editor.copies
  result = focusedContext(pid:7,window:window,outline:root)
  precondition(editor.copies - reads <= 20,"Cyclic parent chain must be bounded")
  application.attributes["AXFocusedUIElement"] = AXUIElement(8)
  result = focusedContext(pid:7,window:window,outline:root)
  precondition(result["status"] as? String == "unavailable")
  application.timeoutRejected = true
  let before = application.copies
  result = focusedContext(pid:7,window:window,outline:root)
  precondition(application.copies == before,"Timeout rejection must prevent unbounded copy")
  application.timeoutRejected = false; application.delay = 0.02
  result = focusedContext(pid:7,window:window,outline:root,budgetMs:1)
  precondition(result["status"] as? String == "budget_exceeded" && result["wireRef"] == nil)
  application.delay = 0
  precondition(valueReads == 0,"Never copy AXValue, including secure/unobserved input")
  precondition(result["readOnly"] as? Bool == true)
 }
}
Harness().check()
print("PASS production focused-context method: exact scope, disabled/unknown, duplicate refs, secure redaction, bounded cyclic parent, rejected timeout, exhausted deadline and no AXValue reads")
`;
if(process.platform!=='darwin') console.log('SKIP compiled Mac focused-context tests: requires Swift on macOS');
else {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cu-focused-context-'));
 try {
  const file=path.join(directory,'main.swift'),binary=path.join(directory,'tests');
  fs.writeFileSync(file,swift);
  execFileSync('xcrun',['swiftc',file,'-o',binary],{stdio:'inherit'});
  execFileSync(binary,[],{stdio:'inherit'});
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
