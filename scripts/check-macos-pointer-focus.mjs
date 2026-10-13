import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Execute the production bounded reader against faulting AX providers. This
// binary has no GUI, input delivery, native helper or permission-probing APIs.
const root=fileURLToPath(new URL('../',import.meta.url));
const source=fs.readFileSync(path.join(root,'native/macos/bridge.swift'),'utf8');
const begin=source.indexOf('    private func pointerTextFocusSnapshot(');
const end=source.indexOf('\n\t// AXFocused on individual nodes',begin);
assert(begin>=0&&end>begin);
const method=source.slice(begin,end).replaceAll('AXUIElementCreateApplication','TestAXUIElementCreateApplication');
const declaration=source.slice(source.indexOf('private struct PointerTextFocusSnapshot {'),source.indexOf('final class Bridge {'));
assert(declaration.includes('let selection: NSRange?'));
const swift=`import Foundation
import CoreFoundation
import ApplicationServices
final class AXUIElement {
 let pid: Int32
 var attributes: [String: AnyObject] = [:]
 var rejectTimeout = false
 var copies = 0
 var delay: TimeInterval = 0
 var afterCopy: ((String) -> Void)?
 init(_ pid: Int32 = 7) { self.pid = pid }
}
enum AXError { case success, failure }
final class TestApplication { var processIdentifier: Int32 = 7 }
final class NSWorkspace {
 static let shared = NSWorkspace()
 var frontmostApplication: TestApplication? = TestApplication()
}
var application = AXUIElement()
var valueReads = 0
func TestAXUIElementCreateApplication(_ pid: Int32) -> AXUIElement { application }
func AXUIElementSetMessagingTimeout(_ element: AXUIElement, _ timeout: Float) -> AXError {
 precondition(timeout > 0 && timeout <= 0.010)
 return element.rejectTimeout ? .failure : .success
}
func AXUIElementCopyAttributeValue(_ element: AXUIElement, _ attribute: CFString, _ output: inout AnyObject?) -> AXError {
 let key=attribute as String
 element.copies += 1
 if key == kAXValueAttribute as String { valueReads += 1 }
 if element.delay > 0 { Thread.sleep(forTimeInterval: element.delay) }
 output=element.attributes[key]
 element.afterCopy?(key)
 return output == nil ? .failure : .success
}
${declaration}
final class Harness {
 func asAXElement(_ value: AnyObject) -> AXUIElement? { value as? AXUIElement }
 func sameElement(_ left: AXUIElement, _ right: AXUIElement) -> Bool { left === right }
 func pidForElement(_ element: AXUIElement) -> Int32 { element.pid }
${method}
 fileprivate func capture(_ window: AXUIElement) -> PointerTextFocusSnapshot? { pointerTextFocusSnapshot(pid: 7, window: window) }
}
func seed() -> (AXUIElement, AXUIElement) {
 application=AXUIElement();NSWorkspace.shared.frontmostApplication=TestApplication()
 let window=AXUIElement(),editor=AXUIElement()
 application.attributes[kAXFocusedWindowAttribute as String]=window
 application.attributes[kAXFocusedUIElementAttribute as String]=editor
 editor.attributes[kAXParentAttribute as String]=window
 editor.attributes[kAXRoleAttribute as String]="AXTextArea" as NSString
 editor.attributes[kAXSubroleAttribute as String]="" as NSString
 var point=CGPoint(x: 100,y: 100),size=CGSize(width: 800,height: 600)
 editor.attributes[kAXPositionAttribute as String]=AXValueCreate(.cgPoint,&point)!
 editor.attributes[kAXSizeAttribute as String]=AXValueCreate(.cgSize,&size)!
 var range=CFRange(location: 3,length: 0)
 editor.attributes[kAXSelectedTextRangeAttribute as String]=AXValueCreate(.cfRange,&range)!
 return (window,editor)
}
@main struct Tests {
 static func main() {
 let h=Harness()
 var (window,editor)=seed()
 let sample=h.capture(window)!
 precondition(sample.element === editor && sample.role=="AXTextArea" && !sample.secure)
 precondition(sample.frame?.origin.x==100 && sample.frame?.size.width==800)
 precondition(sample.selection==NSRange(location: 3,length: 0))
 // A non-editor focus is needed for the before sample, but cannot satisfy the
 // separate effect predicate for the clicked text area.
 editor.attributes[kAXRoleAttribute as String]="AXTabGroup" as NSString
 precondition(h.capture(window)?.role=="AXTabGroup")
 for failure in 0..<10 {
 (window,editor)=seed()
 switch failure {
 case 0: NSWorkspace.shared.frontmostApplication=nil
 case 1: NSWorkspace.shared.frontmostApplication?.processIdentifier=8
 case 2: application.attributes[kAXFocusedWindowAttribute as String]=AXUIElement()
 case 3: application.attributes[kAXFocusedUIElementAttribute as String]=AXUIElement(8)
 case 4: editor.attributes[kAXParentAttribute as String]=editor
 case 5: editor.attributes.removeValue(forKey: kAXRoleAttribute as String)
 case 6: application.rejectTimeout=true
 case 7: editor.afterCopy={key in if key==kAXPositionAttribute as String { application.attributes[kAXFocusedUIElementAttribute as String]=AXUIElement() } }
 case 8: editor.afterCopy={key in if key==kAXPositionAttribute as String { application.attributes[kAXFocusedWindowAttribute as String]=AXUIElement() } }
 default: editor.delay=0.110
 }
 precondition(h.capture(window)==nil,"bad scope, drift or deadline cannot establish click effect")
 if failure==4 { precondition(editor.copies<=20,"cyclic parents must stay bounded") }
 }
 (window,editor)=seed()
 editor.attributes[kAXSelectedTextRangeAttribute as String]="invalid" as NSString
 precondition(h.capture(window)?.selection==nil)
 precondition(valueReads==0,"focus evidence must not read document AXValue")
 print("PASS production pointer focus reader: exact ownership, race rejection, cyclic parents, deadlines, unavailable attributes and no text reads")
 }
}
`;
if(process.platform!=='darwin') console.log('SKIP compiled Mac pointer focus reader: requires Swift on macOS');
else {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'cu-pointer-focus-'));
 try {
  const file=path.join(directory,'main.swift'),binary=path.join(directory,'tests');
  fs.writeFileSync(file,swift);
  execFileSync('xcrun',['swiftc','-parse-as-library',file,'-o',binary],{stdio:'inherit'});
  execFileSync(binary,[],{stdio:'inherit'});
 } finally {fs.rmSync(directory,{recursive:true,force:true});}
}
