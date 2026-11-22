import assert from 'node:assert/strict';
import test from 'node:test';
import {resolveConnection, showConnection} from '../extension/run-connection.js';
import {recipeContract, validateCatalog} from '../extension/schema.js';
import {bindingKey} from '../extension/scope.js';

const adapter = {id:'app', title:'Example', origin:'https://app.example', paths:['/app/'],
  auth:{entryPath:'/app/', paths:['/login'], origins:['https://id.example']}, recipes:[]};
const role = {adapterId:'app'};

function fixture(url) {
  const tab = {id:7,windowId:3,url};
  const calls = [];
  const storage = {approvedOrigins:[adapter.origin]};
  let identify = {ok:true,value:'account@example.com'};
  const browser = {
    tabs:{
      get: async id => {
        if (id !== tab.id) throw Error('No tab with id: ' + id);
        return tab;
      },
      query: async () => [tab],
      create: async spec => { calls.push(['create',spec]); return {id:8,windowId:3}; },
      update: async (id, spec) => { calls.push(['update',id,spec]); return tab; },
    },
    windows:{update: async (...args) => calls.push(['focus',...args])},
    storage:{local:{get: async key => ({[key]:storage[key]})}},
    permissions:{contains:async () => true},
    scripting:{executeScript: async spec => {
      calls.push(['inspect',spec.target]);
      return [{result:spec.args[0]?.op === 'identify' ? identify : true}];
    }},
  };
  return {tab,browser,calls,storage,identifyAs:value => { identify=value; }};
}
test('contract retains effective required inputs and rejects understated writes', () => {
  const recipe = {id:'edit',title:'Edit',inputs:{item:{type:'string'}},
    steps:[{op:'click',selector:'button',match:{input:'item'}},{op:'read',selector:'p',as:'result'}]};
  assert.deepEqual(recipeContract(recipe),{kind:'action',effect:'write',inputs:{item:{type:'string',required:true}},outputs:['result']});
  for (const invalid of [{effect:'read'},{kind:'Bad Kind'},{effect:'none'}]) {
    assert.throws(() => validateCatalog([{...adapter,recipes:[{...recipe,...invalid}]}]),{code:'INVALID_SCHEMA'});
  }
  for (const auth of [{entryPath:'//other.example'},{entryPath:'/app/',origins:['https://*.example']},
    {entryPath:'/app/',origins:['http://id.example']},{entryPath:'/app/',paths:['//other.example']}]) {
    assert.throws(() => validateCatalog([{...adapter,auth}]),{code:'INVALID_SCHEMA'});
  }
});
test('approved app and known auth locations stay in the background', async () => {
  for (const [url,needsAuth] of [['https://app.example/app/',false],['https://app.example/login',true],['https://id.example/login',true]]) {
    const {browser,calls}=fixture(url);
    assert.deepEqual(await resolveConnection(browser,[adapter],role,7),{adapterId:'app',tabId:7,needsAuth});
    assert.deepEqual(calls,[]);
  }
});
test('a visible signed-out marker is distinct from a missing identity; account is rechecked on resume', async () => {
  const {browser,storage,identifyAs}=fixture('https://app.example/app/');
  const withMarker = {...adapter, auth:{...adapter.auth,signedOutSelector:'.sign-in'}};
  assert.equal((await resolveConnection(browser,[withMarker],role,7)).needsAuth,true);
  const withIdentity = {...adapter, identity:{selector:'span.account'}};
  storage[bindingKey(withIdentity)]='account@example.com';
  assert.equal((await resolveConnection(browser,[withIdentity],role,7)).needsAuth,false);
  identifyAs({ok:false,code:'ACCOUNT_CHANGED'});
  await assert.rejects(resolveConnection(browser,[withIdentity],role,7),{code:'ACCOUNT_UNAVAILABLE'});
  identifyAs({ok:true,value:'other@example.com'});
  await assert.rejects(resolveConnection(browser,[withIdentity],role,7),{code:'ACCOUNT_CHANGED'});
});
test('missing or opaque tab requests neutral open-app action and never activates unknown pages', async () => {
  const {browser,calls}=fixture(undefined);
  const missing = {adapterId:'app',tabId:null,needsAuth:false,missingTab:true};
  assert.deepEqual(await resolveConnection(browser,[adapter],role,9),missing);
  assert.deepEqual(await resolveConnection(browser,[adapter],role,7),{...missing,tabId:7});
  assert.equal(await showConnection(browser,adapter,7),8);
  assert.deepEqual(calls,[['create',{url:'https://app.example/app/',active:true}],['focus',3,{focused:true}]]);
});
test('explicit sign-in handoff activates only the selected approved location', async () => {
  const {browser,tab,calls,storage}=fixture('https://id.example/sso');
  assert.equal(await showConnection(browser,adapter,7),7);
  assert.deepEqual(calls,[['update',7,{active:true}],['focus',3,{focused:true}]]);
  calls.length = 0;
  for (const url of ['https://other.example','https://app.example/other','https://id.example.attacker.test']) {
    tab.pendingUrl = url;
    await assert.rejects(resolveConnection(browser,[adapter],role,7),{code:'ORIGIN_CHANGED'});
    await assert.rejects(showConnection(browser,adapter,7),{code:'ORIGIN_CHANGED'});
  }
  storage.approvedOrigins=[];
  await assert.rejects(resolveConnection(browser,[adapter],role,7),{code:'PERMISSION_REQUIRED'});
  await assert.rejects(showConnection(browser,adapter,7),{code:'PERMISSION_REQUIRED'});
  assert.deepEqual(calls,[]);
});
test('automatic matching ignores unbound identity providers and ambiguous app tabs', async () => {
  const {browser,tab}=fixture('https://id.example/');
  assert.equal((await resolveConnection(browser,[adapter],role)).missingTab,true);
  tab.url='https://app.example/login';
  assert.equal((await resolveConnection(browser,[adapter],role)).needsAuth,true);
  tab.url='https://app.example/app/';
  browser.tabs.query=async () => [tab,{...tab,id:9}];
  await assert.rejects(resolveConnection(browser,[adapter],role),{code:'TAB_REQUIRED'});
});
test('shared provider cannot establish an unbound alternate app or bypass the original realm', async () => {
  const {browser,storage,tab}=fixture('https://id.example/sso');
  const alt={...adapter,id:'alt',origin:'https://alt.example'};
  storage.approvedOrigins.push(alt.origin);
  assert.deepEqual(await resolveConnection(browser,[adapter,alt],{adapterId:'app',alternatives:['alt']},7),
    {adapterId:'app',tabId:null,missingTab:true,needsAuth:false});
  assert.equal((await resolveConnection(browser,[alt],{adapterId:'alt'},7)).needsAuth,true);
  tab.url='https://app.example/app/';
  await assert.rejects(resolveConnection(browser,[alt],{adapterId:'alt'},7),{code:'ORIGIN_CHANGED'});
});
test('background-only adapter checks active tab even when it has no identity selector', async () => {
  const {browser,tab,calls}=fixture('https://app.example/app/');
  tab.active=true;
  await assert.rejects(resolveConnection(browser,[{...adapter,backgroundOnly:true}],role,7),{code:'ACTIVE_TAB'});
  assert.deepEqual(calls,[]);
});

test('a labeled run opens an inactive app tab, hands off sign-in, and verifies the identity on resume', async () => {
  const {findAccountTab} = await import('../extension/run-connection.js');
  const {browser,calls,identifyAs} = fixture('https://unrelated.example/');
  const a = {...adapter,identity:{selector:'.account'}};
  let opened;
  browser.tabs.create = async spec => {
    assert.deepEqual(spec,{active:false,url:adapter.origin+'/app/week'});
    opened = {id:8,url:'https://id.example/login',windowId:3,active:false};
    return opened;
  };
  browser.tabs.get = async () => opened;
  const identity = 'account@example.com';
  assert.deepEqual(await findAccountTab(browser,a,identity,null,'/app/week'),{adapterId:'app',tabId:8,needsAuth:true});
  assert.deepEqual(calls,[]);
  opened.url = adapter.origin+'/app/week';
  identifyAs({ok:true,value:'other@example.com'});
  assert.equal((await findAccountTab(browser,a,identity,8)).needsAuth,true);
  identifyAs({ok:true,value:identity});
  assert.deepEqual(await findAccountTab(browser,a,identity,8),{adapterId:'app',tabId:8});
  assert.ok(calls.every(([op])=>op==='inspect'));
});
