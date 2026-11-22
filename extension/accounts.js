import { bindingKey, adapterGranted } from './scope.js';
import { RecipeError } from './schema.js';

export function accountKey(adapter) { return 'labels/' + bindingKey(adapter); }
export async function namedAccounts(browser, adapter) {
  const key = accountKey(adapter);
  return (await browser.storage.local.get(key))[key] ?? [];
}

export async function setAccountLabel(browser, adapter, label, identity) {
  if (typeof label !== 'string' || !label.trim() || label.length > 100 ||
      typeof identity !== 'string' || !identity.trim() || identity.length > 512)
    throw new RecipeError('INVALID_ARGUMENTS','Provide an account label and its exact signed-in identity.');
  label = label.trim();
  identity = identity.trim();
  if (adapter.identity.format === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity)) throw new RecipeError('INVALID_ARGUMENTS','Enter an email address.');
    identity = identity.toLowerCase();
  }
  const key = accountKey(adapter);
  await navigator.locks.request(key,async () => {
    const prior = await namedAccounts(browser,adapter);
    if (prior.some(item => item.label === label && item.identity !== identity))
      throw new RecipeError('LABEL_IN_USE','Remove the existing label before assigning another identity.');
    if (!prior.some(item => item.label === label)) await browser.storage.local.set({[key]:[...prior,{label,identity}]});
  });
}

export async function accountFor(browser, adapters, label) {
  if (typeof label !== 'string' || !label.trim()) throw new RecipeError('INVALID_ARGUMENTS','Provide an account label.');
  const matches = [];
  for (const adapter of adapters) {
    if (!adapter.identity || !await adapterGranted(browser,adapter)) continue;
    const item = (await namedAccounts(browser,adapter)).find(item => item.label === label);
    if (item) matches.push({adapter,identity:item.identity});
  }
  if (matches.length !== 1) throw new RecipeError(matches.length ? 'AMBIGUOUS_ACCOUNT' : 'ACCOUNT_NOT_CONFIGURED',
    'Choose a unique account label configured for this app in Site access.');
  return matches[0];
}
