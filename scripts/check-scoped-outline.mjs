import assert from 'node:assert/strict';
import {changesBetween} from '../src/view.ts';
import {parseLookResponse, graftScopedOutline, nodeByRef, serializeOutline, restoreOutline, searchOutline} from '../src/outline.ts';
const node=(ref,title,children=[],truncated=false)=>({ref,title,role:'AXGroup',children,truncated});
const outline=root=>parseLookResponse({lookId:'test',outline:root,window:{}}).parsedOutline;
const full=outline(node('window','Window',[node('pane','Document Pane',[node('old-body','Page 1 content')]),node('save','Save')]));
const pane=full.nodes.find(n=>n.wireRef==='pane');
const old=full.nodes.find(n=>n.wireRef==='old-body');
const save=full.nodes.find(n=>n.wireRef==='save');
graftScopedOutline(full,pane.ref,outline(node('pane','Document Pane',[node('new-body','Page 1 content')])));
assert.equal(nodeByRef(full,old.ref),undefined,'replaced body reference must be retired');
assert.equal(nodeByRef(full,save.ref),save,'unrelated controls retain their identity');
assert.equal(full.nodes.filter(n=>n.title==='Page 1 content').length,1,'fresh body must not duplicate its predecessor');
const body=full.nodes.find(n=>n.wireRef==='new-body');
graftScopedOutline(full,pane.ref,outline(node('pane','Document Pane',[node('new-body','Page 1 content')])));
assert.equal(nodeByRef(full,body.ref),body,'observed matching wire identity retains its ref');
graftScopedOutline(full,pane.ref,outline(node('pane','Document Pane',[],true)));
assert.equal(nodeByRef(full,body.ref),undefined,'unobserved descendants cannot remain actionable');
assert.equal(pane.truncated,true,'partial scoped observations retain their frontier');
const restored=restoreOutline(serializeOutline(full));
graftScopedOutline(restored,pane.ref,outline(node('pane','Document Pane',[node('third-body','Page 1 content')])));
const third=restored.nodes.find(n=>n.wireRef==='third-body');
assert.ok(Number(third.ref.slice(2))>Number(body.ref.slice(2)),'retired refs cannot be reused after persistence');
assert.equal(nodeByRef(restored,old.ref),undefined);
assert.equal(nodeByRef(restored,body.ref),undefined);
console.log('PASS scoped replacement, stable identity, outside scope, partial frontier, persisted ref retirement');

// Serialized deltas must not retain a previous enabled/disabled fact when the
// native provider stops supplying that attribute.
const availability=value=>outline({...node('availability-window','Window',[{...node('control','Save'),isEnabled:value}]),role:'AXWindow'});
for(const known of [false,true]){
 const lost=changesBetween(availability(known),availability(undefined));
 assert.equal(lost.useFullView,true);
 assert.equal(lost.reason,'availability_unknown');
}
for(const [before,after] of [[undefined,false],[undefined,true],[false,true],[true,false]]){
 const changed=changesBetween(availability(before),availability(after));
 assert.equal(changed.useFullView,false);
 const serialized=JSON.parse(JSON.stringify(changed));
 assert.equal(serialized.changes.find(c=>c.type==='updated').fields.isEnabled,after);
}
console.log('PASS availability deltas retain false/true and replace the view when availability becomes unknown');

// A comparison of node-local fields must not repeatedly serialize descendants.
// Count child accesses instead of asserting noisy machine-specific timings.
let chain=node('leaf','Leaf');
for(let i=0;i<160;i++) chain=node(`group-${i}`,`Group ${i}`,[chain]);
const deepA=outline(chain),deepB=restoreOutline(serializeOutline(deepA));
let childReads=0;
for(const tree of [deepA,deepB]) for(const item of tree.nodes){
 const children=item.children;
 Object.defineProperty(item,'children',{enumerable:true,get(){childReads++;return children;}});
}
const deepDiff=changesBetween(deepA,deepB);
assert.equal(deepDiff.changedNodeCount,0);
assert.ok(childReads < 8*(deepA.nodes.length+deepB.nodes.length), 'Node comparison recursively walked descendants');
deepB.nodes.at(-1).value='Changed leaf';
const leafDiff=changesBetween(deepA,deepB);
assert.equal(leafDiff.changedNodeCount,1);
assert.equal(leafDiff.changes[0].fields.value,'Changed leaf');
assert.equal(leafDiff.changes[0].ref,deepB.nodes.at(-1).ref);
console.log('PASS deep-tree comparison has bounded child reads and preserves leaf evidence');
