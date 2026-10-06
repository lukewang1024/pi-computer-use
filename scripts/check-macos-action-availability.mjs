import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const source=fs.readFileSync(path.join(root,'native/macos/bridge.swift'),'utf8');
const start=source.indexOf('final class LookNode {');
const end=source.indexOf('\nfinal class Box<T>',start);
assert(start>=0&&end>start,'Compile the actual helper node serializer');
if(process.platform!=='darwin')console.log('SKIP compiled Mac enabled-state payload tests: requires Swift on macOS');
else{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cu-action-availability-'));
 try{
  const file=path.join(dir,'tests.swift'),binary=path.join(dir,'tests');
  const tests=`
@main struct Tests {
 static func main() throws {
  let node=LookNode(element:nil,ref:"e1",role:"AXTextArea",subrole:"",identifier:"",title:"",description:"Footnote reference 2",value:"2",actions:["AXPress"],canPress:true,canFocus:true,canSetValue:true,canScroll:false,canIncrement:false,canDecrement:false,isTextInput:true,rect:.zero)
  precondition(node.payload()["isEnabled"] == nil, "Absent availability must remain unknown")
  node.isEnabled=false
  precondition(node.payload()["isEnabled"] as? Bool == false, "Explicit false must survive serialization")
  precondition(node.payload()["canPress"] as? Bool == true, "Availability must not erase declared capability")
  let encoded=try JSONSerialization.data(withJSONObject:node.payload())
  let decoded=try JSONSerialization.jsonObject(with:encoded) as! [String:Any]
  precondition(decoded["isEnabled"] as? Bool == false)
  node.isEnabled=true
  precondition(node.payload()["isEnabled"] as? Bool == true)
  node.isEnabled=nil
  precondition(node.payload()["isEnabled"] == nil)
  print("PASS real Mac node payload retains false/true/unknown availability and declared capability")
 }
}
`;
  fs.writeFileSync(file,'import AppKit\nimport ApplicationServices\n'+source.slice(start,end)+tests);
  execFileSync('xcrun',['swiftc','-parse-as-library',file,'-o',binary],{stdio:'inherit'});
  execFileSync(binary,[],{stdio:'inherit'});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
