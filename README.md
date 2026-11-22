# Tab Recipes

An LLM can inspect a browser app and write a JSON recipe for a recurring task. Once you’ve tested the recipe, a script can run it by ID. The Chromium extension executes the steps in a specific open tab, using that tab’s session. You can work in another tab during the run. Replay requires no model call.

## Example: read an expense report in Concur

The recipe opens Manage Expenses, checks the heading, and returns the visible text of the first active report card.

```json
[
  { "op": "navigate", "path": "/nui/expense" },
  { "op": "assert", "target": "manage-expenses", "text": "Manage Expenses" },
  { "op": "read", "target": "first-report", "as": "summary" }
]
```

The adapter maps `manage-expenses` and `first-report` to CSS selectors on the US2 Concur origin. The caller receives the report text in `outputs.summary`. If Concur changes its markup, a contributor can update the selector and users can import the revised adapter. [Concur adapter and recipe](https://github.com/open-horizon-labs/tab-recipes-catalog/tree/main/adapters/concur)

This repository contains the extension, interpreter, and Linux CLI. Adapters for Concur, Gmail, Outlook, and Hacker News live in the [community catalog](https://github.com/open-horizon-labs/tab-recipes-catalog).

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

A successful run returns a `runId` and the current headline in `outputs.headline`.

## Write or fix a recipe

Enable developer tools in the extension options. Run `dev.inspect` to list controls and links on a permitted tab. Write the steps, try them with `dev.test`, then import the tested recipe with its adapter. For a write, read back the saved record. For an attachment, declare its download path so the extension can fetch it in the tab’s session. [Recipe format and operations](docs/recipes.md)

If a step fails, the extension stops and returns the step number, operation, target name when available, and a list of completed steps with their timings. Give that error and the installed catalog revision to whoever will fix the recipe. Check what the app saved before retrying a write. [CLI commands](bridge/README.md) · [Design notes](docs/design.md)

## Access and limits

Review an adapter before granting its origin. A recipe can submit data using your signed-in account, and local processes running as your Linux user can call the bridge while it is enabled. Discovery output and successful reads may contain private page content.

The browser and target tab must stay open. The extension operates on top-level HTML documents. Check support for an app’s widgets, embedded frames, and flows that require a user gesture before relying on a recipe.

## Run the checks

```sh
npm ci && npm test && npm run build
python3 -m unittest discover -s bridge
cd integration
npm ci
npx playwright-core install chromium
npm test
```

The integration test starts Chromium with a temporary profile and serves the [test site](integration/fixtures/workshop) on port 8765. The test manifest grants loopback access. The test grants the site origin through the options UI and runs the CLI against a background tab. Set `CHROMIUM_PATH` to use a local Chromium build with headless extension support.
