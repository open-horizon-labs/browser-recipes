const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const reserved = new Set(['constructor', 'prototype', '__proto__']);
const fields = {
  navigate: ['path', 'under', 'query'],
  followLink: ['selector'],
  read: ['selector', 'as'],
  readList: ['selector', 'as', 'attributes', 'waitMs', 'text', 'minRows'],
  readValue: ['selector', 'as'],
  document: ['selector', 'as'],
  click: ['selector', 'gesture'],
  fill: ['selector', 'input', 'commit'],
  assert: ['selector', 'text', 'attribute', 'input'],
  assertValue: ['selector', 'input', 'value'],
  assertValues: ['selector', 'input'],
  attach: ['selector', 'input'],
  readAttachment: ['selector', 'as', 'allowedPathPrefix'],
};

export class RecipeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expect(condition, location) {
  if (!condition) throw new RecipeError('INVALID_SCHEMA', `Invalid ${location}.`);
}

function shape(value, allowed, location) {
  expect(record(value) && Object.keys(value).every(key => allowed.includes(key)), location);
}

function string(value, max = 160) {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max;
}

function id(value) {
  return typeof value === 'string' && identifier.test(value) && !reserved.has(value);
}

export function originOf(url) {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
      ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function originPattern(origin) {
  const url = new URL(origin);
  // Chrome match patterns grant a hostname across ports. Runtime checks the full origin.
  return `${url.protocol}//${url.hostname}/*`;
}

function sameOriginPath(value, origin) {
  return string(value, 2048) && value.startsWith('/') && !value.startsWith('//') &&
    !/[\\\x00-\x20]/.test(value) && originOf(new URL(value, origin)) === origin;
}

function documentPath(path, origin) {
  return sameOriginPath(path, origin) && path !== '/' &&
    new URL(path, origin).pathname === path && !path.includes('%');
}

// Effective contracts are also available for catalogs written before metadata existed.
export function recipeContract(recipe) {
  const changesControls = recipe.steps.some(step => ['click', 'fill', 'attach'].includes(step.op));
  expect(recipe.kind === undefined || id(recipe.kind), 'recipe kind');
  expect(recipe.effect === undefined || ['read', 'write'].includes(recipe.effect), 'recipe effect');
  expect(!changesControls || recipe.effect !== 'read', 'read-only recipe effect');
  return {
    kind: recipe.kind ?? 'action',
    effect: recipe.effect ?? (changesControls ? 'write' : 'read'),
    inputs: Object.fromEntries(Object.entries(recipe.inputs ?? {}).map(([name, spec]) =>
      [name, recipe.steps.some(step => step.input === name || step.match?.input === name) ? {...spec, required:true} : spec])),
    outputs: recipe.steps.filter(step => step.as).map(step => step.as),
  };
}

export function validateRecipe(recipe, adapter) {
  const { origin, targets = {}, documentPaths = [] } = adapter;
  shape(recipe, ['id', 'title', 'inputs', 'steps', 'kind', 'effect'], 'recipe');
  expect(id(recipe.id) && string(recipe.title), 'recipe identity');
  const inputs = recipe.inputs === undefined ? {} : recipe.inputs;
  expect(record(inputs) && Object.keys(inputs).length <= 32, 'recipe inputs');
  for (const [key, spec] of Object.entries(inputs)) {
    expect(id(key), 'input name');
    shape(spec, ['type', 'required'], 'input definition');
    expect(['string', 'attachment'].includes(spec.type) &&
      (spec.required === undefined || typeof spec.required === 'boolean'), 'input definition');
  }

  expect(Array.isArray(recipe.steps) && recipe.steps.length > 0 && recipe.steps.length <= 30, 'recipe steps');
  const outputs = new Set();
  for (const [index, step] of recipe.steps.entries()) {
    const location = `recipe step ${index + 1}`;
    expect(record(step) && typeof step.op === 'string' && Object.hasOwn(fields, step.op), location);
    const allowed = fields[step.op];
    shape(step, ['op', ...allowed, ...allowed.includes('selector') ? ['target', 'match', 'at'] : []], location);
    if (Object.hasOwn(step, 'as') || fields[step.op].includes('as')) {
      expect(id(step.as) && !outputs.has(step.as), location);
      outputs.add(step.as);
    }
    if (allowed.includes('selector')) {
      const direct = Object.hasOwn(step, 'selector');
      const named = Object.hasOwn(step, 'target');
      expect(direct !== named &&
        (direct ? string(step.selector, 512) : id(step.target) && Object.hasOwn(targets, step.target)), location);
      if (Object.hasOwn(step, 'match')) {
        const match = step.match;
        shape(match, ['text', 'input', 'attribute', 'within'], location);
        const literal = Object.hasOwn(match, 'text');
        const parameter = Object.hasOwn(match, 'input');
        expect(literal !== parameter && (literal ? string(match.text, 1024)
          : id(match.input) && inputs[match.input]?.type === 'string'), location);
        expect(match.attribute === undefined || ['aria-label', 'label'].includes(match.attribute), location);
        expect(match.within === undefined || (match.attribute === undefined && string(match.within, 512)), location);
      }
    }
    if (step.commit !== undefined) expect(['enter','focusout'].includes(step.commit),location);
    if (step.gesture !== undefined) expect(step.gesture === 'tap',location);
    if (step.under !== undefined) expect(/^\/(?:[a-zA-Z0-9_-]+\/)+$/.test(step.under),location);
    if (step.op === 'navigate') {
      expect(sameOriginPath(step.path, origin), location);
      if (step.query !== undefined) {
        expect(record(step.query) && Object.keys(step.query).length > 0 && Object.keys(step.query).length <= 16 &&
          !new URL(step.path, origin).hash && Object.entries(step.query).every(([key, input]) =>
            /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key) && id(input) && inputs[input]?.type === 'string'), location);
      }
    }
    if (step.at !== undefined) {
      shape(step.at, ['path', 'under'], location);
      expect(sameOriginPath(step.at.path, origin) && new URL(step.at.path, origin).pathname === step.at.path &&
        !step.at.path.includes('%') && (step.at.under === undefined || !adapter.frame &&
          /^\/(?:[a-zA-Z0-9_-]+\/)+$/.test(step.at.under)), location);
    }
    if (step.op === 'followLink') expect(adapter.paths?.length > 0 && !adapter.frame && step.match !== undefined, location);
    if (step.op === 'document') expect(documentPaths.length > 0, location);
    if (step.op === 'readList' && step.attributes !== undefined) {
      const attributes = step.attributes;
      expect(Array.isArray(attributes) && attributes.length <= 8 && new Set(attributes).size === attributes.length &&
        attributes.every(name => typeof name === 'string' &&
          /^(?:aria-(?:label|checked|selected|expanded)|data-(?:eventid|calitemid|datekey)|checked|label)$/.test(name)), location);
    }
    if (step.op === 'readList') {
      if (step.minRows !== undefined) expect(Number.isInteger(step.minRows) && step.minRows >= 1 && step.minRows <= 500, location);
      if (step.waitMs !== undefined) expect(Number.isInteger(step.waitMs) && step.waitMs >= 0 && step.waitMs <= 8000, location);
      if (step.text !== undefined) expect(string(step.text, 160), location);
    }
    if (step.op === 'readAttachment') expect(documentPaths.includes(step.allowedPathPrefix), location);
    if (step.op === 'assert') {
      if (step.text !== undefined) expect(string(step.text, 1024), location);
      if (step.attribute !== undefined || step.input !== undefined) {
        expect(step.attribute === 'aria-label' && step.text === undefined &&
          id(step.input) && Object.hasOwn(inputs, step.input) && inputs[step.input].type === 'string', location);
      }
    }
    if (step.op === 'assertValue' && Object.hasOwn(step, 'value')) {
      expect(!Object.hasOwn(step, 'input') && typeof step.value === 'string' && step.value.length <= 16384, location);
    } else if (['attach', 'fill', 'assertValue', 'assertValues'].includes(step.op)) {
      const type = step.op === 'attach' ? 'attachment' : 'string';
      expect(id(step.input) && Object.hasOwn(inputs, step.input) && inputs[step.input].type === type, location);
    }
  }
  recipeContract(recipe);
  return recipe;
}

export function validateCatalog(catalog) {
  expect(Array.isArray(catalog) && catalog.length <= 64, 'adapter catalog');
  const adapters = new Set();
  for (const adapter of catalog) {
    shape(adapter, ['id', 'title', 'origin', 'recipes', 'targets', 'documentPaths', 'paths', 'frame', 'identity', 'backgroundOnly', 'auth'], 'adapter');
    expect(id(adapter.id) && !adapters.has(adapter.id) && string(adapter.title) &&
      typeof adapter.origin === 'string' && originOf(adapter.origin) === adapter.origin, 'adapter identity or origin');
    adapters.add(adapter.id);
    if (adapter.paths !== undefined) {
      expect(Array.isArray(adapter.paths) && adapter.paths.length > 0 && adapter.paths.every(p => p === '/' || documentPath(p,adapter.origin)), 'adapter paths');
    }
    if (adapter.auth !== undefined) {
      const auth = adapter.auth;
      shape(auth, ['entryPath', 'origins', 'paths', 'signedOutSelector'], 'adapter auth');
      expect(sameOriginPath(auth.entryPath, adapter.origin), 'adapter sign-in entry path');
      expect(auth.origins === undefined || Array.isArray(auth.origins) && auth.origins.length <= 12 &&
        auth.origins.every(origin => typeof origin === 'string' && origin.startsWith('https://') &&
          originOf(origin) === origin && !origin.includes('*') && origin !== adapter.origin), 'adapter sign-in origins');
      expect(auth.paths === undefined || Array.isArray(auth.paths) && auth.paths.length <= 16 &&
        auth.paths.every(path => documentPath(path, adapter.origin)), 'adapter sign-in paths');
      expect(auth.signedOutSelector === undefined || string(auth.signedOutSelector, 512), 'adapter signed-out selector');
    }
    if (adapter.frame !== undefined) {
      shape(adapter.frame, ['origin','paths'], 'adapter frame');
      expect(originOf(adapter.frame.origin) !== null && originOf(adapter.frame.origin) === adapter.frame.origin &&
        Array.isArray(adapter.frame.paths) && adapter.frame.paths.length > 0 &&
        adapter.frame.paths.every(p => p === '/' || documentPath(p,adapter.frame.origin)), 'adapter frame');
    }
    if (adapter.identity !== undefined) {
      shape(adapter.identity,['selector','attribute','reveal','format'],'adapter identity selector');
      expect([undefined,'email'].includes(adapter.identity.format),'adapter identity format');
      if (adapter.identity.reveal) {
        shape(adapter.identity.reveal,['trigger','panel'],'account panel');
        expect(string(adapter.identity.reveal.trigger,512) && string(adapter.identity.reveal.panel,512),'account panel selectors');
      }
      expect(string(adapter.identity.selector,512) && [undefined,'aria-label','title'].includes(adapter.identity.attribute),'adapter account check');
    }
    expect(adapter.backgroundOnly === undefined || typeof adapter.backgroundOnly === 'boolean', 'adapter background mode');
    if (Object.hasOwn(adapter, 'targets')) {
      expect(record(adapter.targets) && Object.keys(adapter.targets).length <= 128, 'adapter targets');
      for (const [name, selector] of Object.entries(adapter.targets)) {
        expect(id(name) && string(selector, 512), 'adapter target');
      }
    }
    if (Object.hasOwn(adapter, 'documentPaths')) {
      expect(Array.isArray(adapter.documentPaths) && adapter.documentPaths.length <= 32 &&
        adapter.documentPaths.every(path => documentPath(path, adapter.origin)), 'adapter document paths');
    }
    expect(Array.isArray(adapter.recipes) && adapter.recipes.length <= 64, 'adapter recipes');
    const recipes = new Set();
    for (const recipe of adapter.recipes) {
      validateRecipe(recipe, adapter);
      expect(!recipes.has(recipe.id), 'duplicate recipe');
      recipes.add(recipe.id);
    }
  }
  return catalog;
}

export function validateInputs(recipe, inputs) {
  const specs = recipe.inputs ?? {};
  const invalid = () => new RecipeError('INVALID_INPUTS', 'Provide inputs matching the recipe definitions.');
  if (!record(inputs) || Object.keys(inputs).some(key => !Object.hasOwn(specs, key))) throw invalid();
  for (const [name, spec] of Object.entries(specs)) {
    const matching = recipe.steps.some(step => step.match?.input === name);
    const valueList = recipe.steps.some(step => step.op === 'assertValues' && step.input === name);
    const needed = spec.required || matching || recipe.steps.some(step => step.input === name);
    if (!Object.hasOwn(inputs, name)) {
      if (needed) throw invalid();
      continue;
    }
    const value = inputs[name];
    if (spec.type === 'string') {
      if (typeof value !== 'string' || value.length > 16384 || (matching && !string(value, 16384))) throw invalid();
      if (valueList) {
        let values;
        try { values = JSON.parse(value); } catch { throw invalid(); }
        if (!Array.isArray(values) || values.length === 0 || values.length > 256 ||
            !values.every(entry => typeof entry === 'string')) throw invalid();
      }
    } else if (!record(value) || Object.keys(value).some(key => !['name', 'mimeType', 'base64'].includes(key)) ||
      !string(value.name, 255) || /[\/\\\x00-\x1f]/.test(value.name) ||
      !string(value.mimeType, 160) || !/^[\w.+-]+\/[\w.+-]+$/.test(value.mimeType) ||
      typeof value.base64 !== 'string' || value.base64.length > 524288 ||
      value.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.base64)) {
      throw invalid();
    }
  }
}
