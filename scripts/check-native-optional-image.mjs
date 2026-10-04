import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform !== 'darwin') {
 console.log('SKIP native macOS optional image capture: requires Swift on macOS');
} else {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cu-optional-image-tests-'));
 try {
  const binary=path.join(dir,'tests');
  execFileSync('xcrun',['swiftc','-parse-as-library',path.join(root,'native/macos/optional_image_capture.swift'),path.join(root,'scripts/native-optional-image-tests.swift'),'-o',binary],{stdio:'inherit'});
  execFileSync(binary,[],{stdio:'inherit'});
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
