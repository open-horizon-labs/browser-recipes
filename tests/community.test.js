import test from 'node:test';
import assert from 'node:assert/strict';
import {communitySelection} from '../extension/community.js';

test('workflow selection includes verification recipes on every supported host', () => {
  const adapters = ['primary','alternate','unrelated'].map(id => ({
    id,recipes:['save','verify','unrelated'].map(id => ({id})),
  }));
  const workflow = {
    tabs:{app:{adapterId:'primary',alternatives:['alternate']}},
    steps:[{op:'recipe',tab:'app',recipeId:'save',repeat:{verify:{recipeId:'verify'}}}],
  };
  const bundle = communitySelection({adapters,workflows:[workflow]},{workflow});
  assert.deepEqual(bundle.adapters.map(a => [a.id,...a.recipes.map(r => r.id)]),[
    ['primary','save','verify'],['alternate','save','verify'],
  ]);
  assert.deepEqual(bundle.workflows,[workflow]);
});
