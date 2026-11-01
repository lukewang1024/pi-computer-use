import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Compile the production read-only proof against faulting native providers.
// This harness has no setters, input delivery, helper or permission prompts.
const root=fileURLToPath(new URL('../',import.meta.url));
const source=fs.readFileSync(path.join(root,'native/macos/bridge.swift'),'utf8');
const begin=source.indexOf('\tprivate func focusedFramelessKeyboardTarget(');
const end=source.indexOf('\n\t// AXFocused on individual nodes',begin);
assert(begin>=0&&end>begin);
const method=source.slice(begin,end).replaceAll('AXUIElementCreateApplication','TestAXUIElementCreateApplication');
// The exemption must recheck after acquiring physical input and must bypass
// focusing/raising. Existing physical post functions still enforce their gate.
for(const [action,post] of [['typeText','postUnicodeText'],['keypress','postKeyPress']]) {
 const start=source.indexOf('} else if action == "'+action+'" {');
 const stop=source.indexOf('\n\t\t} else',start+1);
 const branch=source.slice(start,stop);
 assert(branch.includes('if let element, !usesFocusedFramelessReference'));
 assert(branch.indexOf('acquirePhysicalInputIfNeeded()')<branch.indexOf('try validateFocusedFramelessReferenceBeforeInput()'));
 assert(branch.indexOf('try validateFocusedFramelessReferenceBeforeInput()')<branch.indexOf('try '+post+'('));
 assert(branch.includes('else if delivery == "hid" && !preserveFocus { focusTargetForPhysicalInput() }'));
}
const swift=`import Foundation
import CoreFoundation
import ApplicationServices
final class AXUIElement {
 var pid: Int32? = 7
 var attributes: [String: AnyObject] = [:]
 var errors: [String: AXError] = [:]
 var rejectTimeout = false
 var settable = true
 var capabilityError = false
 var copies = 0
 var delay: TimeInterval = 0
 var afterCopy: ((String) -> Void)?
}
enum AXError { case success, failure, cannotComplete, attributeUnsupported, noValue }
final class TestApplication { var processIdentifier: Int32 = 7 }
final class NSWorkspace {
 static let shared = NSWorkspace()
 var frontmostApplication: TestApplication? = TestApplication()
}
var application=AXUIElement()
var cgOwner: Int32? = 7
var valueReads=0
func TestAXUIElementCreateApplication(_ pid: Int32) -> AXUIElement { application }
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ timeout: Float) -> AXError {
 precondition(timeout>0 && timeout<=0.010)
 return element.rejectTimeout ? .failure : .success
}
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ attribute: CFString, _ output: inout AnyObject?) -> AXError {
 let key=attribute as String
 element.copies += 1
 if key==kAXValueAttribute as String { valueReads += 1 }
 if element.delay>0 { Thread.sleep(forTimeInterval:element.delay) }
 output=element.attributes[key]
 element.afterCopy?(key)
 return element.errors[key] ?? (output==nil ? .attributeUnsupported : .success)
}
func AXUIElementIsAttributeSettable(_ element: AXUIElement, _ attribute: CFString, _ output: inout DarwinBoolean) -> AXError {
 precondition(attribute as String==kAXValueAttribute as String)
 output=DarwinBoolean(element.settable)
 return element.capabilityError ? .cannotComplete : .success
}
final class Harness {
 func asAXElement(_ value: AnyObject) -> AXUIElement? { value as? AXUIElement }
 func sameElement(_ left: AXUIElement, _ right: AXUIElement) -> Bool { left === right }
 func pidForElement(_ element: AXUIElement) -> Int32? { element.pid }
 func pidForWindowId(_ id: UInt32) -> Int32? { id==20 ? cgOwner : nil }
 func isSecureTextElement(role: String, subrole: String) -> Bool { role=="AXSecureTextField" || subrole=="AXSecureTextField" }
${method}
 func permits(_ editor: AXUIElement, _ window: AXUIElement?, role: String?="AXTextArea", action: String="typeText", delivery: String="hid", menu: Bool=false, pid: Int32=7, id: UInt32=20) -> Bool {
  focusedFramelessKeyboardTarget(editor,observedRole:role,pid:pid,windowId:id,window:window,action:action,delivery:delivery,isMenu:menu)
 }
}
func seed(_ depth: Int=29) -> (AXUIElement,AXUIElement) {
 application=AXUIElement();cgOwner=7;NSWorkspace.shared.frontmostApplication=TestApplication()
 let window=AXUIElement(),editor=AXUIElement()
 application.attributes[kAXFocusedWindowAttribute as String]=window
 application.attributes[kAXFocusedUIElementAttribute as String]=editor
 editor.attributes[kAXRoleAttribute as String]="AXTextArea" as NSString
 editor.attributes[kAXSubroleAttribute as String]="" as NSString
 editor.attributes[kAXEnabledAttribute as String]=NSNumber(value:true)
 // Both zero geometry and missing geometry are intentional. The proof must
 // never read them or AXValue, much less refind an equal-looking sibling.
 var current=editor
 for _ in 0..<depth { let parent=AXUIElement();current.attributes[kAXParentAttribute as String]=parent;current=parent }
 current.attributes[kAXParentAttribute as String]=window
 return (window,editor)
}
@main struct Tests {
 static func main() {
 let h=Harness()
 var (window,editor)=seed()
 precondition(h.permits(editor,window))
 precondition(h.permits(editor,window,action:"keypress"))
 for action in ["click","press","invoke","setText","selectText","cancel","scroll","drag","moveMouse"] {
  precondition(!h.permits(editor,window,action:action))
 }
 precondition(!h.permits(editor,window,delivery:"pid"))
 precondition(!h.permits(editor,window,menu:true))
 precondition(!h.permits(editor,nil))
 precondition(!h.permits(editor,window,role:nil))
 precondition(!h.permits(editor,window,role:"AXButton"))
 precondition(!h.permits(editor,window,pid:0))
 precondition(!h.permits(editor,window,id:0))
 precondition(!h.permits(editor,window,id:21))
 for fault in 0..<25 {
  (window,editor)=seed()
  switch fault {
  case 0: NSWorkspace.shared.frontmostApplication=nil
  case 1: NSWorkspace.shared.frontmostApplication?.processIdentifier=8
  case 2: editor.pid=8
  case 3: window.pid=8
  case 4: cgOwner=nil
  case 5: application.attributes[kAXFocusedUIElementAttribute as String]=AXUIElement()
  case 6: application.attributes[kAXFocusedWindowAttribute as String]=AXUIElement()
  case 7: editor.attributes[kAXRoleAttribute as String]="AXSecureTextField" as NSString
  case 8: editor.attributes[kAXSubroleAttribute as String]="AXSecureTextField" as NSString
  case 9: editor.attributes[kAXEnabledAttribute as String]=NSNumber(value:false)
  case 10: editor.attributes.removeValue(forKey:kAXEnabledAttribute as String)
  case 11: editor.settable=false
  case 12: editor.capabilityError=true
  case 13: editor.rejectTimeout=true
  case 14: application.rejectTimeout=true
  case 15: editor.attributes[kAXParentAttribute as String]=editor
  case 16: editor.attributes[kAXParentAttribute as String]=AXUIElement()
  case 17: editor.afterCopy={key in if key==kAXEnabledAttribute as String { application.attributes[kAXFocusedUIElementAttribute as String]=AXUIElement() } }
  case 18: editor.afterCopy={key in if key==kAXEnabledAttribute as String { application.attributes[kAXFocusedWindowAttribute as String]=AXUIElement() } }
  case 19: editor.afterCopy={key in if key==kAXEnabledAttribute as String { cgOwner=8 } }
  case 20: editor.errors[kAXSubroleAttribute as String] = .cannotComplete
  case 21: editor.attributes[kAXSubroleAttribute as String]=NSNumber(value:42)
  case 22: editor.afterCopy={key in if key==kAXEnabledAttribute as String { editor.attributes[kAXSubroleAttribute as String]="AXSecureTextField" as NSString } }
  case 23: editor.delay=0.210
  default:
   var reads=0
   editor.afterCopy={key in if key==kAXEnabledAttribute as String { reads += 1; if reads==2 { application.attributes[kAXFocusedUIElementAttribute as String]=AXUIElement() } } }
  }
  precondition(!h.permits(editor,window),"fault must reject: \\(fault)")
  if fault==15 { precondition(editor.copies<12,"cycles stop before the ancestor limit") }
 }
 (window,editor)=seed(60);precondition(h.permits(editor,window))
 (window,editor)=seed(65);precondition(!h.permits(editor,window))
 (window,editor)=seed()
 editor.attributes.removeValue(forKey:kAXSubroleAttribute as String)
 precondition(h.permits(editor,window),"unsupported subrole differs from a failed read")
 editor.errors[kAXSubroleAttribute as String] = .noValue
 precondition(h.permits(editor,window))
 // An earlier successful proof does not authorize later focus drift.
 application.attributes[kAXFocusedUIElementAttribute as String]=AXUIElement()
 precondition(!h.permits(editor,window))
 precondition(valueReads==0,"focus proof must not read document text")
 print("PASS production frameless focus proof: deep current identity, keyboard-only HID, ownership, races, secure/disabled targets, cycles and deadlines")
 }
}
`;
if(process.platform!=='darwin') console.log('SKIP compiled Mac frameless focus proof: requires Swift on macOS; input-path wiring checks passed');
else {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cu-frameless-focus-'));
 try {
  const file=path.join(directory,'main.swift'),binary=path.join(directory,'tests');
  fs.writeFileSync(file,swift);
  execFileSync('xcrun',['swiftc','-parse-as-library',file,'-o',binary],{stdio:'inherit'});
  execFileSync(binary,[],{stdio:'inherit'});
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
