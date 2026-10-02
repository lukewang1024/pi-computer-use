import assert from 'node:assert/strict';
import { CdpTab } from '../src/cdp.ts';

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5l0AAAAASUVORK5CYII=';

function fakeTab({width = 1, height = 1, dpr = 2, data = pixel, surfaceScale, surfaceHeightScale = surfaceScale} = {}) {
  const tab = Object.create(CdpTab.prototype);
  const calls = [];
  tab.evaluate = async expression => {
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
