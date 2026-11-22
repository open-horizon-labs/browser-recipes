# Run recipes from the terminal

Use the same `browser-recipes` commands on Linux, macOS, and Windows. The CLI talks to the extension through a local native messaging host. Linux and macOS use a private Unix socket. Windows uses a named pipe authenticated with a key in your desktop profile. Programs running under your desktop account can send commands while the bridge is enabled.

## Connect a browser

Install Python 3.9 or later and pipx. From the repository root, run:

```sh
pipx install ./bridge
```

1. Load the unpacked extension. Copy its ID from the browser’s Extensions page.
2. Register the host using the same command on all three platforms.

   ```sh
   browser-recipes install YOUR_EXTENSION_ID
   ```

   For unbranded Chromium, add `--browser chromium`. On Linux, use `--browser browseros-neo` for BrowserOS neo with the `browser-claw` profile directory.
3. In Browser Recipes Settings, enable **Allow programs on this computer to run recipes**. One browser connection can use the bridge at a time.

Check the connection with `browser-recipes tabs`. The Linux checkout command `./bridge/browser-recipes` also works for existing installations.

## Run recipes and workflows

Use `definitions.list` to discover operations, `runs.start` to call a recipe or workflow, and `runs.get` to inspect the result or pending user action. [Parameters and examples](../docs/runs.md)

## Commands

```sh
browser-recipes catalog
browser-recipes tabs
browser-recipes run '{"tabId":123,"adapterId":"example","recipeId":"read","inputs":{}}'
browser-recipes dev.inspect '{"tabId":123,"adapterId":"example"}'
browser-recipes dev.test - < test-request.json
browser-recipes dev.failures
```

Pass an argument object as a JSON string or use `-` to read UTF-8 JSON from stdin. To avoid native argument quoting in PowerShell, pipe the JSON to the command. For example, `Get-Content -Raw request.json | browser-recipes runs.start -`.
`dev.test` accepts an object with `tabId`, `adapterId`, `recipe`, and
`inputs`. Use `catalog` and `tabs` to obtain identifiers from the browser.

On success the CLI prints JSON to stdout. On failure it exits with status 1. Browser errors appear under `error` on stdout. Local bridge errors go to stderr.

`BUSY` means another command is running. A timeout means the browser did not reply before the deadline. Check the page before retrying a command that writes data.

Disable the bridge in Settings to disconnect. Delete the manifest at the path printed by `install` to unregister the host. On Windows, you can also remove the host’s `org.openhorizonlabs.tab_recipes` entry under the browser’s per-user `NativeMessagingHosts` registry key.

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
browser-recipes accounts.list
browser-recipes accounts.label '{"adapterId":"outlook","label":"217castle.com"}'
browser-recipes accounts.label '{"adapterId":"google-calendar","label":"personal"}'
browser-recipes run --adapter outlook --account 217castle.com --recipe read-calendar-week
browser-recipes runs.start '{"kind":"workflow","workflowId":"outlook-to-google-calendar","accounts":{"source":"217castle.com","destination":"personal"},"inputs":{"firstDay":"2026-11-08","lastDay":"2026-11-14","sourceTimeZone":"America/New_York","destinationTimeZone":"America/New_York"}}'
```

Add `--inputs '{"first-day":"2026-11-08","last-day":"2026-11-14"}'` for a date range. For string values, you can also repeat `--input NAME=VALUE` as in `workflow preview`.

The extension looks for an inactive app tab and verifies the signed-in identity before using it. If it needs a new tab, it opens the recipe’s entry path (or the adapter’s app entry) in the background. A connection that needs sign-in returns a waiting run with a `pending.reviewUrl`. Open the review, choose **Open app in browser**, sign in, then return to the review to resume. The extension checks the identity again. Existing callers can still supply tab IDs.

## Preview a workflow from a script

Pass account labels by workflow role and named workflow inputs. This command uses the extension’s signed-in ChatGPT connection for agent steps. The custom prompt applies to this run.

```sh
browser-recipes workflow preview outlook-to-google-calendar \
  --account source=217castle.com --account destination=personal \
  --input firstDay=2026-11-08 --input lastDay=2026-11-14 \
  --input sourceTimeZone=America/New_York --input destinationTimeZone=America/New_York \
  --prompt 'Ignore Google Calendar holidays and skip canceled Outlook events.'
```

Read `status` in the JSON response. At a selection, `preview` includes `choices` and `details`. At a write approval, sign-in, missing input, or attachment review, `waiting` identifies the pending action. A read-only workflow that finishes without a selection returns `completed` and its result. Errors exit nonzero. The CLI handles run and action IDs internally. Use `--model` to select a different available model.
