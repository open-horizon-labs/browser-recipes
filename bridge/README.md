# Run recipes from the terminal

The terminal bridge ships with installation support for Linux. The CLI sends JSON over a Unix socket to a native messaging host. The host forwards requests to the extension and returns its replies. The socket is private to your Linux user. Any process running as that user can send commands while the bridge is connected.

## Connect a browser

Use Python 3.9 or later.

1. Load Browser Recipes as an unpacked extension and copy its ID from the browser's Extensions page.
2. From the repository root, register the executable for that ID.

   ```sh
   ./bridge/browser-recipes install YOUR_EXTENSION_ID
   ```

   For Chromium, add `--browser chromium`. For BrowserOS neo using the Linux
   `browser-claw` data directory, add `--browser browseros-neo`. The manifest uses the absolute
   path of this checkout. Register again if you move it.
3. Open Browser Recipes Options and select **Run recipes from the terminal → Allow programs on this computer to run recipes**. Only one browser connection can use the socket at a time.

## Run recipes and workflows

Use `definitions.list` to discover operations, `runs.start` to call a recipe or workflow, and `runs.get` to inspect the result or pending user action. [Parameters and examples](../docs/runs.md)

## Commands

```sh
./bridge/browser-recipes catalog
./bridge/browser-recipes tabs
./bridge/browser-recipes run '{"tabId":123,"adapterId":"example","recipeId":"read","inputs":{}}'
./bridge/browser-recipes dev.inspect '{"tabId":123,"adapterId":"example"}'
./bridge/browser-recipes dev.test - < test-request.json
./bridge/browser-recipes dev.failures
```

Pass an argument object as a JSON string or use `-` to read JSON from stdin.
`dev.test` accepts an object with `tabId`, `adapterId`, `recipe`, and
`inputs`. Use `catalog` and `tabs` to obtain identifiers from the browser.

On success the CLI prints JSON to stdout. On failure it exits with status 1. Browser errors appear under `error` on stdout. Local bridge errors go to stderr.

`BUSY` means another command is running. A timeout means the browser did not reply before the deadline. Check the page before retrying a command that writes data.

Disable the bridge in Options to disconnect. To unregister the host, delete the manifest at the path printed by `install`.

## Tests

```sh
python3 -m unittest discover -s bridge
```

Existing installations can keep their registered host and socket. The original CLI path is an alias for `bridge/browser-recipes`. Keep an unpacked installation in its current directory to preserve its extension ID.

With terminal access enabled, a local caller can review and install a published community workflow. Call `community.review` with `workflowId` and inspect its adapter origins and recipe IDs. Pass the returned `digest` and the same `workflowId` to `community.install`. This uses the extension's fixed community catalog and existing library validation. Site grants are separate.

At a workflow's pending agent step, `runs.agentReview` returns the model inputs and attachment list for the current `runId` and `actionId`. A local caller can then use `runs.agent` with the same IDs, a reviewed prompt, model and selected attachment indices. Both operations enforce the extension's site-sharing settings. This uses the signed-in ChatGPT plan. Inspect the returned text before using `runs.resume` to accept it.

## Run by account label

In **Settings → Site access**, enter the exact identity shown by the app, enter an integration account label, and choose **Label this account**. You can name multiple identities for one adapter. To label an account already pinned in Settings from the CLI:

```sh
./bridge/browser-recipes accounts.list
./bridge/browser-recipes accounts.label '{"adapterId":"outlook","label":"217castle.com"}'
./bridge/browser-recipes accounts.label '{"adapterId":"google-calendar","label":"personal"}'
./bridge/browser-recipes run --adapter outlook --account 217castle.com --recipe read-calendar-week
./bridge/browser-recipes runs.start '{"kind":"workflow","workflowId":"outlook-to-google-calendar","accounts":{"source":"217castle.com","destination":"personal"},"inputs":{"firstDay":"2026-11-08","lastDay":"2026-11-14","sourceTimeZone":"America/New_York","destinationTimeZone":"America/New_York"}}'
```

Add `--inputs '{"first-day":"2026-11-08","last-day":"2026-11-14"}'` for a date range. For string values, you can also repeat `--input NAME=VALUE` as in `workflow preview`. To call the CLI as `browser-recipes` from any directory, put the executable on your PATH.

The extension looks for an inactive app tab and verifies the signed-in identity before using it. If it needs a new tab, it opens the recipe’s entry path (or the adapter’s app entry) in the background. A connection that needs sign-in returns a waiting run with a `pending.reviewUrl`. Open the review, choose **Open app in browser**, sign in, then return to the review to resume. The extension checks the identity again. Existing callers can still supply tab IDs.

## Preview a workflow from a script

Pass account labels by workflow role and named workflow inputs. This command uses the extension’s signed-in ChatGPT connection for agent steps. The custom prompt applies to this run.

```sh
./bridge/browser-recipes workflow preview outlook-to-google-calendar \
  --account source=217castle.com --account destination=personal \
  --input firstDay=2026-11-08 --input lastDay=2026-11-14 \
  --input sourceTimeZone=America/New_York --input destinationTimeZone=America/New_York \
  --prompt 'Ignore Google Calendar holidays and skip canceled Outlook events.'
```

Read `status` in the JSON response. At a selection, `preview` includes `choices` and `details`. At a write approval, sign-in, missing input, or attachment review, `waiting` identifies the pending action. A read-only workflow that finishes without a selection returns `completed` and its result. Errors exit nonzero. The CLI handles run and action IDs internally. Use `--model` to select a different available model.
