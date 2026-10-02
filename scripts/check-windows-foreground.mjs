import assert from 'node:assert/strict';
import { windowsBackend } from '../src/platform/windows/backend.ts';
import { windowsHelper } from '../src/platform/windows/helper.ts';
import { verifyFocusedWindow } from '../src/focus-window.ts';
const original = windowsHelper.command;
const doc = {windowId: 10, pid: 7, title: 'Document', ref:'@w1', isFocused:false, isMain:false};
const floating = {windowId: 20, pid: 7, title:'Assistant', ref:'@w2', isFocused:false, isMain:false};
try {
  // Enumeration order is not foreground evidence: secure/unavailable desktops
  // may still enumerate both the document and its same-process floating window.
  windowsHelper.command = async () => ({roots:[floating,doc]});
  await assert.rejects(windowsBackend.getFrontmost(), /No frontmost window/);
  windowsHelper.command = async () => ({roots:[floating,{...doc,isFocused:true,isMain:true}]});
  assert.equal((await windowsBackend.getFrontmost()).windowId,10);
  const target = {pid:7,windowId:10};
  assert.equal(verifyFocusedWindow(target,[{...doc,isFocused:true,isMain:true}],{pid:7,windowId:10}).verified,true);
  assert.equal(verifyFocusedWindow(target,[doc,{...floating,isFocused:true,isMain:true}],{pid:7,windowId:20}).verified,false);
  assert.equal(verifyFocusedWindow(target,[{...doc,isFocused:true,isMain:true}],{pid:8,windowId:30}).verified,false);
  assert.equal(verifyFocusedWindow(target,[],undefined).verified,false);
  console.log('Windows foreground evidence checks passed');
} finally { windowsHelper.command = original; }
