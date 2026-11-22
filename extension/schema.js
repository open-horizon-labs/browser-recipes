const identifier = /^[a-z][a-z0-9-]{0,63}$/;
const reserved = new Set(['constructor', 'prototype', '__proto__']);
const fields = {
  navigate: ['path'],
  read: ['selector', 'as'],
  readList: ['selector', 'as', 'attributes'],
  readValue: ['selector', 'as'],
  document: ['selector', 'as'],
  click: ['selector'],
  fill: ['selector', 'input'],
  assert: ['selector', 'text'],
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

export function validateRecipe(recipe, adapter) {
  const { origin, targets = {}, documentPaths = [] } = adapter;
  shape(recipe, ['id', 'title', 'inputs', 'steps'], 'recipe');
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
    shape(step, ['op', ...allowed, ...allowed.includes('selector') ? ['target', 'match'] : []], location);
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
    if (step.op === 'navigate') expect(sameOriginPath(step.path, origin), location);
    if (step.op === 'document') expect(documentPaths.length > 0, location);
    if (step.op === 'readList' && step.attributes !== undefined) {
      const attributes = step.attributes;
      expect(Array.isArray(attributes) && attributes.length <= 8 && new Set(attributes).size === attributes.length &&
        attributes.every(name => typeof name === 'string' &&
          /^(?:aria-(?:label|checked|selected|expanded)|data-(?:eventid|calitemid|datekey)|checked|label)$/.test(name)), location);
    }
    if (step.op === 'readAttachment') expect(documentPaths.includes(step.allowedPathPrefix), location);
    if (step.op === 'assert' && Object.hasOwn(step, 'text')) expect(string(step.text, 1024), location);
    if (step.op === 'assertValue' && Object.hasOwn(step, 'value')) {
      expect(!Object.hasOwn(step, 'input') && typeof step.value === 'string' && step.value.length <= 16384, location);
    } else if (['attach', 'fill', 'assertValue', 'assertValues'].includes(step.op)) {
      const type = step.op === 'attach' ? 'attachment' : 'string';
      expect(id(step.input) && Object.hasOwn(inputs, step.input) && inputs[step.input].type === type, location);
    }
  }
  return recipe;
}

export function validateCatalog(catalog) {
  expect(Array.isArray(catalog) && catalog.length <= 64, 'adapter catalog');
  const adapters = new Set();
  for (const adapter of catalog) {
    shape(adapter, ['id', 'title', 'origin', 'recipes', 'targets', 'documentPaths', 'backgroundOnly'], 'adapter');
    expect(id(adapter.id) && !adapters.has(adapter.id) && string(adapter.title) &&
      typeof adapter.origin === 'string' && originOf(adapter.origin) === adapter.origin, 'adapter identity or origin');
    adapters.add(adapter.id);
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
