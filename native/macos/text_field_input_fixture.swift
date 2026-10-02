import AppKit
import CoreGraphics
final class LaggingField:NSTextField { var frozenAXValue:String?;override func accessibilityValue()->String? { if let value=frozenAXValue{return value};return super.accessibilityValue() } }
final class Fixture: NSObject, NSApplicationDelegate {
 let title=CommandLine.arguments[1], output=CommandLine.arguments[2]
 var main:NSWindow!, assistant:NSWindow!, field:LaggingField!, timer:Timer?, monitor:Any?
 var keyEvents=0, removed=false, lastValue="seed"
 func currentValue()->String { if removed{return lastValue}; return (field.currentEditor() as? NSTextView)?.string ?? field.stringValue }
 func writeState(){
  let state:[String:Any]=["windowTitle":title,"value":currentValue(),"pid":ProcessInfo.processInfo.processIdentifier,"mainWindowId":main.windowNumber,"assistantWindowId":assistant.windowNumber,"keyWindowId":NSApp.keyWindow?.windowNumber ?? -1,"frontmostPid":NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1,"keyEvents":keyEvents,"removed":removed,"frozenAX":field.frozenAXValue != nil]
  if let bytes=try? JSONSerialization.data(withJSONObject:state){try? bytes.write(to:URL(fileURLWithPath:output),options:.atomic)}
 }
 func applicationDidFinishLaunching(_ notification:Notification){
  main=NSWindow(contentRect:NSRect(x:80,y:120,width:700,height:350),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false);main.title=title;main.isReleasedWhenClosed=false
  field=LaggingField(frame:NSRect(x:40,y:180,width:550,height:30));field.stringValue="seed";field.placeholderString="Native input target";field.setAccessibilityLabel("Native input target");main.contentView!.addSubview(field)
  assistant=NSWindow(contentRect:NSRect(x:800,y:400,width:52,height:52),styleMask:[.titled,.closable],backing:.buffered,defer:false);assistant.title="CU assistant "+String(ProcessInfo.processInfo.processIdentifier);assistant.isReleasedWhenClosed=false
  main.makeKeyAndOrderFront(nil);assistant.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true)
  monitor=NSEvent.addLocalMonitorForEvents(matching:[.keyDown,.keyUp]){[weak self] event in self?.keyEvents += 1;return event}
  timer=Timer.scheduledTimer(withTimeInterval:0.05,repeats:true){[weak self] _ in guard let s=self else{return};if !s.removed && FileManager.default.fileExists(atPath:s.output+".remove"){s.lastValue=s.currentValue();s.field.removeFromSuperview();s.removed=true;try? "removed".write(toFile:s.output+".removed",atomically:true,encoding:.utf8)};if s.field.frozenAXValue == nil && FileManager.default.fileExists(atPath:s.output+".freeze-ax"){s.field.frozenAXValue=s.currentValue();try? "frozen".write(toFile:s.output+".ax-frozen",atomically:true,encoding:.utf8)};s.writeState()};writeState()
 }
}
let app=NSApplication.shared, fixture=Fixture();app.setActivationPolicy(.regular);app.delegate=fixture;app.run()
