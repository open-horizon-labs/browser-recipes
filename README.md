# Tab Recipes

Tab Recipes lets you use an LLM to figure out a task in a browser app once, then give that task to a script. The agent saves what it learned as a recipe you can read, test, and share. On the next run, a program or another agent calls the recipe by name. The extension executes its steps in the selected tab while you keep working in the foreground. Replay requires no model call.

## How an app becomes callable

Take “read the first active expense report in Concur.” To do that by hand, you open Manage Expenses, check that you landed on the right page, and read the first report card. The community Concur recipe expresses those same three steps.

```json
[
  { "op": "navigate", "path": "/nui/expense" },
  { "op": "assert", "target": "manage-expenses", "text": "Manage Expenses" },
  { "op": "read", "target": "first-report", "as": "summary" }
]
```

The **adapter** defines what `first-report` means on this site. It gives the control a CSS selector and declares the exact origin where it can be used. The **recipe** defines what to do with that control and names the output. If Concur changes the report card markup, a maintainer can update the selector in one place. Callers still ask for the same recipe and read the same `summary` field. [Concur adapter and recipe](https://github.com/open-horizon-labs/tab-recipes-catalog/blob/main/adapters/concur.json)

Once you grant access to the site, a caller lists the available recipes and tabs, then sends the recipe ID, tab ID, and inputs through the local CLI. The extension acts on the page in that tab’s browser session. The sequence is fixed, but the data is live. For Concur, the result contains the report summary visible to the signed-in user at the time of the call.

This repository owns the extension, the Linux CLI bridge, and the recipe interpreter. The community repository owns the site definitions. Someone who knows an app can contribute a workflow or repair a target, and users can import the updated adapter independently of an extension release. The catalog includes Concur, Gmail, Outlook, and Hacker News. [Community catalog](https://github.com/open-horizon-labs/tab-recipes-catalog)

## Discover, test, and repair a recipe

Enable developer tools in the extension options when you want an agent to author a recipe. On a tab you have granted access to, `dev.inspect` exposes controls and same-origin navigation links. The agent can use that information to name targets, write steps, and run a draft with `dev.test`. Review the JSON and import the finished adapter. You can then turn developer tools off and call the saved recipe with `run`. [Recipe authoring guide](docs/recipes.md)

For a write, include a check that the app accepted the change. In the prototype, a date field looked filled in a background tab while the app still held the old value. Reading back a saved record catches that failure. For a task involving an attachment, the adapter can declare a download path so the extension can fetch the file using the tab’s session. It extracts text locally from PDFs and Office documents and can return the original bytes for a scan or image. [Design notes](docs/design.md)

When a step fails, execution stops. The error identifies the recipe, failed step, operation, and named target when available. It also lists the steps that completed and how long they took. Give that record and the installed catalog revision to an agent so it can inspect the changed page and test a repair. Check what the app saved before retrying a write. Developer mode makes recent failures available through `dev.failures`. [CLI commands](bridge/README.md)

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

A successful run returns a `runId` and the current headline in `outputs.headline`. You can use that field directly in a shell script.

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

The Linux integration test serves its own [workshop fixture](integration/fixtures/workshop). Set `CHROMIUM_PATH` to use an installed Chromium build that supports unpacked extensions in headless mode. It creates a disposable browser profile and pregrants a single loopback permission in the test manifest. It then exercises the options UI, origin grant, native host and CLI. Port 8765 must be free.
