import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const main=readFileSync(new URL('../native/windows/bridge-rs/src/main.rs',import.meta.url),'utf8');
const input=readFileSync(new URL('../native/windows/bridge-rs/src/input.rs',import.meta.url),'utf8');
const window=readFileSync(new URL('../native/windows/bridge-rs/src/window.rs',import.meta.url),'utf8');
assert.match(main,/pointerGuard.*record.hwnd.*record.pid/);
assert.match(main,/pointerGuard.*element.hwnd.*expected_pid/);
const fallback=main.slice(main.indexOf('fn coordinate_fallback('),main.indexOf('fn is_web_backed('));
assert.match(fallback,/select_clear_point[\s\S]*require_pointer_target\(element.hwnd, expected_pid, x as i32, y as i32\)[\s\S]*OccludedTarget => Ok\(false\)[\s\S]*occluded_before_input\(\)[\s\S]*input::act\(&executable\)/);
for(const name of ['click','scroll']) {
 const body=input.slice(input.indexOf('    fn '+name+'('),input.indexOf('    fn ',input.indexOf('    fn '+name+'(')+8));
 assert.ok(body.indexOf('guard_point(args, x, y)?')<body.indexOf('SetCursorPos'));
 assert.ok(body.lastIndexOf('guard_point(args, x, y)?')>body.indexOf('SetCursorPos'));
 assert.ok(body.lastIndexOf('guard_point(args, x, y)?')<body.indexOf('send('));
}
assert.match(input,/for\s+&\(x,\s*y\)\s+in\s+points\s*\{\s*guard_point\(args,\s*x,\s*y\)\?;\s*\}/);
assert.match(window,/root != hwnd \|\| hit_pid != expected_pid/);
assert.match(window,/ErrorCode::OccludedTarget/);
console.log('Windows pointer guard wiring checks passed');
