import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { CdpTab, captureCdpPixelSnapshot } from '../src/cdp.ts';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l0AAAAASUVORK5CYII=';

function fakeTab({width = 1, height = 1, dpr = 2, data = pixel, surfaceScale, surfaceHeightScale = surfaceScale, readiness = {complete:true}} = {}) {
  const tab = Object.create(CdpTab.prototype);
  const calls = [];
  tab.evaluate = async expression => {
    if (expression.includes('requestAnimationFrame')) return readiness;
    assert.equal(expression, 'window.devicePixelRatio');
    return dpr;
  };
  tab.send = async (method, params) => {
    calls.push({method, params});
    if (method === 'Page.getLayoutMetrics') return {cssVisualViewport: {clientWidth: width, clientHeight: height, pageX: 5, pageY: 90}, ...(surfaceScale === undefined ? {} : {visualViewport: {clientWidth: width * surfaceScale, clientHeight: height * surfaceHeightScale}})};
    if (method === 'Page.captureScreenshot') return {data};
    throw Error('Unexpected CDP command: ' + method);
  };
  return {tab, calls};
}

const {tab, calls} = fakeTab();
const result = await tab.captureViewport();
assert.equal(result.data, pixel, 'capture must preserve the original screenshot bytes');
assert.equal(result.width, 1);
assert.equal(result.height, 1);
assert.equal(result.cssWidth, 1);
assert.equal(result.cssHeight, 1);
assert.deepEqual(calls[1], {method: 'Page.captureScreenshot', params: {
  format: 'png', fromSurface: true, captureBeyondViewport: false,
	clip: {x: 5, y: 90, width: 1, height: 1, scale: 1},
}});
assert.equal(calls.some(c => c.method.startsWith('Input.')), false);
for (const readiness of [null, {}, {complete:false,reason:'deadline'}, {complete:false,reason:'hidden'}, {complete:false,reason:'document-changed'}, {complete:'true'}]) {
  const fixture = fakeTab({readiness});
  await assert.rejects(() => fixture.tab.captureViewport(), /paint readiness unavailable/);
  assert.equal(fixture.calls.length, 0, 'failed paint readiness must not request a screenshot or geometry');
}

const retina = fakeTab({surfaceScale: 2});
assert.equal((await retina.tab.captureViewport()).pixelScale, 1);
assert.equal(retina.calls[1].params.clip.scale, .5, 'Retina device pixels must not double the output viewport');
const emulated = fakeTab({surfaceScale: 1, dpr: 3});
await emulated.tab.captureViewport();
assert.equal(emulated.calls[1].params.clip.scale, 1, 'page DPR must not replace actual surface metrics');
await assert.rejects(() => fakeTab({surfaceScale: 0}).tab.captureViewport(), /scales are inconsistent/);
await assert.rejects(() => fakeTab({width: 1200, height: 800, surfaceScale: 2, surfaceHeightScale: 1}).tab.captureViewport(), /scales are inconsistent/);

const wide = fakeTab({width: 3200, height: 1800, dpr: 2});
await assert.rejects(() => wide.tab.captureViewport(), /requested viewport/);
assert.equal(wide.calls[1].params.clip.scale, .5);
const wideRetina = fakeTab({width: 3200, height: 1800, surfaceScale: 2});
await assert.rejects(() => wideRetina.tab.captureViewport(), /requested viewport/);
assert.equal(wideRetina.calls[1].params.clip.scale, .25, 'large Retina viewports must retain the same output pixel budget');

await assert.rejects(() => fakeTab({width: 1200, height: 800}).tab.captureViewport(), /requested viewport/);
const invalid = fakeTab({width: 0});
await assert.rejects(() => invalid.tab.captureViewport(), /dimensions unavailable/);
assert.equal(invalid.calls.some(c => c.method === 'Page.captureScreenshot'), false);
await assert.rejects(() => fakeTab({data: 'invalid'}).tab.captureViewport(), /not a PNG/);
const huge = Buffer.from(pixel, 'base64');
huge.writeUInt32BE(2000, 16);
await assert.rejects(() => fakeTab({data: huge.toString('base64')}).tab.captureViewport(), /budget/);
console.log('CDP viewport capture checks passed');

// Pixel-only collection checks the exact document around capture without body or AX reads.
const identity = {url:'https://fixture.invalid/article',title:'Fixture',timeOrigin:123};
const image = {data:pixel,mimeType:'image/png',width:1,height:1,cssWidth:1,cssHeight:1,pixelScale:1};
function pixelTab(before=identity,after=identity) {
 const reads=[before,after],calls=[];
 return {calls,tab:{evaluate:async expression=>{
   assert.equal(expression,'({url:location.href,title:document.title,timeOrigin:performance.timeOrigin})');
   calls.push('identity');return reads.shift();
 },captureViewport:async()=>{calls.push('capture');return image;}}};
}
const stable=pixelTab();const captured=await captureCdpPixelSnapshot(stable.tab);
assert.equal(captured.image,image);
assert.deepEqual(stable.calls,['identity','capture','identity']);
for (const changed of [{...identity,url:identity.url+'#other'},{...identity,timeOrigin:124}]) {
 await assert.rejects(()=>captureCdpPixelSnapshot(pixelTab(identity,changed).tab),/document changed/);
}
for (const invalid of [null,{}, {...identity,timeOrigin:NaN},{...identity,timeOrigin:0},
 {...identity,timeOrigin:true},{...identity,url:''}]) {
 const fixture=pixelTab(invalid);
 await assert.rejects(()=>captureCdpPixelSnapshot(fixture.tab),/identity unavailable/);
 assert.deepEqual(fixture.calls,['identity'],'invalid identity must not request capture');
}
await assert.rejects(()=>captureCdpPixelSnapshot(pixelTab(identity,null).tab),/identity unavailable/);
console.log('Pixel-only CDP collection identity/drift and no-body/AX checks passed');

// Execute the actual page expression with controlled clocks, rather than a
// second implementation of the readiness logic.
function paintTab(visibility = 'visible') {
  const fixture = fakeTab({dpr:1});
  const frames = new Map(), timers = new Map();
  let sequence = 0;
  const context = {
    document:{visibilityState:visibility}, performance:{timeOrigin:123}, location:{href:'https://fixture.invalid'},
    requestAnimationFrame:fn => { const id=++sequence; frames.set(id,fn); return id; },
    cancelAnimationFrame:id => frames.delete(id),
    setTimeout:(fn,ms) => { assert.equal(ms,1200); const id=++sequence; timers.set(id,fn); return id; },
    clearTimeout:id => timers.delete(id),
  };
  fixture.tab.evaluate = async expression => expression === 'window.devicePixelRatio'
    ? 1 : await runInNewContext(expression,context);
  const flush = map => { const [id,fn]=map.entries().next().value; map.delete(id); fn(); };
  return {...fixture,context,frames,timers,frame:()=>flush(frames),deadline:()=>flush(timers)};
}
const painted=paintTab();
const painting=painted.tab.captureViewport();
assert.equal(painted.calls.length,0);
painted.frame();
assert.equal(painted.calls.length,0,'one frame must not request capture');
painted.frame();
await painting;
assert.equal(painted.frames.size,0);
assert.equal(painted.timers.size,0);
assert.equal(painted.calls.filter(c=>c.method==='Page.captureScreenshot').length,1);
const deadline=paintTab();
const timedOut=deadline.tab.captureViewport();
deadline.deadline();
await assert.rejects(timedOut,/paint readiness unavailable/);
assert.equal(deadline.frames.size,0);
assert.equal(deadline.calls.length,0);
const hidden=paintTab('hidden');
await hidden.tab.captureViewport();
assert.equal(hidden.frames.size,0);
assert.equal(hidden.timers.size,0);
assert.equal(hidden.calls.filter(c=>c.method==='Page.captureScreenshot').length,1,
  'initially hidden pages retain their existing capture path without activation');
for (const mutate of [c=>c.performance.timeOrigin++,c=>c.location.href+='?changed',c=>c.document.visibilityState='hidden']) {
  const changed=paintTab(); const pending=changed.tab.captureViewport();
  changed.frame(); mutate(changed.context); changed.frame();
  await assert.rejects(pending,/paint readiness unavailable/);
  assert.equal(changed.calls.length,0);
  assert.equal(changed.timers.size,0);
}
console.log('Actual capture paint expression: two frames, bounded deadline, identity drift and background compatibility passed');
