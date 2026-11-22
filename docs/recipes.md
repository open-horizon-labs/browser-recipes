# Writing a browser recipe

An adapter describes a single exact HTTP(S) origin. Use a separate adapter for a different host, scheme or port. To start discovery for a new site, import its adapter file under **Installed library**, grant site access, and enable developer tools. When you have a recipe, import its file and choose this adapter as its owner.

```json
{
  "id": "my-app",
  "title": "My app",
  "origin": "https://app.example.com",
  "targets": { "heading": "main h1" }
}
```

Run `tabs` to get the tab ID, then `dev.inspect` to list controls and same-origin links. Choose a selector that matches one element. Prefer an app-defined ID or data attribute when available. Put the selector in `targets` to reuse it across recipes.

## Recipe format

A recipe contains an `id`, `title`, ordered `steps` and optionally `inputs`. Identifiers for adapters, recipes, targets, inputs and output keys use lower-case letters, digits and hyphens, beginning with a letter. Names in `as` must be unique within a recipe. A recipe has up to 30 steps. Inputs use `{"type":"string"}` or `{"type":"attachment"}`, and may set `"required":true`. Referenced inputs must be supplied.

| Operation | Fields in addition to `op` | Effect |
| --- | --- | --- |
| `navigate` | `path` | Navigate the selected tab to a same-origin absolute path. |
| `followLink` | `target`, `match` | Navigate the selected tab to a uniquely matched rendered link. The destination must stay within the adapter’s declared paths. |
| `readValue` | `target`, `as` | Read a visible read-only text control. Credential controls are excluded. |
| `assertValue` | `target`, either `input` or `value` | Verify that a supported control has the exact expected string value. |
| `assertValues` | `target`, `input` | Verify the exact values of visible controls in document order. The string input contains a JSON array of strings. |
| `read` | `target`, `as` | Return the element's rendered text. |
| `readList` | `target`, `as`, optional `attributes`, `text`, and `waitMs` | Return visible matches as rows with `text` and `attributes`. |
| `assert` | `target`, optional `text` or `attribute` and `input` | Check visibility, a rendered text substring, or an exact `aria-label` value from a string input. |
| `fill` | `target`, `input` | Set a supported form control's value and dispatch input and change events. |
| `click` | `target` | Click an enabled element. This can submit a transaction. |
| `document` | `target`, `as` | Extract the selected page region as Markdown. The current path must be within the adapter's `documentPaths`. |
| `readAttachment` | `target`, `allowedPathPrefix`, `as` | Fetch the target link in the tab's session. The prefix must appear in `documentPaths`. |
| `attach` | `target`, `input` | Set a file input from a JSON object with `name`, `mimeType` and `base64` (up to 384 KiB of input bytes). |

A step that takes `target` can instead supply a CSS `selector` directly. Every step resolves its selector inside the adapter’s scoped document. A missing or ambiguous single-element target stops the run. Most operations require a visible element. After a write, read back the saved value to check that the app accepted it.

`readList` returns up to 500 visible rows, each with rendered text and the requested public attributes when present. Supported attributes are `aria-label`, `aria-checked`, `aria-selected`, `aria-expanded`, `data-eventid`, `data-calitemid`, `data-datekey`, `label`, `checked`, and `href`. For links, `href` returns the absolute HTTP or HTTPS URL and omits URLs with credentials. The `label` attribute returns the associated form label or explicit ARIA label. For a checkbox, `checked` reports its current state as `"true"` or `"false"`. Use `text` for a case-insensitive substring match and `waitMs` (up to 8000) to wait for a result. An empty list can be legitimate. Add an `assert` on a control unique to the starting view when a recipe needs to distinguish an empty result from the wrong page.

For a selector that matches repeated controls, add `"match": {"text": "Save"}`
or supply the expected text with `"match": {"input": "choice"}`. The runtime
compares whitespace-normalized text exactly, then requires one visible match
(except for `readList`). Set `attribute` to `aria-label` for that attribute or
to `label` for an associated form label. Set `within` to a CSS selector to
match the nearest ancestor’s rendered text instead. Caller text stays separate
from the selector.

Set `"backgroundOnly": true` on an adapter to stop a run before any step
while its tab is active.

## Attachments

Declare a directory with a trailing slash, as in `"documentPaths":["/files/"]`. An entry such as `/download.do` grants that exact endpoint and accepts query parameters. The extension rejects redirects and limits downloads to 8 MiB. It converts text PDFs, DOCX, XLSX and PPTX locally and returns `{kind:"markdown",name,markdown}` when text is available. For an image, scan, or file it cannot convert, it returns `{kind:"file",name,mimeType,base64}`. The caller decides whether to send the file to a model.

## Repair a failed recipe

Keep the CLI error and the catalog commit you ran. With developer tools enabled, `dev.failures` lists recent failures. Find the reported step in the recipe, inspect its target with `dev.inspect`, and test the change with `dev.test`. Save the corrected recipe in the adapter’s `recipes/` directory. If you changed a shared selector, rerun every recipe that uses it.

## Account checks, paths and embedded apps

An adapter can declare `paths`, an array of exact paths or directory prefixes ending in a slash. A framed app also declares `frame` with its own `origin` and `paths`. The user grants both origins in Settings. Each operation resolves exactly one matching direct child frame in the selected tab. A duplicate frame or a changed document stops the run. Use same-origin page controls for navigation within a frame.

Set `identity` to a unique account control outside page content, for example `{"selector":"header [data-account]","attribute":"aria-label"}`. Set the expected identifier in Settings before the first run, or let the first run remember its displayed value. Later steps check the visible control again before using the page. The user can forget that binding under Site access. A display name shared by several users is insufficient evidence for an account-specific adapter.

For an app whose route includes an account index, a navigation step may specify `under`. For example, `{"op":"navigate","under":"/calendar/u/","path":"/r/settings/export"}` preserves the selected tab’s existing account segment. A missing or invalid segment stops navigation.

## Widget input

By default, `fill` sets the native control value and dispatches input and change. A widget that commits on Enter or focus-leave can declare `"commit":"enter"` or `"commit":"focusout"`. Controls that listen for a tap can declare `"gesture":"tap"` on a click. These events run inside the selected document. They do not move the desktop cursor or give the tab focus. Use `assertValue` or a saved-record read to verify the application accepted the change.

For accounts whose identifier is visible only in a flyout, `identity.reveal` declares a unique trigger and panel selector. The site must allow control clicks to reveal the account. The runtime reads the identity while the panel is visible and dismisses a panel it opened. `format: "email"` requires an email-shaped identifier.

Use `minRows: 1` with a bounded `waitMs` on a `readList` receipt step to report a missing receipt as a failure. Inspect the receipt for partial success or an application error.


### Query prefills and exact editor paths

A `navigate` step can declare a `query` object mapping fixed parameter names
to string inputs. The runtime URL-encodes the values and preserves its regular
origin and path checks. The same-account navigation form keeps the current
account segment before appending the declared path.

A step that addresses a DOM target can set `at: {"path":"/exact/page"}`.
Add `"under":"/account/"` to match the exact route below the current
account segment. The runtime checks that path in the target document. Use this
on a save control shared by new-item and existing-item editors.

### Action discovery and sign-in

Recipes may declare a stable `kind` such as `get`, `list`, `create`, `update` or `submit`, and an `effect` of `read` or `write`. The discovery contract returns these fields alongside named inputs and output names derived from `as` in step order. Earlier catalogs use the kind `action` and infer the effect. Clicking, filling and attaching always require write approval, including clicks that open a read-only detail panel. A catalog author can explicitly mark a higher-impact action as a write.

An adapter can declare its app entry point and evidence of a sign-in challenge:

```json
{
  "auth": {
    "entryPath": "/app/",
    "origins": ["https://login.example.com"],
    "paths": ["/sign-in", "/sign-in/"],
    "signedOutSelector": "form[data-view='sign-in']"
  }
}
```

`entryPath` is a path on the approved adapter origin. A trailing slash in `paths` matches a directory. `origins` lists exact HTTPS identity providers for the selected tab. Use a selector unique to the signed-out state. Only the visible marker's presence is checked on the approved app origin. Sign-in provider origins receive no scripting permission from this declaration.

Opening the app or sign-in tab requires a person to choose the pending action in the extension. If Chrome hides the selected tab's URL, this action opens the configured app entry in a new tab. Resume checks the current app origin, allowed path and any configured account identity. An account mismatch stops the run. For a background-only adapter, return to the runner before resuming.
