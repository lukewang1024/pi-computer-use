import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const main=readFileSync(new URL('../native/windows/bridge-rs/src/main.rs',import.meta.url),'utf8');
const input=readFileSync(new URL('../native/windows/bridge-rs/src/input.rs',import.meta.url),'utf8');
const window=readFileSync(new URL('../native/windows/bridge-rs/src/window.rs',import.meta.url),'utf8');
assert.match(main,/pointerGuard.*record.hwnd.*record.pid/);
assert.match(main,/pointerGuard.*element.hwnd.*expected_pid/);
for(const name of ['click','scroll']) {
 const body=input.slice(input.indexOf('    fn '+name+'('),input.indexOf('    fn ',input.indexOf('    fn '+name+'(')+8));
 assert.ok(body.indexOf('guard_point(args, x, y)?')<body.indexOf('SetCursorPos'));
 assert.ok(body.lastIndexOf('guard_point(args, x, y)?')>body.indexOf('SetCursorPos'));
 assert.ok(body.lastIndexOf('guard_point(args, x, y)?')<body.indexOf('send('));
}
assert.match(input,/for &\(x, y\) in points \{ guard_point\(args, x, y\)\?; \}/);
assert.match(window,/root != hwnd \|\| hit_pid != expected_pid/);
assert.match(window,/ErrorCode::OccludedTarget/);
console.log('Windows pointer guard wiring checks passed');
