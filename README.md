# Browser Recipes

This repository contains the Chromium extension that runs recipes in signed-in tabs and the CLI that lets scripts call it. The **Browser Recipes Catalog** is the companion repository where contributors share app adapters, recipes, and workflows. Install the extension first, then open **Browse community catalog** in Settings to choose what to run. [Install the extension](docs/getting-started.md) · [Browse or contribute to Browser Recipes Catalog](https://github.com/open-horizon-labs/browser-recipes-catalog)

Many web apps have no Model Context Protocol (MCP) server an agent can call. An agent can still use the app through a browser or computer-use tool. For a recurring task, that often means inspecting the same pages, finding the same controls, and deciding where to click on every run. Most computer-use tools also take over the active window and mouse pointer while the agent works.

Browser Recipes lets an agent inspect the app once and save the navigation, actions, and checks as a JSON recipe. The Chromium extension executes those steps directly in the open tab, using its signed-in session. Replay needs no model call, leaves the foreground tab selected, and keeps your cursor free.

**[Preview Outlook meetings for Google Calendar](docs/getting-started.md)** · **[Copy Outlook events to Google Calendar](docs/calendar-sync.md)**

## Run from the browser or a script

Open Browser Recipes from the toolbar, choose a tab and an installed recipe, supply any inputs, and click **Run recipe**. The side panel sends the request directly to the extension. The result appears there.

Choose **Workflows** to run several recipes in sequence. Pick an installed workflow and assign its tabs. A workflow can read from several apps, compare results locally, ask you to review data for ChatGPT, and pause for approval before a write. **Sign in with ChatGPT** connects the built-in agent to your ChatGPT plan. A script or agent can start either a recipe or a workflow through the optional Linux CLI. Open **Runs** to inspect the same execution, follow data between steps, or handle a sign-in or submission request. [Calling recipes and workflows](docs/runs.md)

## Read Outlook events from the shell

Read the visible calendar week in a background tab. Here, `217castle.com` is the label configured for the signed-in Outlook account. [Set up the CLI and account labels](bridge/README.md#run-by-account-label)

```sh
browser-recipes run --adapter outlook --account 217castle.com --recipe read-calendar-week
```

For a specific date range, pass both dates as JSON. The recipe returns the matching rows in `outputs.events`.

```sh
browser-recipes run --adapter outlook --account 217castle.com --recipe read-calendar-week \
  --inputs '{"first-day":"2026-11-08","last-day":"2026-11-14"}'
```

For a daily agenda, pass the same date twice. This example uses the shell’s local date and prints each event from the JSON result.

```sh
today=$(date +%F)
agenda=$(browser-recipes run --adapter outlook --account 217castle.com --recipe read-calendar-week \
  --input first-day="$today" --input last-day="$today") || exit 1
printf '%s\n' "$agenda" | jq -r '.outputs.events[] | .attributes["aria-label"] // .text'
```

## Preview an Outlook to Google Calendar sync

The catalog’s Outlook-to-Google workflow specifies which recipes read each calendar. The extension runs those recipes, sends the event labels and your instruction to ChatGPT, and compares the resulting time blocks. [Workflow definition](https://github.com/open-horizon-labs/browser-recipes-catalog/blob/main/workflows/outlook-to-google-calendar.json)

Here, `personal` is the Google Calendar account label.

```sh
browser-recipes workflow preview outlook-to-google-calendar \
  --account source=217castle.com --account destination=personal \
  --input firstDay=2026-11-08 --input lastDay=2026-11-14 \
  --input sourceTimeZone=America/New_York --input destinationTimeZone=America/New_York \
  --prompt 'Ignore Google Calendar holidays and skip canceled Outlook events.'
```

The command stops at preview. A script can read the proposed imports from `choices` and inspect overlaps and unresolved events in `details`. [Calendar workflow guide](docs/calendar-sync.md)

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

## First run on Linux

[Follow the getting started guide](docs/getting-started.md) to install the extension, compare two calendars in background tabs, and ask Claude or ChatGPT to help write one for your app.

## Write or fix a recipe

Enable developer tools in the extension options. Run `dev.inspect` to list controls and links on a permitted tab. Write the steps, try them with `dev.test`, then import the tested recipe with its adapter. For a write, read back the saved record. For an attachment, declare its download path so the extension can fetch it in the tab’s session. [Recipe format and operations](docs/recipes.md)

If a step fails, the extension stops and returns the step number, operation, target name when available, and a list of completed steps with their timings. Give that error and the installed catalog revision to whoever will fix the recipe. Check what the app saved before retrying a write. [CLI commands](bridge/README.md) · [Design notes](docs/design.md) · [Prototype audit](docs/prototype-audit.md)

## Access and limits

Review an adapter before granting its origin. A recipe can submit data using your signed-in account, and local processes running as your Linux user can call the bridge while it is enabled. Discovery output and successful reads may contain private page content.

The browser and target tab must stay open. An adapter can target the main document or one declared, independently permitted frame. Check support for an app’s widgets, embedded frames, and flows that require a user gesture before relying on a recipe.

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

The [Concur browser test](integration/concur.mjs) and [Google Calendar editor browser test](integration/google-calendar-editor.mjs) run against the real definitions from a sibling `browser-recipes-catalog` checkout. Run `node integration/concur.mjs` and `node integration/google-calendar-editor.mjs` after the runtime build and integration dependency install. Set `BROWSER_RECIPES_CATALOG` to use a different catalog checkout.
