import { runConnector } from './connector.js';
import { proposeEdits } from './recipe-edit.js';
import { record, RecipeError } from './schema.js';
import { executeTransform, workflowInputs } from './workflow.js';
import { agentDocumentInputs } from './workflow-documents.js';
import { canWrite, checkpointSummary, currentItem, mapItemInputs, updateCheckpoint, writeItems } from './write-session.js';

function invalid(message) {
  return new RecipeError('INVALID_WORKFLOW_INPUT', message);
}

function lookup(values, key) {
  return values instanceof Map ? values.get(key) : Object.hasOwn(values ?? {}, key) ? values[key] : undefined;
}

function fieldsFor(specs, submitted) {
  if (!record(submitted)) throw invalid('Provide the requested fields.');
  for (const key of Object.keys(submitted)) {
    if (!Object.hasOwn(specs, key)) throw invalid('Unknown field: ' + key);
  }
  return Object.fromEntries(Object.entries(specs).map(([key, spec]) => {
    const value = Object.hasOwn(submitted, key) ? submitted[key] : spec.default ?? (spec.type === 'checkbox' ? false : '');
    if (spec.type === 'checkbox') {
      if (typeof value !== 'boolean') throw invalid('Choose a checkbox value for ' + spec.label + '.');
    } else {
      if (typeof value !== 'string' || (spec.required !== false && !value.trim())) throw invalid('Complete ' + spec.label + '.');
      if (spec.type === 'date' && value && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000') ||
          !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) {
        throw invalid('Enter a valid date for ' + spec.label + '.');
      }
    }
    return [key, value];
  }));
}

export function validateWorkflowAction(tag, context, answer) {
  if (!record(answer)) throw invalid('Provide a response to the pending action.');
  switch (tag) {
    case 'fields':
      fieldsFor(context.spec, { ...context.fields, ...(record(answer.fields) ? answer.fields : answer) });
      break;
    case 'selection': {
      const { indices } = answer;
      const count = context.choices.length;
      if (!Array.isArray(indices) || (count > 0 && !indices.length) || new Set(indices).size !== indices.length ||
          indices.some(index => !Number.isInteger(index) || index < 0 || index >= count)) {
        throw invalid('Choose from the listed items.');
      }
      break;
    }
    case 'write':
      if (!['run', 'skip'].includes(answer.decision)) throw invalid('Choose whether to run or skip this write.');
      break;
    case 'uncertain-write':
      if (!['mark-applied', 'mark-not-applied', 'skip', ...(context.canVerify ? ['verify'] : [])].includes(answer.decision)) {
        throw invalid('Review this write before continuing.');
      }
      break;
    case 'edit-inputs':
    case 'edit-outputs': {
      if (!Array.isArray(answer.edits)) throw invalid('Provide a list of reviewed edits.');
      const proposed = answer.edits.length ? proposeEdits(context.data, answer.edits) : context.data;
      if (tag === 'edit-inputs') checkedFields(context.spec, proposed);
      return proposed;
    }
    case 'agent':
      if (!Object.hasOwn(answer, 'value') || answer.value === undefined) throw invalid('Provide a JSON result for the reviewed agent step.');
      break;
    case 'handoff':
      break;
    default:
      throw invalid('Unknown workflow action: ' + tag);
  }
}

function sourceNames(step, results) {
  const refs = [...Object.values(step.inputs ?? {}), ...(step.repeat ? [step.repeat.items] : [])];
  return [...new Set([
    ...(step.op === 'connector' ? [step.connector] : []),
    ...refs.flatMap(ref => results.get(ref.split('.')[0])?.sources ?? []),
  ])];
}

function auditOf({ runId, adapterId }) {
  return { ...(runId === undefined ? {} : { runId }), ...(adapterId === undefined ? {} : { adapterId }) };
}

function itemBindings(spec, item, index) {
  if (spec.map) return mapItemInputs(spec.map, item.raw, index);
  return spec.input ? { [spec.input]: item.value } : {};
}

function checkedFields(spec, inputs) {
  return fieldsFor(spec, Object.fromEntries(Object.keys(spec).map(key => [key, inputs[key]])));
}

function bindRecipeInputs(inputs, fields) {
  return { ...inputs, ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, String(field)])) };
}

async function reviewInputs({ ask, enabled, inputs, spec, tabId, item, suffix }) {
  if (!enabled || !Object.keys(inputs).length) return { data: inputs, modified: false };
  const context = { data: inputs, spec, tabId, ...(item ? { item } : {}) };
  const { edits, proposed } = await ask('edit-inputs', context, suffix);
  return { data: proposed, modified: edits.length > 0 };
}

async function driveWrites({ step, inputs, fields, tabId, state, ask, save, executeRecipe, reviewRecipes }) {
  const { repeat } = step;
  const items = repeat ? writeItems(state.items, repeat) : [{ label: step.label }];
  let write = state.write ?? {
    status: items.map(() => 'pending'),
    attempts: items.map(() => 0),
    checks: items.map(() => 0),
    audits: items.map(() => null),
  };
  const spec = step.fields ?? {};
  let completedFields = fields;
  const store = async () => save({ pending: true, fields: repeat ? fields : completedFields, write });
  for (let index = currentItem(write); index !== -1; index = currentItem(write)) {
    const item = items[index];
    const attempt = write.attempts[index];
    const itemContext = repeat ? { index, count: items.length, label: item.label } : undefined;
    const unreviewed = { ...inputs, ...fields, ...(repeat ? itemBindings(repeat, item, index) : {}) };
    let approved = write.approved ?? { data: unreviewed, modified: false };
    if (canWrite(write.status[index])) {
      approved = await reviewInputs({ ask, enabled: reviewRecipes, inputs: unreviewed, spec, tabId, item: itemContext,
        suffix: repeat ? [index, attempt] : [attempt] });
    }
    const actualFields = checkedFields(spec, approved.data);
    const bound = bindRecipeInputs(approved.data, actualFields);
    const context = { inputs: bound, fields: actualFields, tabId, ...(itemContext ? { item: itemContext } : {}) };
    if (canWrite(write.status[index])) {
      const answer = await ask('write', context, [index, attempt]);
      if (answer.decision === 'skip') {
        write = updateCheckpoint(write, index, 'skip');
      } else {
        write = updateCheckpoint(write, index, 'begin');
        if (approved.modified) write.approved = approved;
        await store();
        let reply;
        try {
          reply = await executeRecipe(step, bound, tabId);
        } catch {
          continue;
        }
        write = updateCheckpoint(write, index, 'confirm');
        write.audits = write.audits.map((prior, i) => i === index ? auditOf(reply) : prior);
        delete write.approved;
        if (!repeat) return { value: reply.outputs, audit: write.audits[index], fields: actualFields };
      }
    } else {
      const answer = await ask('uncertain-write', {
        ...context, canVerify: Boolean(repeat?.verify) && !approved.modified, verificationFailed: write.checks[index] > 0,
      }, [index, attempt, write.checks[index]]);
      switch (answer.decision) {
        case 'mark-applied':
          write = updateCheckpoint(write, index, 'confirm');
          completedFields = actualFields;
          break;
        case 'mark-not-applied':
          write = updateCheckpoint(write, index, 'missing');
          write.attempts = write.attempts.map((prior, i) => i === index ? prior + 1 : prior);
          write.checks = write.checks.map((prior, i) => i === index ? 0 : prior);
          break;
        case 'skip':
          write = updateCheckpoint(write, index, 'skip');
          break;
        case 'verify': {
          const verify = repeat?.verify;
          let reply;
          try {
            reply = await executeRecipe({ ...step, recipeId: verify.recipeId, effect: 'read', repeat: undefined },
              itemBindings(verify, item, index), tabId);
          } catch {
            // An unavailable check leaves the write uncertain.
          }
          if (reply && Object.hasOwn(reply.outputs ?? {}, verify.output) && Object.is(reply.outputs[verify.output], verify.equals)) {
            write = updateCheckpoint(write, index, 'confirm');
            write.audits = write.audits.map((prior, i) => i === index ? auditOf(reply) : prior);
          } else {
            write = { ...write, checks: write.checks.map((prior, i) => i === index ? prior + 1 : prior) };
          }
          break;
        }
      }
      if (write.status[index] !== 'uncertain') delete write.approved;
    }
    await store();
  }
  if (!repeat) return { value: null, audit: { status: write.status[0] }, fields: completedFields };
  const last = write.audits.filter(Boolean).at(-1);
  return { value: checkpointSummary(write), audit: { ...last, items: write.audits } };
}

/**
 * Run a validated workflow against pre-bound tabs. A requestAction callback can throw to pause.
 * The caller serializes drivers for a run and durably checkpoints entries before returning.
 */
export async function driveWorkflow({
  workflow, tabs, results = new Map(), executeRecipe, requestAction, checkpoint, initialInputs = {}, executeConnector = runConnector,
  reviewRecipes = false, recipeInputs = {},
}) {
  for (const step of workflow.steps) {
    const prior = results.get(step.id);
    if (prior && !prior.pending) continue;
    const references = workflowInputs(step, results);
    const inputs = step.op === 'recipe' ? { ...references, ...lookup(recipeInputs, step.id) } : references;
    const tabId = step.tab ? lookup(tabs, step.tab) : undefined;
    if (step.tab && !Number.isSafeInteger(tabId)) throw invalid('Bind an open tab to ' + step.tab + '.');
    const ask = async (tag, context, suffix = []) => {
      const answer = await requestAction(step, tag, { ...context, id: [step.id, tag, ...suffix].join(':') });
      const proposed = validateWorkflowAction(tag, context, answer);
      return proposed === undefined ? answer : { ...answer, proposed };
    };
    const save = async state => {
      await checkpoint(step, state);
      results.set(step.id, state);
    };
    const specs = step.fields ?? {};
    let fields = prior?.fields;
    if (fields === undefined) {
      let supplied = lookup(initialInputs, step.id) ?? {};
      if (!record(supplied)) throw invalid('Provide the requested fields.');
      if (Object.keys(specs).some(key => !Object.hasOwn(supplied, key))) {
        const answer = await ask('fields', { spec: specs, fields: supplied });
        supplied = { ...supplied, ...(record(answer?.fields) ? answer.fields : answer) };
      }
      fields = fieldsFor(specs, supplied);
      if (Object.keys(fields).length) await save({ pending: true, fields });
    }

    let value;
    let selected = [];
    let audit;
    switch (step.op) {
      case 'recipe':
        if (prior?.outputReview) {
          ({ value, audit } = prior.outputReview);
        } else if (step.effect === 'write') {
          const items = step.repeat ? workflowInputs({ inputs: { items: step.repeat.items } }, results).items : undefined;
          const write = await driveWrites({
            step, inputs, fields, tabId, state: { ...prior, items }, ask, save, executeRecipe, reviewRecipes,
          });
          ({ value, audit } = write);
          fields = write.fields ?? fields;
        } else {
          const { data } = await reviewInputs({ ask, enabled: reviewRecipes, inputs: { ...inputs, ...fields }, spec: specs, tabId });
          fields = checkedFields(specs, data);
          const reply = await executeRecipe(step, bindRecipeInputs(data, fields), tabId);
          value = reply.outputs;
          audit = auditOf(reply);
        }
        if (reviewRecipes && value !== null) {
          if (!prior?.outputReview) await save({ pending: true, fields, outputReview: { value, audit } });
          const { edits, proposed } = await ask('edit-outputs', { data: value, tabId, adapterId: audit?.adapterId });
          if (edits.length) {
            audit = { ...audit, originalOutputs: value };
            value = proposed;
          }
        }
        break;
      case 'connector':
        value = await executeConnector(step, { ...inputs, ...fields });
        break;
      case 'transform':
        value = await executeTransform(step, inputs, fields);
        if (step.select) {
          const items = value.items ?? [];
          const choices = items.map((item, index) => ({ index, label: item.label }));
          const answer = await ask('selection', { choices, details: value.details });
          const chosen = new Set(answer.indices);
          selected = items.filter((_item, index) => chosen.has(index)).map(item => item.value);
        }
        break;
      case 'agent': {
        const documents = agentDocumentInputs(inputs);
        const answer = await ask('agent', { inputs: documents.inputs, fields, instruction: step.instruction });
        ({ value, audit } = answer);
        break;
      }
      case 'handoff': {
        const answer = await ask('handoff', { tags: step.tags, label: step.label, inputs, fields,
          ...(tabId === undefined ? {} : { tabId }) });
        value = answer.value ?? null;
        break;
      }
      default:
        throw invalid('Unknown workflow step: ' + step.id);
    }
    await save({ value, fields, selected, ...(audit === undefined ? {} : { audit }), sources: sourceNames(step, results) });
  }
  return results;
}
