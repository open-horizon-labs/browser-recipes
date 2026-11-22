import assert from 'node:assert/strict';

export const draftWorkflow = {
  id:'review-ticket',title:'Review ticket draft',tabs:{ticket:{adapterId:'workshop',label:'Ticket'}},
  steps:[
    {id:'read',label:'Read ticket',op:'recipe',effect:'read',tab:'ticket',recipeId:'read-ticket'},
    {id:'approve',label:'Draft ready for submission',op:'handoff',tags:['draft-ready','submission'],tab:'ticket',inputs:{title:'read.title'}},
    {id:'save',label:'Save reviewed response',op:'recipe',effect:'write',tab:'ticket',recipeId:'save-response',inputs:{message:'approve.message'}},
  ],
};

export async function verifyRuns({call,failure,tab,target,foreground,active,extensionOrigin,browser}) {
  const front = await active();
  const defs = await call('definitions.list');
  assert.ok(defs.workflows.some(w => w.id === draftWorkflow.id));
  const read = defs.recipes.find(r => r.id === 'read-ticket');
  assert.ok(read.contract.outputs.includes('title'));
  const start = await call('runs.start',{kind:'workflow',workflowId:draftWorkflow.id,tabs:{ticket:tab.tabId}});
  assert.equal(start.status,'waiting');
  assert.ok(start.pending.tags.includes('draft-ready'));
  assert.equal(start.steps[0].childRunIds.length,1);
  assert.equal(await active(),front);
  const action = {runId:start.runId,actionId:start.pending.id};
  const view = await call('runs.get',{runId:start.runId,includeData:true});
  assert.equal(view.context.inputs.title,'Ticket 42');
  const resumed = await call('runs.resume',{...action,answer:{value:{message:'confidential fixture draft'}}});
  assert.equal(resumed.pending.tag,'write');
  assert.equal((await failure('runs.resume',{...action,answer:{}})).code,'INVALID_ARGUMENTS');
  assert.notEqual(await target.locator('#saved').innerText(),'confidential fixture draft');
  const done = await call('runs.resume',{runId:start.runId,actionId:resumed.pending.id,answer:{decision:'run'}});
  assert.equal(done.status,'completed');
  assert.equal(done.result['saved-response'],'confidential fixture draft');
  assert.equal(done.steps[2].inputs.message,'approve.message');
  assert.equal(done.steps[2].childRunIds.length,1);
  assert.ok(done.actions.every(a => a.requestedAt && a.answeredAt));
  const records = await call('runs.list');
  assert.equal(records.filter(r => r.parentRunId === start.runId).length,2);
  assert.ok(!JSON.stringify(records).includes('confidential fixture draft'));
  assert.equal((await call('runs.get',{runId:start.runId,includeData:true})).result,undefined);
  assert.ok((await call('runs.list',{tag:'submission'})).some(row => row.runId === start.runId));
  const duplicate = await call('runs.start',{kind:'workflow',workflowId:draftWorkflow.id,tabs:{ticket:tab.tabId},runId:start.runId});
  assert.equal(duplicate.status,'completed');
  assert.equal(duplicate.steps[2].childRunIds.length,1);
  const removed = await call('runs.forget',{runId:start.runId});
  assert.equal(removed.deleted,3);
  assert.equal((await call('runs.list')).some(r => r.runId === start.runId || r.parentRunId === start.runId),false);
  await target.goto(new URL('/signin.html',target.url()).href);
  const needs = await call('runs.start',{kind:'recipe',adapterId:'workshop',recipeId:'read-ticket',tabId:tab.tabId});
  assert.equal(needs.pending.tag,'auth');
  assert.equal(await active(),front);
  const still = await call('runs.resume',{runId:needs.runId,actionId:needs.pending.id,answer:{}});
  assert.equal(still.pending.tag,'auth');
  // This click and focus assertion run only inside the disposable headless browser profile.
  const runsPage = await browser.newPage();
  try {
    await runsPage.goto(extensionOrigin+'/runs.html#'+needs.runId);
    await runsPage.getByRole('button',{name:/Open .*tab|Open .*sign in|Open app/i}).first().click();
    await runsPage.waitForFunction(async id => (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.id === id,tab.tabId,{timeout:5000});
    await target.goto(new URL('/ticket.html',target.url()).href);
    await foreground.bringToFront();
    const final = await call('runs.resume',{runId:needs.runId,actionId:still.pending.id,answer:{}});
    assert.equal(final.result.title,'Ticket 42');
    assert.equal(await active(),front);
  } finally { await runsPage.close(); }
  console.log('PASS shared native runs, tagged review, lineage, stale approval rejection, explicit headless sign-in handoff and data retention.');
}
