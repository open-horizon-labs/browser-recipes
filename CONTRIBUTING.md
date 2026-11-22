# Contribute to Browser Recipes

Send app adapters, recipes, and workflows to the [Browser Recipes Catalog](https://github.com/open-horizon-labs/browser-recipes-catalog#contributing). Change the extension, recipe interpreter, or CLI here. Keep both checkouts side by side to run the integration tests against the catalog.

## Write or fix a recipe

Enable developer tools in the extension options. Run `dev.inspect` to list controls and links on a permitted tab. Write the steps, try them with `dev.test`, then import the tested recipe with its adapter. For a write, read back the saved record. For an attachment, declare its download path so the extension can fetch it in the tab’s session. [Recipe format and operations](docs/recipes.md)

If a step fails, the extension stops and returns the step number, operation, target name when available, and a list of completed steps with their timings. Give that error and the installed catalog revision to whoever will fix the recipe. Check what the app saved before retrying a write. [CLI commands](bridge/README.md) · [Design notes](docs/design.md) · [Prototype audit](docs/prototype-audit.md)

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
