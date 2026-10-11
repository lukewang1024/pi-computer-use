import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const sources=['native/macos/app_menu_identity.swift','scripts/macos-app-menu-identity-tests.swift'].map(name=>path.join(root,name));
for(const source of sources) if(!fs.statSync(source).isFile()) throw Error('Application menu policy source missing');
if(process.platform!=='darwin') {
 console.log('SKIP native application menu policy: requires Swift on macOS');
} else {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cu-app-menu-tests-'));
 try {
  const binary=path.join(dir,'tests');
  execFileSync('xcrun',['swiftc','-parse-as-library',...sources,'-o',binary],{stdio:'inherit'});
  execFileSync(binary,[],{stdio:'inherit'});
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
