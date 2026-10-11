import assert from 'node:assert/strict';
import { parseFocusContext, serializeFocusContext } from '../src/focus-context.ts';
const base = {status:'matched',scopeVerified:true,isSecure:false,isTextInput:true,wireRef:'body',selectionRange:{location:2,length:4}};
assert.deepEqual(parseFocusContext(base).selectionRange,{location:2,length:4});
for (const change of [{isSecure:true},{isSecure:undefined},{isTextInput:false},{scopeVerified:false},{status:'unobserved'},
 {selectionRange:{location:-1,length:1}},{selectionRange:{location:1.5,length:1}},{selectionRange:{location:0,length:Infinity}},
 {selectionRange:{location:100000,length:1}},{selectionRange:{location:0,length:true}}]) {
 assert.equal(parseFocusContext({...base,...change}).selectionRange,undefined);
}
const context=parseFocusContext(base);
assert.deepEqual(serializeFocusContext(context,{nodes:[{wireRef:'body',ref:'@e1'}]}).selectionRange,base.selectionRange);
assert.equal(serializeFocusContext(context,{nodes:[]}).selectionRange,undefined);
assert.equal(serializeFocusContext(context,{nodes:[{wireRef:'body',ref:'@e1'},{wireRef:'body',ref:'@e2'}]}).selectionRange,undefined);
console.log('focused selection metadata tests passed');
