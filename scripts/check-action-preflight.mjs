// Newly authored coverage of the current exported preflight contract.
import assert from 'node:assert/strict';
import {preflightActionSequence,canRetryInForeground,describeActionExecution} from '../src/actions.ts';
const text={ref:'@e1',wireRef:'native-text',role:'textbox',isTextInput:true,canSetValue:true,actions:['set_text'],children:[]};
const env={platform:'windows',headless:false,image:{width:100,height:100},
 node(ref){if(ref!=='@e1')throw Error('Stale reference');return text;},
 center(){return {x:20,y:30};},
 validatePoint(x,y){if(!Number.isFinite(x)||!Number.isFinite(y)||x<0||y<0||x>=100||y>=100)throw Error('Invalid point');}};
const sequence=preflightActionSequence([{action:'press',ref:'@e1'},{action:'keypress',keys:['ctrl','a']}],false,env);
assert.deepEqual(sequence[0].target,{x:20,y:30});
assert.equal(sequence[0].needsForeground,true,'coordinate fallback still requires foreground');
assert.equal(sequence[1].usesCurrentFocus,true);
assert.deepEqual(sequence[1].params.keys,['ctrl','a']);
assert.throws(()=>preflightActionSequence([{action:'press',ref:'@e1'},{action:'keypress',keys:['unsupported-key']}],false,env),/Unsupported/,'whole batch must be prepared before dispatch');
assert.throws(()=>preflightActionSequence([{action:'press',ref:'@e1'},{action:'keypress',keys:['ctrl','.']}],false,env),/Unsupported/,'unsafe later key must reject the batch before its first input');
assert.throws(()=>preflightActionSequence([{action:'press',ref:'@missing'}],false,env),/Stale/);
assert.throws(()=>preflightActionSequence([{action:'click',x:100,y:20}],false,env),/Invalid point/);
assert.throws(()=>preflightActionSequence([{action:'drag',ref:'@e1',path:[{x:0,y:0},{x:NaN,y:4}]}],false,env),/Invalid point/);
assert.throws(()=>preflightActionSequence([{action:'keypress',keys:['Enter']}],true,{...env,image:undefined}),/image-bearing/);
assert.throws(()=>preflightActionSequence([{action:'keypress',keys:['Enter']}],false,env),/requires either ref/);
for(const action of sequence)assert.equal(canRetryInForeground(action,'unknown',false),false,'unknown delivery must never be retried');
assert.equal(canRetryInForeground(sequence[1],'didnt',true),false,'headless execution has no foreground retry');
const failed=describeActionExecution(1,3,'didnt');
assert.match(failed,/Attempted 1 of 3/);
assert.match(failed,/no effect was observed/);
assert.match(failed,/Remaining 2 actions were not sent/);
const unknown=describeActionExecution(1,2,'unknown');
assert.match(unknown,/effect is unverified/);
assert.match(unknown,/Do not automatically repeat/);
assert.doesNotMatch(describeActionExecution(2,2,'worked'),/Remaining|unverified|no effect/);
console.log('Action preflight regression checks passed (new coverage; no native input)');
