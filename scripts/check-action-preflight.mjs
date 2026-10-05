// Newly authored coverage of the current exported preflight contract.
import assert from 'node:assert/strict';
import {Value} from 'typebox/value';
import computerUseExtension from '../extensions/computer-use.ts';
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

// Word comment acceptance exposed these public-contract boundaries.
const editableTyping=preflightActionSequence([{action:'click',ref:'@e1'},{action:'typeText',text:'comment'},{action:'keypress',keys:['ctrl','Enter']}],false,env);
assert.equal(editableTyping[1].usesCurrentFocus,true);
assert.equal(editableTyping[2].usesCurrentFocus,true);
const pointBatch=preflightActionSequence([{action:'click',x:20,y:30},{action:'typeText',text:'comment'}],false,env);
assert.equal(pointBatch[1].usesCurrentFocus,true,'coordinate click may establish focus only within its own foreground batch');
assert.throws(()=>preflightActionSequence([{action:'typeText',text:'comment'}],false,env),/requires either ref/,'separate call must not inherit prior focus');
assert.throws(()=>preflightActionSequence([{action:'click',ref:'@e1'},{action:'typeText',text:'comment'}],false,{...env,headless:true}),/requires either ref/,'headless batch must not authorize physical current-focus typing');
const pointTyping=preflightActionSequence([{action:'typeText',x:20,y:30,text:'comment'}],false,env);
assert.deepEqual(pointTyping[0].target,{x:20,y:30});
assert.equal(pointTyping[0].establishesFocus,false);
assert.throws(()=>preflightActionSequence([{action:'typeText',x:100,y:30,text:'comment'}],false,env),/Invalid point/);

const registered=new Map();
computerUseExtension({registerTool(tool){registered.set(tool.name,tool);},registerCommand(){},on(){}});
const schema=registered.get('act_ui').parameters;
assert(Value.Check(schema,{stateId:'S1',actions:[{action:'click',x:20,y:30},{action:'typeText',text:'comment'},{action:'keypress',keys:['ctrl','Enter']}]}),'registered schema must admit current-focus keypress in the same batch');
assert(Value.Check(schema,{stateId:'S1',actions:[{action:'typeText',x:20,y:30,text:'comment'}]}),'registered schema must expose existing image-point typing');
assert(!Value.Check(schema,{stateId:'S1',actions:[{action:'typeText',x:20,text:'comment'}]}),'image-point typing must require both coordinates');
console.log('Action preflight and registered-schema regression checks passed (no native input)');

// A semantic native Mac editor click retains its exact ref; pointer gestures
// and Windows controls retain image grounding and the foreground requirement.
const focusable={...text,canFocus:true};
const macEnv={...env,platform:'macos',node(ref){if(ref!=='@e1')throw Error('Stale reference');return focusable;}};
const nativeFocus=preflightActionSequence([{action:'click',ref:'@e1'}],false,macEnv)[0];
assert.deepEqual(nativeFocus.target,{ref:'native-text'});
assert.equal(nativeFocus.needsForeground,false);
assert.equal(nativeFocus.establishesFocus,true);
assert.equal(canRetryInForeground(nativeFocus,'unknown',false),false,'unconfirmed focus must not replay as pointer input');
for(const action of [{action:'click',ref:'@e1',button:'right'},{action:'click',ref:'@e1',clickCount:2}]){
 const pointer=preflightActionSequence([action],false,macEnv)[0];
 assert.deepEqual(pointer.target,{x:20,y:30});assert.equal(pointer.needsForeground,true);
}
assert.deepEqual(preflightActionSequence([{action:'click',ref:'@e1'}],false,{...macEnv,node(){return {...focusable,canFocus:false};}})[0].target,{x:20,y:30});
assert.deepEqual(preflightActionSequence([{action:'click',ref:'@e1'}],false,{...macEnv,platform:'windows'})[0].target,{x:20,y:30});
assert.throws(()=>preflightActionSequence([{action:'click',ref:'@missing'}],false,macEnv),/Stale/);
for(const operation of ['press','click']){
 const semanticFocus=preflightActionSequence([{action:operation,ref:'@e1'}],false,{...macEnv,image:undefined})[0];
 assert.deepEqual(semanticFocus.target,{ref:'native-text'});assert.equal(semanticFocus.params.nativeFocusOnly,true);assert.equal(semanticFocus.needsForeground,false);
}
assert.equal(nativeFocus.params.nativeFocusOnly,undefined,'Image-bearing focus preserves existing routing');
for(const action of [{action:'click',ref:'@e1',button:'right'},{action:'click',ref:'@e1',clickCount:2}]){
 assert.throws(()=>preflightActionSequence([action],false,{...macEnv,image:undefined,validatePoint(){throw Error('Image required');}}),/Image/);
}
console.log('Native macOS focus routing and pointer-gesture boundaries passed');

// A focusable Word comment button without AXPress still uses pointer delivery.
const focusOnlyButton={...focusable,role:'AXButton',isTextInput:false,canPress:false,canSetValue:false,actions:[]};
const pointerRefEnv={...macEnv,node(ref){if(ref!=='@e1')throw Error('Stale reference');return focusOnlyButton;}};
for(const action of ['click','press']) {
 const prepared=preflightActionSequence([{action,ref:'@e1'}],false,pointerRefEnv)[0];
 assert.deepEqual(prepared.target,{ref:'native-text'},'keep exact native ref validation');
 assert.equal(prepared.needsForeground,true,'non-semantic pointer fallback starts in foreground');
 assert.equal(canRetryInForeground(prepared,'unknown',false),false,'unknown pointer effect is never replayed');
 assert.throws(()=>preflightActionSequence([{action,ref:'@e1'}],false,{...pointerRefEnv,image:undefined}),/image-bearing/);
 assert.throws(()=>preflightActionSequence([{action,ref:'@e1'}],false,{...pointerRefEnv,center(){return {x:101,y:30};}}),/Invalid point/);
 const semantic=preflightActionSequence([{action,ref:'@e1'}],false,{...pointerRefEnv,node(){return {...focusOnlyButton,canPress:true,actions:['AXPress']};}})[0];
 assert.equal(semantic.needsForeground,false,'AXPress controls retain semantic delivery');
 const strict=preflightActionSequence([{action,ref:'@e1'}],false,{...pointerRefEnv,headless:true,image:undefined})[0];
 assert.equal(strict.needsForeground,false,'strict headless never requests foreground');
 const windows=preflightActionSequence([{action,ref:'@e1'}],false,{...pointerRefEnv,platform:'windows'})[0];
 assert.equal(windows.needsForeground,false,'native Windows ref routing unchanged');
}
assert.throws(()=>preflightActionSequence([{action:'click',ref:'@missing'}],false,pointerRefEnv),/Stale/);
console.log('Native Mac non-AXPress pointer refs preserve foreground and no-replay boundaries');

// Native confirmation is a distinct commit operation, never a pointer press.
const confirmNode={...focusable,role:'AXComboBox',actions:['AXShowMenu','AXConfirm'],canPress:false};
const confirmEnv={...macEnv,image:undefined,node(ref){if(ref!=='@e1')throw Error('Stale reference');return confirmNode;},center(){throw Error('No coordinate fallback allowed');}};
const confirmation=preflightActionSequence([{action:'commit',ref:'@e1'}],false,confirmEnv)[0];
assert.deepEqual(confirmation.target,{ref:'native-text'});
assert.equal(confirmation.needsForeground,false);
assert.equal(confirmation.establishesFocus,false);
for(const outcome of ['worked','unknown','didnt']) assert.equal(canRetryInForeground(confirmation,outcome,false),false);
for(const platform of ['windows','linux']) assert.throws(()=>preflightActionSequence([{action:'commit',ref:'@e1'}],false,{...confirmEnv,platform}),/macOS desktop/);
assert.throws(()=>preflightActionSequence([{action:'commit',ref:'@e1'}],false,{...confirmEnv,headless:true}),/macOS desktop/);
assert.throws(()=>preflightActionSequence([{action:'commit',x:10,y:10}],false,confirmEnv),/element reference/);
assert.throws(()=>preflightActionSequence([{action:'commit',ref:'@missing'}],false,confirmEnv),/Stale/);
for(const changed of [{actions:['AXShowMenu']},{pictureOnly:true},{wireRef:undefined},{isEnabled:false}]) {
 assert.throws(()=>preflightActionSequence([{action:'commit',ref:'@e1'}],false,{...confirmEnv,node(){return {...confirmNode,...changed};}}),/AXConfirm|disabled/);
}
assert(Value.Check(schema,{stateId:'S1',actions:[{action:'commit',ref:'@e1'}]}));
assert(!Value.Check(schema,{stateId:'S1',actions:[{action:'commit',x:10,y:10}]}));
console.log('Native AXConfirm preflight, no-fallback and no-replay boundaries passed');
