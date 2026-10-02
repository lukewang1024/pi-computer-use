import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
if (process.platform !== 'darwin') {
 console.log('SKIP macOS input-source lease (requires Swift on macOS)');
} else {
 const root=fileURLToPath(new URL('..',import.meta.url));
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cu-input-source-tests-'));
 try {
  const binary=path.join(temporary,'tests');
  execFileSync('xcrun',['swiftc','-parse-as-library',path.join(root,'native/macos/text_input_source.swift'),path.join(root,'scripts/text-input-source-tests.swift'),'-o',binary],{stdio:'inherit'});
  execFileSync(binary,[],{stdio:'inherit'});
 } finally {fs.rmSync(temporary,{recursive:true,force:true});}
}
