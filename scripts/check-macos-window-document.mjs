import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const sources=['native/macos/window_document.swift','scripts/macos-window-document-tests.swift'].map(name=>path.join(root,name));
for(const source of sources)if(!fs.statSync(source).isFile())throw new Error('Native value test source must be a file');
if(process.platform !== 'darwin') {
 console.log('SKIP native macOS document URL evidence: requires Swift on macOS');
} else {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cu-window-document-tests-'));
 try {
  const binary=path.join(dir,'tests');
  execFileSync('xcrun',['swiftc','-parse-as-library',...sources,'-o',binary],{stdio:'inherit'});
  execFileSync(binary,[],{stdio:'inherit'});
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
