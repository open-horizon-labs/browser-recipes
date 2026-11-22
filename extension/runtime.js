import { hasOrigin } from './access.js';
import { readAttachment } from './attachments.js';
import { executeDom } from './dom.js';
import { RecipeError, originOf, record, validateInputs, validateRecipe } from './schema.js';

const MAX_BINARY_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_OUTPUT_BYTES = 760000;

const errors = {
  AMBIGUOUS_TARGET: 'The selector matched more than one element.',
  ASSERTION_FAILED: 'The page did not satisfy the assertion.',
  ATTACHMENT_FAILED: 'Could not read or convert the attachment.',
  CONTROL_DISABLED: 'The target control is disabled.',
  INVALID_SELECTOR: 'The recipe target is not a valid CSS selector.',
  NAVIGATION_TIMEOUT: 'The tab did not finish navigating within 10 seconds.',
  ORIGIN_CHANGED: 'The tab is outside the adapter origin or is unavailable.',
  OUTPUT_TOO_LARGE: 'The result exceeds the response limit.',
  PATH_NOT_ALLOWED: 'The document is outside the adapter’s declared document paths.',
  PERMISSION_REQUIRED: 'Grant the adapter origin in extension settings.',
  SCRIPT_FAILED: 'The browser could not complete the page operation.',
  TARGET_UNAVAILABLE: 'The target was missing or hidden.',
  UNSUPPORTED_CONTROL: 'This element does not support the requested operation.',
  UNSUPPORTED_NAVIGATION: 'The control points outside the granted origin or the selected tab.',
  VALUE_REJECTED: 'The control rejected the supplied value.',
};

function pageError(code) {
  return Object.hasOwn(errors, code)
    ? new RecipeError(code, errors[code])
    : new RecipeError('SCRIPT_FAILED', errors.SCRIPT_FAILED);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function assertPermission(browser, origin) {
  if (!await hasOrigin(browser, origin)) {
    throw pageError('PERMISSION_REQUIRED');
  }
}

async function getTab(browser, tabId) {
  try {
    return await browser.tabs.get(tabId);
  } catch {
    throw pageError('ORIGIN_CHANGED');
  }
}

async function readyTab(browser, tabId, origin, isReady = () => true) {
  await assertPermission(browser, origin);
  const deadline = Date.now() + 10000;
  for (;;) {
    const tab = await getTab(browser, tabId);
    const url = tab.pendingUrl || tab.url;
    if (originOf(url) !== origin) throw pageError('ORIGIN_CHANGED');
    if (tab.status !== 'loading' && !tab.pendingUrl && originOf(tab.url) === origin && isReady(tab)) return tab;
    if (Date.now() >= deadline) throw pageError('NAVIGATION_TIMEOUT');
    await wait(100);
  }
}

async function inject(browser, tabId, operation) {
  let result;
  try {
    const responses = await browser.scripting.executeScript({
      target: { tabId },
      func: executeDom,
      args: [operation],
    });
    result = responses[0]?.result;
  } catch {
    const tab = await getTab(browser, tabId);
    if (originOf(tab.pendingUrl || tab.url) !== operation.origin) throw pageError('ORIGIN_CHANGED');
    throw pageError('SCRIPT_FAILED');
  }
  if (!result?.ok) throw pageError(result?.code);
  return result.value;
}

function binaryOutput(result) {
  const { kind, name, mimeType, bytes } = result;
  if (bytes.length > MAX_BINARY_OUTPUT_BYTES) throw pageError('OUTPUT_TOO_LARGE');
  const chunks = [];
  for (let index = 0; index < bytes.length; index += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + 8192)));
  }
  return { kind, name, mimeType, base64: btoa(chunks.join('')) };
}

async function runStep(browser, tabId, adapter, step, inputs) {
  const { origin } = adapter;
  const tab = await readyTab(browser, tabId, origin);
  if (step.op === 'navigate') {
    const previousUrl = tab.url;
    const destination = new URL(step.path, origin).href;
    if (previousUrl === destination) return undefined;
    try {
      await browser.tabs.update(tabId, { url: destination });
    } catch {
      throw pageError('SCRIPT_FAILED');
    }
    await readyTab(browser, tabId, origin, current => current.url !== previousUrl);
    return undefined;
  }
  const output = await inject(browser, tabId, {
    origin, op: step.op, selector: step.selector ?? adapter.targets?.[step.target],
    input: step.input ? inputs[step.input] : undefined, text: step.text,
    documentPaths: adapter.documentPaths,
  });
  if (step.op === 'click') {
    await readyTab(browser, tabId, origin);
  } else if (step.op === 'readAttachment') {
    let result;
    try {
      result = await readAttachment(browser, tabId, { ...output, allowedPathPrefix: step.allowedPathPrefix });
    } catch (error) {
      const attachmentErrors = {
        'file-too-large': 'OUTPUT_TOO_LARGE',
        'out-of-scope': 'PATH_NOT_ALLOWED',
        'tab-changed': 'ORIGIN_CHANGED',
      };
      throw pageError(Object.hasOwn(attachmentErrors, error?.code) ? attachmentErrors[error.code] : 'ATTACHMENT_FAILED');
    }
    return result.kind === 'file' ? binaryOutput(result) : result;
  }
  return output;
}

function validateArgs(args, allowed) {
  if (!record(args) || Object.keys(args).some(key => !allowed.includes(key))) {
    throw new RecipeError('INVALID_ARGUMENTS', 'The command received an unexpected argument.');
  }
}

export function createDispatcher(browser, loadCatalog) {
  const runningTabs = new Set();
  let logWrite = Promise.resolve();

  function logFailure(failure) {
    logWrite = logWrite.catch(() => {}).then(async () => {
      const { failures = [] } = await browser.storage.local.get('failures');
      await browser.storage.local.set({ failures: [failure, ...failures].slice(0, 30) });
    });
    return logWrite.catch(() => {});
  }

  async function run(tabId, adapter, recipe, inputs) {
    if (runningTabs.has(tabId)) throw new RecipeError('TAB_BUSY', 'A recipe is already using the selected tab.');
    runningTabs.add(tabId);
    const runId = crypto.randomUUID();
    const outputs = Object.create(null);
    const metadata = Object.create(null);
    const completed = [];
    let binaryBytes = 0;
    const startedAt = performance.now();
    let stepStartedAt = startedAt;
    let index = 0;
    try {
      for (const [offset, step] of recipe.steps.entries()) {
        index = offset;
        stepStartedAt = performance.now();
        const value = await runStep(browser, tabId, adapter, step, inputs);
        if (step.as) {
          outputs[step.as] = value;
          if (value?.kind === 'file') {
            const { base64, ...fileMetadata } = value;
            const padding = base64.endsWith('==') ? 2 : Number(base64.endsWith('='));
            binaryBytes += (base64.length * 3) / 4 - padding;
            metadata[step.as] = fileMetadata;
          } else {
            metadata[step.as] = value;
          }
          if (binaryBytes > MAX_BINARY_OUTPUT_BYTES ||
            new TextEncoder().encode(JSON.stringify(metadata)).length > MAX_METADATA_OUTPUT_BYTES) {
            throw pageError('OUTPUT_TOO_LARGE');
          }
        }
        completed.push({ step: offset + 1, op: step.op, elapsedMs: Math.round(performance.now() - stepStartedAt) });
      }
      return { runId, outputs };
    } catch (cause) {
      const reason = cause instanceof RecipeError ? cause : pageError('SCRIPT_FAILED');
      const step = recipe.steps[index];
      const details = {
        runId, adapterId: adapter.id, recipeId: recipe.id,
        step: index + 1, op: step.op, ...(step.target ? { target: step.target } : {}),
        elapsedMs: Math.round(performance.now() - startedAt),
        stepElapsedMs: Math.round(performance.now() - stepStartedAt),
        completed,
      };
      await logFailure({ ...details, timestamp: new Date().toISOString(), code: reason.code });
      throw new RecipeError(reason.code, reason.message, details);
    } finally {
      runningTabs.delete(tabId);
    }
  }

  return async (command, args = {}) => {
    if (typeof command === 'string' && command.startsWith('dev.')) {
      const { devMode } = await browser.storage.local.get('devMode');
      if (devMode !== true) throw new RecipeError('DEV_DISABLED', 'Enable developer tools in extension settings.');
    }

    if (command === 'dev.failures') {
      validateArgs(args, []);
      await logWrite.catch(() => {});
      const { failures = [] } = await browser.storage.local.get('failures');
      return failures;
    }
    if (command === 'catalog' || command === 'tabs') {
      validateArgs(args, []);
      const catalog = await loadCatalog();
      const granted = [];
      for (const adapter of catalog) {
        if (await hasOrigin(browser, adapter.origin)) granted.push(adapter);
      }
      if (command === 'catalog') {
        return granted.map(({ id, title, origin, recipes }) => ({
          id, title, origin, recipes: recipes.map(({ id, title, inputs = {} }) => ({ id, title, inputs })),
        }));
      }
      const tabs = await browser.tabs.query({});
      return tabs.flatMap(tab => {
        const adapterIds = granted.filter(adapter => adapter.origin === originOf(tab.pendingUrl || tab.url))
          .map(adapter => adapter.id);
        return adapterIds.length && Number.isInteger(tab.id) ? [{ tabId: tab.id, adapterIds }] : [];
      });
    }

    const keys = {
      run: ['tabId', 'adapterId', 'recipeId', 'inputs'],
      'dev.inspect': ['tabId', 'adapterId'],
      'dev.test': ['tabId', 'adapterId', 'recipe', 'inputs'],
    };
    if (typeof command !== 'string' || !Object.hasOwn(keys, command)) {
      throw new RecipeError('UNKNOWN_COMMAND', 'This command is not supported.');
    }
    validateArgs(args, keys[command]);
    if (!Number.isSafeInteger(args.tabId) || args.tabId < 0) {
      throw new RecipeError('TAB_REQUIRED', 'Provide an explicit browser tab ID.');
    }
    const catalog = await loadCatalog();
    const adapter = catalog.find(entry => entry.id === args.adapterId);
    if (!adapter) throw new RecipeError('ADAPTER_NOT_FOUND', 'This adapter is not installed.');
    await assertPermission(browser, adapter.origin);
    if (command === 'dev.inspect') {
      await readyTab(browser, args.tabId, adapter.origin);
      return await inject(browser, args.tabId, { origin: adapter.origin, op: 'inspect' });
    }
    const recipe = command === 'dev.test'
      ? validateRecipe(args.recipe, adapter)
      : adapter.recipes.find(entry => entry.id === args.recipeId);
    if (!recipe) throw new RecipeError('RECIPE_NOT_FOUND', 'This recipe is not installed.');
    const inputs = args.inputs === undefined ? {} : args.inputs;
    validateInputs(recipe, inputs);
    return await run(args.tabId, adapter, recipe, inputs);
  };
}

export function safeError(error) {
  if (error instanceof RecipeError) return { code: error.code, message: error.message, ...error.details };
  return { code: 'INTERNAL_ERROR', message: 'The extension could not complete the command.' };
}
