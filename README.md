# Tab Recipes

Teach an agent a task in a browser app, then run the saved recipe from a shell script, a scheduler, or another agent. Each request addresses an open tab by ID. You can keep using the tab in front of you.

This repository contains a Chromium extension, a Linux native-messaging bridge and a JSON CLI. Site definitions live in the [community catalog](https://github.com/open-horizon-labs/tab-recipes-catalog). The extension starts with an empty catalog. An adapter declares an exact site origin, named controls and permitted document paths. Its recipes bind inputs, perform ordered operations, check outcomes and return named outputs.

## First run on Linux

Use Node.js 22.13 or later, npm, Python 3.9 or later and Chrome or Chromium. Clone the two projects side by side.

```sh
git clone https://github.com/open-horizon-labs/tab-recipes
git clone https://github.com/open-horizon-labs/tab-recipes-catalog
cd tab-recipes
npm ci
npm run build
node ../tab-recipes-catalog/scripts/pack.mjs > /tmp/tab-recipes-catalog.json
```

1. Open the browser's Extensions page, enable Developer mode, choose **Load unpacked**, and select the generated `dist` directory.
2. Copy the displayed extension ID. Run `./bridge/tab-recipes install YOUR_EXTENSION_ID` for Chrome, or append `--browser chromium` for Chromium.
3. Open the extension options. Import the JSON array generated above, grant access to `https://news.ycombinator.com`, and enable the local bridge.
4. Open Hacker News at `https://news.ycombinator.com/` in a tab. You can switch back to another tab.
5. Run the commands below. Replace 123 with the Hacker News tab ID from `tabs`.

```sh
./bridge/tab-recipes catalog
./bridge/tab-recipes tabs
./bridge/tab-recipes run '{"tabId":123,"adapterId":"hacker-news","recipeId":"front-page","inputs":{}}'
```

## Author and repair a recipe

Enable authoring in the extension options. Run `dev.inspect` against the permitted tab to discover controls and navigation. Put stable selectors in the adapter's target map. Write a recipe against those target names, then use `dev.test` to exercise the draft. Draft runs can change the page. Test a write on disposable data and use a postcondition supplied by the app to verify that it committed.

```sh
./bridge/tab-recipes dev.inspect '{"tabId":123,"adapterId":"hacker-news"}'
./bridge/tab-recipes dev.test - < draft-request.json
./bridge/tab-recipes dev.failures
```

A draft request takes this shape.

```json
{
  "tabId": 123,
  "adapterId": "hacker-news",
  "recipe": {
    "id": "newest-headline",
    "title": "Read the newest headline",
    "steps": [
      { "op": "navigate", "path": "/newest" },
      { "op": "read", "target": "first-headline", "as": "headline" }
    ]
  },
  "inputs": {}
}
```

When a replay fails, give the agent the structured failure and the adapter version you ran. Inspect the failed step, update the draft and check the result before promoting it to the catalog. Check for existing writes before retrying a partially completed workflow.

## Trust and scope

Review a pack before importing it. A recipe can click a control or submit data using your signed-in account. Grant only the sites you intend to automate. The bridge accepts local processes running under your Linux user when enabled. Authoring mode exposes page labels and draft execution. Keep discovery output and successful recipe results local when working with private apps.

The extension targets top-level HTML documents. Site-specific widgets, cross-origin frames, closed shadow roots, browser dialogs and flows requiring a real user gesture need individual verification. The browser must stay open. The included local host installer supports Linux.

See the [bridge interface](bridge/README.md), the [design and salvage notes](docs/design.md) and the [catalog contribution guide](https://github.com/open-horizon-labs/tab-recipes-catalog#contributing).

The [recipe format](docs/recipes.md) covers every operation, including starting discovery on a new site, attachment inputs and failure handoff.

## Run the checks

```sh
npm ci && npm test && npm run build
python3 -m unittest discover -s bridge
cd integration
npm ci
npx playwright-core install chromium
npm test
```

The Linux integration test serves its own [workshop fixture](integration/fixtures/workshop). Set `CHROMIUM_PATH` to use an installed Chromium build that supports unpacked extensions in headless mode. It creates a disposable browser profile and pregrants a single loopback permission in the test manifest. It then exercises the options UI, origin grant, native host and CLI. Port 8765 must be free.
