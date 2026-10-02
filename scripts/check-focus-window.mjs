// New regression coverage reconstructed from the current exported verifier
// contract. This is not a recovered copy of the missing deployment-source test.
import assert from 'node:assert/strict';
import {verifyFocusedWindow} from '../src/focus-window.ts';
const target={pid:7,windowId:10};
const root={...target,isMain:true,isFocused:true};
const front={...target};
assert.equal(verifyFocusedWindow(target,[root],front).verified,true);
for(const [name,roots,foreground] of [
 ['same-process floating window',[root],{pid:7,windowId:20}],
 ['another process',[root],{pid:8,windowId:10}],
 ['no foreground',[root],undefined],
 ['missing root',[],front],
 ['root from another process',[{...root,pid:8}],front],
 ['not main',[{...root,isMain:false}],front],
 ['not focused',[{...root,isFocused:false}],front],
 ['missing focus facts',[target],front],
 ['same-process root replacement',[{...root,windowId:20}],front],
]) assert.equal(verifyFocusedWindow(target,roots,foreground).verified,false,name);
// Some platforms expose a stable root reference instead of a numeric HWND.
const referenced={pid:9,rootRef:'owned-root'};
assert.equal(verifyFocusedWindow(referenced,[{...referenced,isMain:true,isFocused:true}],referenced).verified,true);
assert.equal(verifyFocusedWindow(referenced,[{...referenced,isMain:true,isFocused:true}],{pid:9,rootRef:'floating-root'}).verified,false);
assert.equal(verifyFocusedWindow({pid:9},[{pid:9,isMain:true,isFocused:true}],{pid:9}).verified,false,'PID alone must never suffice');
assert.equal(verifyFocusedWindow(target,[{...root,windowId:20},root],front).verified,true,'enumeration order must not replace the exact root');
console.log('Exact focused-window identity regression checks passed (new coverage)');
