# Browser Recipes

Many web apps have no Model Context Protocol (MCP) server an agent can call. An agent can still use the app through a browser or computer-use tool. For a recurring task, that often means inspecting the same pages, finding the same controls, and deciding where to click on every run. Most computer-use tools also take over the active window and mouse pointer while the agent works.

Browser Recipes lets an agent inspect the app once and save the navigation, actions, and checks as a JSON recipe. The Chromium extension runs those steps in a signed-in tab. A recipe can run in the background without taking over your cursor or calling a model.

This repo contains the extension, recipe interpreter, and CLI. The companion catalog contains the adapters, recipes, and workflows you install in the extension. [Browser Recipes Catalog](https://github.com/open-horizon-labs/browser-recipes-catalog)

## Get started

1. Install the Chromium extension on Windows, macOS, or Linux. [Extension setup](docs/getting-started.md)
2. Open **Settings → Browse community catalog**, install a recipe or workflow, and grant access to the sites it uses.
3. Open the app, then open **Browser Recipes** and choose a recipe. For a workflow, open **Workflows**.

For workflows that use ChatGPT, set up the local helper on your platform. On Linux, the optional terminal bridge lets scripts and agents call recipes. [ChatGPT setup](docs/chatgpt-agent.md) · [CLI setup](bridge/README.md)

## Features

- **Run in a background tab.** Keep working in another tab while a recipe uses your signed-in session.
- **Run recipes from the side panel.** Pick a recipe for your current tab. If the app needs sign-in, the run pauses and gives you a link to open it. On Linux, scripts and agents can also call recipes through the optional CLI and receive JSON. [CLI examples](bridge/README.md#run-by-account-label)
- **Combine recipes across apps.** Pass results between recipes, use ChatGPT to filter or transform data, and pause for approval before a write.
- **Read attachments through the signed-in session.** A recipe can fetch a document from an allowed app path. The extension extracts text from supported PDFs and Office files locally, or returns the file bytes as base64. [Attachment formats and limits](docs/recipes.md#attachments)
- **Record a task to draft a recipe.** In developer mode, record your actions or let an agent inspect the page controls. The recording produces editable steps with placeholders for field values. Test the draft against the app before sharing it. [Authoring guide](docs/getting-started.md)
- **See where a run failed.** Run history shows when each step ran and which earlier outputs it used. The failure report identifies the failed operation and target so an author can reproduce the problem and test a fix. [Run history](docs/runs.md)

## Examples

### Read Outlook events from the shell

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

### Preview an Outlook to Google Calendar sync

Compare Outlook and Google Calendar before copying events. In the extension, review the event data and give ChatGPT a filter such as “skip canceled meetings.” The Linux CLI can run the same preview. Here, `personal` is the Google Calendar account label. [Workflow definition](https://github.com/open-horizon-labs/browser-recipes-catalog/blob/main/workflows/outlook-to-google-calendar.json)

```sh
browser-recipes workflow preview outlook-to-google-calendar \
  --account source=217castle.com --account destination=personal \
  --input firstDay=2026-11-08 --input lastDay=2026-11-14 \
  --input sourceTimeZone=America/New_York --input destinationTimeZone=America/New_York \
  --prompt 'Ignore Google Calendar holidays and skip canceled Outlook events.'
```

The command stops at preview. A script can read the proposed imports from `choices` and inspect overlaps and unresolved events in `details`. [Calendar workflow guide](docs/calendar-sync.md)

### Check expense report status in Concur

Install **Check expense report and reimbursement status** to see the reports under **Active Reports** in Manage Expenses, with the amounts and statuses Concur displays. Run it from the panel for a quick check or read `outputs.reports` from a script. [Concur recipe](https://github.com/open-horizon-labs/browser-recipes-catalog/blob/main/adapters/concur/recipes/list-active-reports.json)

## Running on a managed desktop

**Chrome remote debugging can stay disabled.** The extension checks site access and uses Chrome’s scripting API to run steps in the existing tab. IT needs to allow the extension and the sites it automates. Running recipes from outside Chrome also requires permission to install the native messaging host. [Extension permissions](extension/manifest.json) · [Local bridge](bridge/README.md)

Review an adapter before granting its origin. A recipe can submit data using your signed-in account, and local processes running as your Linux user can call the bridge while it is enabled. Discovery output and successful reads may contain private page content.

The browser and target tab must stay open. An adapter can target the main document or one declared, independently permitted frame. Check support for an app’s widgets, embedded frames, and flows that require a user gesture before relying on a recipe.

## Contribute

- **Add or fix an app recipe.** Find the app’s adapter in the catalog and test your changes against the site. [Catalog contributor guide](https://github.com/open-horizon-labs/browser-recipes-catalog#contributing)
- **Change the extension or CLI.** Build the runtime and run the unit and browser tests. [Runtime contributor guide](CONTRIBUTING.md)
