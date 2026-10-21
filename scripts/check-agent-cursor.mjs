import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { browserCursorExpression, clearBrowserCursorExpression } from '../src/browser-cursor.ts';
import { preflightActionSequence } from '../src/actions.ts';

const frames = new Map(), timers = new Map();
let clock = 0, nextHandle = 1, focusCalls = 0, inputCalls = 0;
class Element {
 constructor() {this.attributes={};this.styles={};this.style={setProperty:(k,v)=>{this.styles[k]=v}};this.isConnected=false;this.children=[];}
 setAttribute(k,v){this.attributes[k]=v;}
 append(...nodes){this.children.push(...nodes);for(const node of nodes)node.isConnected=true;}
 attachShadow(options){this.shadowOptions=options;this.shadow=new Element();return this.shadow;}
 remove(){this.isConnected=false;}
 focus(){focusCalls++;}
 dispatchEvent(){inputCalls++;}
}
const root=new Element();root.isConnected=true;
const context=vm.createContext({
 window:{}, document:{createElement:()=>new Element(),createElementNS:()=>new Element(),documentElement:root},
 performance:{now:()=>clock}, Symbol,
 requestAnimationFrame:fn=>{const id=nextHandle++;frames.set(id,fn);return id;},
 cancelAnimationFrame:id=>frames.delete(id),
 setTimeout:(fn,delay)=>{const id=nextHandle++;timers.set(id,{fn,delay});return id;},
 clearTimeout:id=>timers.delete(id),
});
const advance=now=>{clock=now;const pending=[...frames.values()];frames.clear();for(const frame of pending)frame(now);};
vm.runInContext(browserCursorExpression([{x:20,y:30},{x:220,y:30},{x:220,y:130}],1000),context);
const host=root.children.at(-1);
assert.equal(host.styles['pointer-events'],'none');
assert.equal(host.attributes['aria-hidden'],'true');
assert.equal(host.shadowOptions.mode,'closed');
const sharedStyle=JSON.parse(fs.readFileSync(new URL('../src/agent-cursor-style.json',import.meta.url),'utf8'));
assert.equal(host.styles.width, (sharedStyle.width+2*sharedStyle.glow.padding)+'px');
assert.equal(host.styles.height, (sharedStyle.height+2*sharedStyle.glow.padding)+'px');
assert.equal(host.shadow.children[0].attributes.viewBox, '-33 -33 85 86');
const svgChildren=host.shadow.children[0].children;
const gradientStops=svgChildren[0].children[0].children;
assert.deepEqual(gradientStops.map(s=>({offset:Number(s.attributes.offset),color:s.attributes['stop-color'],opacity:Number(s.attributes['stop-opacity'])})), sharedStyle.glow.stops);
assert.equal(Number(svgChildren[1].attributes.r),sharedStyle.glow.radius);
assert.equal(Number(svgChildren[1].attributes.cx),sharedStyle.glow.center[0]);
assert.equal(Number(svgChildren[1].attributes.cy),sharedStyle.glow.center[1]);
const polygons=svgChildren.slice(2);
assert.equal(polygons.length,sharedStyle.layers.length);
for(let i=0;i<polygons.length;i++) {
 assert.equal(polygons[i].attributes.fill,sharedStyle.layers[i].color);
 assert.equal(polygons[i].attributes.points,sharedStyle.layers[i].points.map(p=>p.join(',')).join(' '));
}
for(const [file,pattern] of [
 ['../native/macos/agent_cursor.swift',/CGPoint\(x:\s*(-?\d+(?:\.\d+)?), y:\s*(-?\d+(?:\.\d+)?)\)/g],
]) {
 const source=fs.readFileSync(new URL(file,import.meta.url),'utf8');
 const geometry=source.slice(source.indexOf('// Shared geometry'));
 const actual=[...geometry.matchAll(pattern)].map(m=>[Number(m[1]),Number(m[2])]);
 const expected=sharedStyle.layers.flatMap(layer=>layer.points);
 assert.equal(JSON.stringify(actual),JSON.stringify(expected),file+' geometry differs from the shared cursor design');
}
const palettePatterns = [
 ['../native/macos/agent_cursor.swift', /Color\(red: (\d+)\/255, green: (\d+)\/255, blue: (\d+)\/255\)/g,
  m=>[Number(m[1]),Number(m[2]),Number(m[3])]],

];
for (const [file,pattern,rgb] of palettePatterns) {
 const source=fs.readFileSync(new URL(file,import.meta.url),'utf8');
 const actual=[...source.slice(source.indexOf('// Shared geometry')).matchAll(pattern)].map(rgb).slice(-sharedStyle.layers.length);
 const expected=sharedStyle.layers.map(layer=>layer.color.slice(1).match(/../g).map(v=>parseInt(v,16)));
 assert.deepEqual(actual,expected,file+' palette differs from the shared cursor design');
}
const macStyle=fs.readFileSync(new URL('../native/macos/agent_cursor.swift',import.meta.url),'utf8');
assert(!macStyle.includes('renderer.heading')&&!macStyle.includes('.rotated('),'Mac cursor orientation must remain fixed');

advance(250);assert.equal(host.styles.transform,'translate(85px,-4px)');
advance(500);assert.equal(host.styles.transform,'translate(185px,-4px)');
advance(1000);assert.equal(host.styles.transform,'translate(185px,96px)');
assert.equal(frames.size,0,'finished trajectory must stop scheduling frames');
assert.equal(focusCalls,0);assert.equal(inputCalls,0,'virtual cursor must never dispatch page input');
vm.runInContext(browserCursorExpression([{x:420,y:130}],500),context);
advance(1250);assert.equal(host.styles.transform,'translate(285px,96px)','next movement starts at the virtual position');
vm.runInContext(browserCursorExpression([{x:10,y:10}],0,true),context);
assert.equal(root.children.length,1,'new actions reuse the task-owned overlay');
assert.equal(host.styles.transform,'translate(-25px,-24px)');
assert.equal(frames.size,0,'superseded animation must be cancelled');
assert.equal(timers.size,1,'superseded idle timer must be cancelled');
vm.runInContext(clearBrowserCursorExpression(),context);
assert.equal(host.isConnected,false);assert.equal(frames.size,0);assert.equal(timers.size,0);

const env={platform:'windows',headless:false,image:{width:800,height:600},node:()=>undefined,center:()=>undefined,
 validatePoint(x,y){assert(Number.isFinite(x)&&Number.isFinite(y)&&x>=0&&y>=0&&x<800&&y<600);}};
const virtual=preflightActionSequence([{action:'moveMouse',x:400,y:300,path:[{x:10,y:10},{x:400,y:300}],durationMs:1200}],false,env)[0];
assert.equal(virtual.params.pointerMode,'virtual');assert.equal(virtual.needsForeground,false);
const physical=preflightActionSequence([{action:'moveMouse',x:400,y:300,pointerMode:'physical'}],false,env)[0];
assert.equal(physical.needsForeground,true);
for(const action of [{action:'moveMouse',x:1,y:1,pointerMode:'typo'},{action:'moveMouse',x:1,y:1,durationMs:-1},{action:'moveMouse',x:1,y:1,path:[{x:1,y:1}]}])
 assert.throws(()=>preflightActionSequence([action],false,env));
assert.throws(()=>browserCursorExpression([{x:NaN,y:1}]));
assert.throws(()=>browserCursorExpression([{x:1,y:1}],30001));
console.log('Virtual cursor trajectories, replacement, cleanup, focus and no-input checks passed');

// Compatibility must fail before act reaches an older native helper.
const [{macosBackend},{windowsBackend},{linuxBackend},{macosHelper},{windowsHelper},{linuxHelper}] = await Promise.all([
 import('../src/platform/macos/backend.ts'),import('../src/platform/windows/backend.ts'),import('../src/platform/linux/backend.ts'),
 import('../src/platform/macos/helper.ts'),import('../src/platform/windows/helper.ts'),import('../src/platform/linux/helper.ts'),
]);
for(const [backend,client] of [[macosBackend,macosHelper],[windowsBackend,windowsHelper],[linuxBackend,linuxHelper]]) {
 const original=client.command, calls=[];
 let supported=false;
 client.command=async(cmd,args)=>{calls.push({cmd,args});if(cmd==='cursorCapabilities')return {virtualMotion:supported};return {outcome:'worked',performed:{delivery:'virtual'}};};
 const request={lookId:'look:owned',pid:123,target:{x:20,y:30},action:'moveMouse',params:{pointerMode:'virtual',durationMs:0}};
 try {
  await assert.rejects(()=>backend.act(request),/does not support the virtual cursor/);
  assert.deepEqual(calls.map(c=>c.cmd),['cursorCapabilities'],'older helper must receive no act command');
  calls.length=0;
  await assert.rejects(()=>backend.actBatch([request]),/does not support the virtual cursor/);
  assert.deepEqual(calls.map(c=>c.cmd),['cursorCapabilities'],'batch compatibility must be checked before input');
  calls.length=0;supported=true;
  await backend.act(request);
  assert.deepEqual(calls.map(c=>c.cmd),['cursorCapabilities','act']);
  assert.equal(calls[1].args.params.pointerMode,'virtual');
  calls.length=0;
  await backend.act({...request,params:{pointerMode:'physical',durationMs:0}});
  assert.deepEqual(calls.map(c=>c.cmd),['act'],'explicit physical delivery preserves its native input route');
  if(backend===macosBackend)await backend.shutdown();
 }finally{client.command=original;}
}
console.log('All three native backends reject incompatible helpers before dispatch');
