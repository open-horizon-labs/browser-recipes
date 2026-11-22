import {test} from 'node:test';
import assert from 'node:assert/strict';
import {promptView, proposeEdits} from '../extension/recipe-edit.js';

test('filters by original index and edits a surviving row without changing source evidence', () => {
  const original = {rows:[{title:'a'},{title:'b'},{title:'c'}]};
  const edited = proposeEdits(original,[{op:'remove',path:['rows',0]},{op:'replace',path:['rows',2,'title'],value:'Busy'},{op:'remove',path:['rows',1]}]);
  assert.deepEqual(edited,{rows:[{title:'Busy'}]});
  assert.equal(original.rows[2].title,'c');
});

test('omits binary input and rejects invented keys, changed types and file edits', () => {
  const data = {file:{base64:'secret',name:'a.pdf'}, count:1};
  assert.equal(JSON.stringify(promptView(data)).includes('secret'),false);
  for (const path of [['file','base64'],['extra'],['__proto__'],['count']]) {
    assert.throws(() => proposeEdits(data,[{op:'replace',path,value:'text'}]));
  }
});
