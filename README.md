# Browser Recipes

Many web apps have no Model Context Protocol (MCP) server an agent can call. An agent can still use the app through a browser or computer-use tool. For a recurring task, that often means inspecting the same pages, finding the same controls, and deciding where to click on every run. Most computer-use tools also take over the active window and mouse pointer while the agent works.

Browser Recipes lets an agent inspect the app once and save the navigation, actions, and checks as a JSON recipe. The Chromium extension executes those steps directly in the open tab, using its signed-in session. Replay needs no model call, leaves the foreground tab selected, and keeps your cursor free.

## Where the CLI fits

The extension runs the recipe. In the hackathon prototype, you picked a recipe in the side panel and clicked Run. The panel sent the request directly to the extension’s service worker. That path needed no CLI or native messaging host.

A shell script runs outside Chrome. The Linux CLI sends its request through a local native messaging host to the same kind of runner inside the extension. **This version only exposes Run through the bridge.** Its toolbar button opens settings. Restoring a Run action inside the extension would let desktop users run recipes without installing the host.

## Example: show today’s Outlook events from the shell

Suppose a morning script needs to print your Outlook agenda. The following illustrates a proposed `today-events` recipe. The catalog currently ships an Outlook mail recipe. [Available Outlook recipes](https://github.com/open-horizon-labs/browser-recipes-catalog/tree/main/adapters/outlook)

With the calendar recipe installed, use the ID of your signed-in Outlook tab in place of `123`. This shell example uses `jq` to print the returned agenda text.

```sh
agenda=$(./bridge/browser-recipes run '{"tabId":123,"adapterId":"outlook","recipeId":"today-events","inputs":{}}') || exit 1
printf '%s\n' "$agenda" | jq -er '.outputs.agenda'
```

The recipe would open the calendar’s day view, select **Today**, wait for the day’s agenda to load, and read the displayed event times and titles. Outlook’s calendar time zone determines “today.” On an empty day the recipe should return Outlook’s empty-agenda text. If the agenda control is missing, the run should fail.

Every decision at run time is specified in advance. The shell passes a recipe ID, the extension executes fixed steps in the background tab, and `jq` prints one field. No prompt, model call, or cursor movement is involved.

## Running on a managed desktop

**Chrome remote debugging can stay disabled.** The extension checks site access and uses Chrome’s scripting API to run steps in the existing tab. IT needs to allow the extension and the sites it automates. Running recipes from outside Chrome also requires permission to install the native messaging host. [Extension permissions](extension/manifest.json) · [Local bridge](bridge/README.md)

## Example: read an expense report in Concur

The recipe opens Manage Expenses, checks the heading, and returns the visible text of the first active report card.

```json
[
  { "op": "navigate", "path": "/nui/expense" },
  { "op": "assert", "target": "manage-expenses", "text": "Manage Expenses" },
  { "op": "read", "target": "first-report", "as": "summary" }
]
```

The adapter maps `manage-expenses` and `first-report` to CSS selectors on the US2 Concur origin. The caller receives the report text in `outputs.summary`. If Concur changes its markup, a contributor can update the selector and users can import the revised adapter. [Concur adapter and recipe](https://github.com/open-horizon-labs/browser-recipes-catalog/tree/main/adapters/concur)

This repository contains the extension, interpreter, and Linux CLI. Adapters for Concur, Gmail, Outlook, and Hacker News live in the [community catalog](https://github.com/open-horizon-labs/browser-recipes-catalog).

## First run on Linux

Use Node.js 22.13 or later, npm, Python 3.9 or later and Chrome or Chromium. Clone the two projects side by side.

```sh
git clone https://github.com/open-horizon-labs/browser-recipes
git clone https://github.com/open-horizon-labs/browser-recipes-catalog
cd browser-recipes
npm ci
npm run build
node ../browser-recipes-catalog/scripts/pack.mjs > /tmp/browser-recipes-catalog.json
```

1. For this unpacked install, open the browser's Extensions page, enable Developer mode, choose **Load unpacked**, and select the generated `dist` directory.
2. Copy the displayed extension ID. Run `./bridge/browser-recipes install YOUR_EXTENSION_ID` for Chrome, or append `--browser chromium` for Chromium.
3. Open the extension options. Import the JSON array generated above, grant access to `https://news.ycombinator.com`, and enable the local bridge.
4. Open Hacker News at `https://news.ycombinator.com/` in a tab. You can switch back to another tab.
5. Run the commands below. Replace 123 with the Hacker News tab ID from `tabs`.

```sh
./bridge/browser-recipes catalog
./bridge/browser-recipes tabs
./bridge/browser-recipes run '{"tabId":123,"adapterId":"hacker-news","recipeId":"front-page","inputs":{}}'
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
