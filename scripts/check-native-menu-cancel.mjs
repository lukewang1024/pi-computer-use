import assert from 'node:assert/strict';
import {preflightActionSequence, canRetryInForeground} from '../src/actions.ts';
const menu={role:'AXMenu',wireRef:'native-menu',actions:['AXCancel'],isEnabled:true,pictureOnly:false,children:[]};
const env={platform:'macos',headless:false,node(ref){assert.equal(ref,'@e1');return menu;},center(){throw Error('No coordinates allowed');},validatePoint(){throw Error('No pointer fallback allowed');}};
const result=preflightActionSequence([{action:'cancel',ref:'@e1'}],false,env)[0];
assert.deepEqual(result.target,{ref:'native-menu'});assert.deepEqual(result.params,{});
assert.equal(result.needsForeground,false);assert.equal(result.establishesFocus,false);
for(const outcome of ['worked','didnt','unknown'])assert.equal(canRetryInForeground(result,outcome,false),false);
for(const patch of [{role:'AXButton'},{role:'AXMenuItem'},{isEnabled:false},{actions:['AXPress']},{pictureOnly:true},{wireRef:undefined}])
 assert.throws(()=>preflightActionSequence([{action:'cancel',ref:'@e1'}],false,{...env,node(){return {...menu,...patch};}}),/disabled|exact native AXMenu|declare native AXCancel/);
for(const platform of ['linux','windows'])assert.throws(()=>preflightActionSequence([{action:'cancel',ref:'@e1'}],false,{...env,platform}),/macOS desktop/);
assert.throws(()=>preflightActionSequence([{action:'cancel',ref:'@e1'}],false,{...env,headless:true}),/macOS desktop/);
assert.throws(()=>preflightActionSequence([{action:'cancel'}],false,env),/element reference/);
assert.throws(()=>preflightActionSequence([{action:'cancel',ref:'@stale'}],false,env));
console.log('Native menu cancel preflight: exact AXMenu, declared action, no coordinate/foreground fallback, disabled/stale/platform refusals');
