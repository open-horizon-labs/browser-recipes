import {accountFor} from './accounts.js';
import {createRunDataStore} from './run-data-store.js';
import { driveWorkflow, validateWorkflowAction } from './workflow-execution.js';
import { findAccountTab, findRecipeTab, resolveConnection, showConnection } from './run-connection.js';
import { recipeContract, RecipeError, validateInputs, record } from './schema.js';
import { roleAdapters, workflowInputs } from './workflow.js';
import { agentDocumentInputs } from './workflow-documents.js';

const prefix = 'run-record/';
const sessionPrefix = 'run-data/';
const ended = new Set(['completed','failed','cancelled','interrupted']);
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const requireValue = (condition, message) => { if (!condition) throw new RecipeError('INVALID_ARGUMENTS',message); };
const pause = Symbol('pause');

async function revision(value) {
  const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
}
function stepInfo(step) {
  const refs = {...step.inputs};
  if (step.repeat) refs.$items = step.repeat.items;
  return {id:step.id,label:step.label,op:step.op,inputs:refs,startedAt:now(),childRunIds:[]};
}
function definitionFor(bundle,args) {
  if (args.kind === 'workflow') {
    const workflow = bundle.workflows.find(x => x.id === args.workflowId);
    requireValue(workflow,'Unknown workflow.');
    const needed = new Set(Object.values(workflow.tabs).flatMap(roleAdapters));
    return {workflow,dependencies:bundle.adapters.filter(a => needed.has(a.id)),title:workflow.title,id:workflow.id};
  }
  requireValue(args.kind === 'recipe','Choose a recipe or workflow.');
  const adapter = bundle.adapters.find(x => x.id === args.adapterId);
  const recipe = adapter?.recipes.find(x => x.id === args.recipeId);
  requireValue(recipe,'Unknown recipe.');
  validateInputs(recipe,args.inputs ?? {});
  return {adapter,recipe,title:recipe.title,id:recipe.id};
}
function workflowFields(workflow, inputs = {}) {
  requireValue(record(inputs),'Provide a workflow inputs object.');
  if (!workflow.inputs) {
    for (const id of Object.keys(inputs)) requireValue(workflow.steps.some(s => s.id === id && s.fields),'Unknown workflow input: ' + id);
    return inputs;
  }
  const fields = {};
  for (const [key,value] of Object.entries(inputs)) {
    requireValue(Object.hasOwn(workflow.inputs,key),'Unknown workflow input: ' + key);
    const [step,field] = workflow.inputs[key].split('.');
    (fields[step] ??= {})[field] = value;
  }
  return fields;
}
function cleanError(error) {
  return {code:error?.code ?? 'RUN_FAILED',message:error?.message ?? 'Run failed.'};
}
export function createRunService({browser,loadBundle,dispatch,allowModel,allowRecipeModel,plan}) {
  const active = new Set();
  const local = browser.storage.local, session = createRunDataStore(browser);
  const key = id => prefix + id;
  const skey = id => sessionPrefix + id;
  const save = run => local.set({[key(run.runId)]:run});
  const dataSave = (id,data) => session.set({[skey(id)]:data});
  const getData = async id => (await session.get(skey(id)))[skey(id)];
  const hasData = async id => Object.hasOwn(await browser.storage.session.get(skey(id)),skey(id));
  async function get(id) {
    requireValue(typeof id === 'string','Provide a run ID.');
    const run = (await local.get(key(id)))[key(id)];
    requireValue(run,'Run not found.');
    if (!ended.has(run.status) && !run.interactive && !active.has(id) &&
        (run.status === 'running' || !await hasData(id))) {
      if (run.status === 'running' && await hasData(id)) {
        // Reads can replay. Writes checkpoint uncertainty before dispatch and will ask for verification.
        const actionId = 'interrupt-' + (run.resumedAt ?? run.startedAt);
        run.status = 'waiting';
        run.pending = {id:actionId,tag:'interrupt-check',tags:['interrupt-check'],label:'Review interrupted run'};
        run.actions ??= [];
        run.actions.push({id:actionId,label:run.pending.label,tags:run.pending.tags,status:'requested',requestedAt:now()});
      } else {
        run.status = 'interrupted';
        run.finishedAt = now();
        run.error = {code:'INTERRUPTED',message:'Execution was interrupted. Check the destination before starting another run.'};
        delete run.pending;
      }
      await save(run);
    }
    return run;
  }
  async function list() {
    const keys = local.getKeys ? await local.getKeys() : Object.keys(await local.get(null));
    return (await Promise.all(keys.filter(k => k.startsWith(prefix)).map(k => get(k.slice(prefix.length)))))
      .sort((a,b) => b.startedAt.localeCompare(a.startedAt));
  }
  function base(def,args,caller,id=uuid()) {
    return {runId:id,kind:args.kind,definitionId:def.id,title:def.title,caller,startedAt:now(),status:'running',steps:[],
      ...(args.adapterId ? {adapterId:args.adapterId} : {})};
  }
  async function child(args,parent,step,caller,pinnedRevision,identity) {
    const bundle = await loadBundle();
    const def = definitionFor(bundle,{kind:'recipe',...args});
    const run = base(def,{kind:'recipe',...args},caller);
    if (parent) Object.assign(run,{parentRunId:parent.runId,parentStep:step?.id});
    run.revision = pinnedRevision ?? await revision([def.adapter,def.recipe]);
    run.tabId = args.tabId;
    run.inputs = Object.keys(args.inputs ?? {});
    active.add(run.runId);
    try {
      await save(run);
      if (step && parent) {
        step.childRunIds.push(run.runId);
        await save(parent);
      }
      const result = await dispatch('run',args,run.runId,identity);
      run.status = 'completed';
      run.outputs = Object.keys(result.outputs);
      return {...result,runId:run.runId,adapterId:args.adapterId};
    } catch (error) {
      run.status = 'failed';
      run.error = cleanError(error);
      if (error.details?.runId) run.failureLogId = error.details.runId;
      throw error;
    } finally {
      run.finishedAt = now();
      try { await save(run); } finally { active.delete(run.runId); }
    }
  }
  async function start(args,caller,interactive=false) {
    const bundle = await loadBundle();
    const def = definitionFor(bundle,args);
    const id = args.runId ?? uuid();
    requireValue(typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id),'Invalid run ID.');
    return navigator.locks.request(key(id),async () => {
      const old = (await local.get(key(id)))[key(id)];
      if (old) {
        requireValue(old.interactive === interactive && old.definitionId === def.id && old.kind === args.kind && old.adapterId === args.adapterId,'Run ID already in use.');
        return get(id);
      }
      const labels = def.workflow ? args.accounts : (args.account === undefined ? {} : {target:args.account});
      requireValue(!def.workflow || args.account === undefined,'Use accounts keyed by workflow role.');
      requireValue(def.workflow || args.accounts === undefined,'Use account for a recipe.');
      requireValue(labels === undefined || record(labels),'Provide account labels keyed by workflow role.');
      const roles = def.workflow?.tabs ?? {target:{adapterId:def.adapter.id}};
      const named = {};
      for (const [role,label] of Object.entries(labels ?? {})) {
        requireValue(Object.hasOwn(roles,role) && args.tabs?.[role] == null && (def.workflow || args.tabId == null),
          'Choose an account or a tab for each declared role.');
        const candidates = (def.dependencies ?? [def.adapter]).filter(a=>roleAdapters(roles[role]).includes(a.id));
        const {adapter,identity} = await accountFor(browser,candidates,label);
        named[role] = {label,adapterId:adapter.id,identity};
      }
      const run = base(def,args,caller,id);
      run.revision = await revision(def.workflow ? [def.workflow,def.dependencies] : [def.adapter,def.recipe]);
      run.interactive = interactive;
      const data = {named,args,entries:{},answers:{},tabs:{...args.tabs},retainData:args.retainData === true};
      if (!def.workflow) data.tabs.target = args.tabId ?? null;
      active.add(id);
      try {
        if (!interactive) await dataSave(id,data);
        await save(run);
        return interactive ? run : await drive(run,data,def);
      } finally { active.delete(id); }
    });
  }
  async function drive(run,data,def) {
    const id = run.runId;
    const entries = new Map(Object.entries(data.entries));
    const roles = def.workflow?.tabs ?? {target:{adapterId:def.adapter.id}};
    const adapters = def.dependencies ?? [def.adapter];
    const resolved = {};
    const touch = step => {
      let entry = run.steps.find(e => e.id === step.id);
      if (!entry) { entry = stepInfo(step); run.steps.push(entry); }
      return entry;
    };
    async function ask(step,tag,context) {
      const actionKey = context.id;
      if (Object.hasOwn(data.answers,actionKey)) return data.answers[actionKey];
      data.actionKey = actionKey;
      data.context = ['edit-inputs','edit-outputs'].includes(tag) ? {
        ...context,adapterId:resolved[step.tab],recipeId:step.recipeId,
      } : context;
      if (step) touch(step);
      run.pending = {id:uuid(),tag,stepId:step?.id,label:context.label ?? step?.label ?? run.title,
        tags:[...new Set([tag,...(context.tags ?? [])])],
        ...(Number.isInteger(context.tabId) ? {tabId:context.tabId} : {})};
      if (['auth','account-review','background-tab','open-app'].includes(tag) && browser.runtime?.getURL)
        run.pending.reviewUrl = browser.runtime.getURL('runs.html') + '#' + id;
      run.status = 'waiting';
      run.actions ??= [];
      run.actions.push({id:run.pending.id,stepId:step?.id,tags:run.pending.tags,label:run.pending.label,status:'requested',requestedAt:now()});
      await dataSave(id,data);
      await save(run);
      throw pause;
    }
    try {
      for (const [role,definition] of Object.entries(roles)) {
        const boundRole = data.connections?.[role] ? {adapterId:data.connections[role]} : definition;
        let connection;
        try {
          const named = data.named?.[role];
          if (named) {
            const {adapter,identity} = await accountFor(browser,adapters.filter(a=>a.id===named.adapterId),named.label);
            requireValue(identity === named.identity,'The account label changed. Start a new run.');
            const recipeId = def.recipe?.id ?? def.workflow.steps.find(s=>s.tab===role && s.op==='recipe')?.recipeId;
            const entry = adapter.recipes.find(r=>r.id===recipeId);
            const entryPath = data.connections?.[role] && data.entries && Object.values(data.entries).some(e=>!e.pending)
              ? undefined : entry?.entryPath;
            connection = await findAccountTab(browser,adapter,identity,data.tabs[role],entryPath,entry?.accountPrefix);
          } else if (def.recipe && data.args.autoConnect === true) {
            connection = await findRecipeTab(browser,def.adapter,def.recipe,data.tabs[role]);
          } else connection = await resolveConnection(browser,adapters,boundRole,data.tabs[role]);
        } catch (error) {
          if (!['ACCOUNT_CHANGED','ACTIVE_TAB'].includes(error.code)) throw error;
          const key = 'connection/' + role;
          delete data.answers[key];
          await ask(null,error.code === 'ACCOUNT_CHANGED' ? 'account-review' : 'background-tab',{
            id:key,role,adapterId:boundRole.adapterId,tabId:data.tabs[role],label:error.message});
        }
        data.connections ??= {};
        data.connections[role] = connection.adapterId;
        data.tabs[role] = connection.tabId;
        resolved[role] = connection.adapterId;
        if (connection.needsBackground || connection.needsAuth || connection.missingTab) {
          const reason = connection.needsBackground ? 'background-tab' : connection.missingTab ? 'open-app' : 'auth';
          // Recheck the actual session on every resume. An acknowledgement is never proof of identity.
          const actionKey = 'connection/' + role;
          delete data.answers[actionKey];
          await ask(null,reason,{id:actionKey,role,adapterId:connection.adapterId,tabId:connection.tabId,
            label:connection.needsBackground ? 'Switch to another tab, then resume' : connection.missingTab ? 'Open ' + (definition.label ?? def.title) : 'Sign in to ' + (data.named?.[role]?.label ?? definition.label ?? def.title)});
        }
      }
      // A standalone recipe uses the same approval and uncertainty checkpoints as a workflow step.
      const program = def.workflow ?? {steps:[{id:def.recipe.id,label:def.title,op:'recipe',tab:'target',
        recipeId:def.recipe.id,effect:recipeContract(def.recipe).effect}]};
      await driveWorkflow({workflow:program,reviewRecipes:data.args.reviewRecipes === true,recipeInputs:def.recipe ? {[def.recipe.id]:data.args.inputs ?? {}} : {},tabs:new Map(Object.entries(data.tabs)),results:entries,
        initialInputs:def.workflow ? workflowFields(def.workflow,data.args.inputs) : {},
        executeRecipe:async (step,inputs,tabId) => {
          const item = touch(step);
          if (!def.workflow) {
            const response = await dispatch('run',{tabId,adapterId:def.adapter.id,recipeId:def.recipe.id,inputs},run.runId,data.named?.target?.identity);
            return {...response,adapterId:def.adapter.id};
          }
          return child({tabId,adapterId:resolved[step.tab],recipeId:step.recipeId,inputs},run,item,run.caller,undefined,data.named?.[step.tab]?.identity);
        },
        requestAction:ask,
        checkpoint:async (step,entry) => {
          const item = touch(step);
          data.entries[step.id] = entry;
          if (!entry.pending) Object.assign(item,{finishedAt:now(),outputs:record(entry.value) ? Object.keys(entry.value) : []});
          await dataSave(id,data);
          await save(run);
        }});
      const outputs = program.outputs ? workflowInputs({inputs:program.outputs},entries) : entries.get(program.steps.at(-1).id)?.value;
      Object.assign(run,{status:'completed',finishedAt:now(),outputs:record(outputs) ? Object.keys(outputs) : []});
      if (data.retainData) await dataSave(id,{outputs,entries:data.entries});
      else await session.remove(skey(id));
      await save(run);
      return {...run,result:outputs};
    } catch (error) {
      if (error === pause) return run;
      Object.assign(run,{status:'failed',finishedAt:now(),error:cleanError(error)});
      if (error.details?.runId) run.failureLogId = error.details.runId;
      if (!data.retainData) await session.remove(skey(id));
      await save(run);
      return run;
    }
  }
  async function checkedDefinition(data,run) {
    const bundle = await loadBundle();
    const def = definitionFor(bundle,data.args);
    const version = await revision(def.workflow ? [def.workflow,def.dependencies] : [def.adapter,def.recipe]);
    if (version !== run.revision) throw new RecipeError('DEFINITION_CHANGED','The installed definition changed. Cancel this run and review a new run.');
    return def;
  }
  async function service(command,args={},caller='browser') {
    if (command === 'definitions.list') {
      const bundle = await loadBundle();
      return {
        recipes:bundle.adapters.flatMap(a => a.recipes.map(r => ({kind:'recipe',adapterId:a.id,id:r.id,title:r.title,contract:recipeContract(r)}))),
        workflows:bundle.workflows.map(w => ({kind:'workflow',id:w.id,title:w.title,description:w.description ?? '',tabs:w.tabs,
          inputs:w.inputs ? Object.fromEntries(Object.entries(w.inputs).map(([key,ref]) => {
            const [id,field] = ref.split('.');
            return [key,w.steps.find(step => step.id === id).fields[field]];
          })) : Object.fromEntries(w.steps.filter(s => s.fields).map(s => [s.id,s.fields])),
          outputs:w.outputs ?? {result:w.steps.at(-1).id},
          steps:w.steps.map(s => ({id:s.id,label:s.label,op:s.op,inputs:s.inputs ?? {},recipeId:s.recipeId,effect:s.effect,tags:s.tags}))})),
      };
    }
    if (command === 'runs.list') {
      const records = await list();
      return records.filter(run => (!args.kind || run.kind === args.kind) && (!args.status || run.status === args.status) &&
        (!args.parentRunId || run.parentRunId === args.parentRunId) &&
        (!args.tag || run.actions?.some(a => a.tags.includes(args.tag))));
    }
    if (command === 'runs.start') return start(args,caller);
    if (command === 'runs.interactiveBegin') return start({...args,kind:'workflow'},caller,true);
    if (command === 'run') {
      // Preserve the original blocking recipe protocol and result shape.
      const {parentRunId,parentStepId,...request} = args;
      if (!parentRunId && Object.hasOwn(request,'account')) {
        const run = await start({...request,kind:'recipe'},caller);
        if (run.status === 'failed') throw new RecipeError(run.error.code,run.error.message,{runId:run.runId});
        if (run.status !== 'completed') return run;
        return {runId:run.runId,adapterId:request.adapterId,outputs:run.result};
      }
      if (!parentRunId) return child(request,null,null,caller);
      return navigator.locks.request(key(parentRunId),async () => {
        const parent = await get(parentRunId);
        requireValue(parent.interactive && parent.status === 'running','Parent run is no longer active.');
        const workflow = (await loadBundle()).workflows.find(w => w.id === parent.definitionId);
        const step = workflow?.steps.find(s => s.id === parentStepId);
        requireValue(step?.op === 'recipe' && roleAdapters(workflow.tabs[step.tab]).includes(request.adapterId) &&
          [step.recipeId,step.repeat?.verify?.recipeId].includes(request.recipeId),'Recipe differs from the parent step.');
        let item = parent.steps.find(i => i.id === parentStepId);
        if (!item) { item = stepInfo(step); parent.steps.push(item); }
        return child(request,parent,item,caller);
      });
    }
    const id = args.runId;
    if (command === 'runs.get') {
      const run = await get(id);
      if (!args.includeData) return run;
      const data = await getData(id);
      return {...run,entries:data?.entries,result:data?.outputs,
        ...(data?.context && run.pending ? {context:data.context,pending:{...run.pending,context:data.context}} : {})};
    }
    return navigator.locks.request(key(id),async () => {
      const run = await get(id);
      if (command === 'runs.forget') {
        requireValue(ended.has(run.status) && !run.parentRunId,'Delete a finished top-level run.');
        const family = (await list()).filter(item => item.parentRunId === id || item.runId === id);
        for (const item of family) {
          await session.remove(skey(item.runId));
          await local.remove(key(item.runId));
        }
        return {deleted:family.length};
      }
      if (command === 'runs.cancel') {
        requireValue(!ended.has(run.status),'This run has already ended.');
        run.status = 'cancelled';
        run.finishedAt = now();
        delete run.pending;
        await save(run);
        await session.remove(skey(id));
        return run;
      }
      if (command === 'runs.interactiveStep') {
        requireValue(run.interactive && run.status === 'running','This interactive run is closed.');
        const workflow = (await loadBundle()).workflows.find(w => w.id === run.definitionId);
        const step = workflow?.steps.find(s => s.id === args.stepId);
        requireValue(step,'Unknown workflow step.');
        const previous = workflow.steps.slice(0,workflow.steps.indexOf(step));
        requireValue(previous.every(s => run.steps.some(i => i.id === s.id && i.finishedAt)),'Previous steps have not completed.');
        let item = run.steps.find(i => i.id === step.id);
        if (!item) { item = stepInfo(step); run.steps.push(item); }
        item.finishedAt ??= now();
        if (args.childRunId && !item.childRunIds.includes(args.childRunId)) {
          const childRun = await get(args.childRunId);
          requireValue(childRun.parentRunId === run.runId,'Child run belongs to another workflow.');
          item.childRunIds.push(args.childRunId);
        }
        if (workflow.steps.at(-1).id === step.id) Object.assign(run,{status:'completed',finishedAt:item.finishedAt});
        await save(run);
        return run;
      }
      requireValue(run.status === 'waiting' && run.pending?.id === args.actionId,'This action is stale. Read the current run before continuing.');
      const data = await getData(id);
      requireValue(data,'The private session for this run has ended.');
      const def = await checkedDefinition(data,run);
      const pending = run.pending;
      const tag = pending.tag;
      const step = def.workflow?.steps.find(s => s.id === pending.stepId);
      const role = data.context?.role ?? step?.tab ?? (!def.workflow ? 'target' : undefined);
      const adapters = def.dependencies ?? [def.adapter];
      if (command === 'runs.open') {
        requireValue(role,'This action has no browser tab.');
        const adapterId = data.context.adapterId ?? data.connections?.[role];
        const adapter = adapters.find(a => a.id === adapterId);
        requireValue(adapter,'The selected connection is unavailable.');
        data.tabs[role] = await showConnection(browser,adapter,data.tabs[role]);
        data.context.tabId = data.tabs[role];
        pending.tabId = data.tabs[role];
        await dataSave(id,data);
        await save(run);
        return run;
      }
      if (command === 'runs.editPlan' || command === 'runs.editReview') {
        requireValue(['edit-inputs','edit-outputs'].includes(tag),'No recipe edit is pending.');
        const adapterId = data.connections[role];
        if (def.workflow) await allowModel(def.workflow,step,new Map(Object.entries(data.entries)),adapterId);
        else await allowRecipeModel(adapterId);
        if (command === 'runs.editReview') return {allowed:true};
        return plan('plan',{model:args.model,prompt:args.prompt});
      }
      if (['runs.agent','runs.agentReview'].includes(command)) {
        requireValue(tag === 'agent' && step?.op === 'agent','An inference action is not pending.');
        const entries = new Map(Object.entries(data.entries));
        await allowModel(def.workflow,step,entries);
        const docs = agentDocumentInputs(workflowInputs(step,entries));
        if (command === 'runs.agentReview') return {inputs:docs.inputs,attachments:docs.attachments.map(({name,mimeType},i) => ({name,mimeType,index:i+1}))};
        const indices = args.attachmentIndices ?? [];
        requireValue(Array.isArray(indices) && new Set(indices).size === indices.length &&
          indices.every(i => Number.isInteger(i) && i > 0 && i <= docs.attachments.length),'Unknown attachment.');
        try {
          return await plan('plan',{model:args.model,prompt:args.prompt,attachments:indices.map(i => docs.attachments[i-1])});
        } catch (error) {
          if (typeof error.code === 'string') throw new RecipeError(error.code,error.message);
          throw error;
        }
      }
      requireValue(command === 'runs.resume','Unknown run operation.');
      if (!['auth','open-app','account-review','background-tab','interrupt-check'].includes(tag)) {
        if (tag === 'agent') await allowModel(def.workflow,step,new Map(Object.entries(data.entries)));
        validateWorkflowAction(tag,data.context,args.answer);
        data.answers[data.actionKey] = args.answer;
      }
      const action = run.actions?.find(a => a.id === pending.id);
      if (action) Object.assign(action,{answeredAt:now(),status:'answered'});
      delete run.pending;
      delete data.context;
      delete data.actionKey;
      run.status = 'running';
      run.resumedAt = now();
      active.add(id);
      try {
        await dataSave(id,data);
        await save(run);
        return await drive(run,data,def);
      } finally { active.delete(id); }
    });
  }
  return service;
}
