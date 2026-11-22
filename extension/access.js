import { originPattern } from './schema.js';

export async function hasOrigin(browser, origin) {
  const { approvedOrigins = [] } = await browser.storage.local.get('approvedOrigins');
  return approvedOrigins.includes(origin) &&
    await browser.permissions.contains({ origins: [originPattern(origin)] });
}
