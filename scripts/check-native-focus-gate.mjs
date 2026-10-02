// Newly authored gate runner. Cross-platform identity checks run everywhere;
// native Win32 tests run only on Windows, and otherwise are explicitly skipped.
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const tsx=path.join(root,'node_modules','tsx','dist','cli.mjs');
for(const script of ['check-focus-window.mjs','check-windows-foreground.mjs']){
 execFileSync(process.execPath,[tsx,path.join(root,'scripts',script)],{stdio:'inherit',cwd:root});
}
if(process.platform==='win32'){
 execFileSync('cargo',['test','--locked','--manifest-path',path.join(root,'native','windows','bridge-rs','Cargo.toml'),'foreground::tests','--','--test-threads=1'],{stdio:'inherit',cwd:root});
}else{
 console.log('SKIP native Win32 foreground tests: requires Windows; identity/backend regressions passed');
}
