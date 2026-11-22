# Writing a browser recipe

An adapter describes a single exact HTTP(S) origin. Use a separate adapter for a different host, scheme or port. Start discovery for a new site by importing an adapter with an empty recipe list, granting that origin and enabling developer tools. Install it alongside the entries you want to keep. Saving the editor replaces the local catalog.

```json
[
  {
    "id": "my-app",
    "title": "My app",
    "origin": "https://app.example.com",
    "targets": { "heading": "main h1" },
    "recipes": []
  }
]
```

Run `tabs` to get the tab ID, then `dev.inspect` to list controls and same-origin links. Choose a selector that matches one element. Prefer an app-defined ID or data attribute when available. Put the selector in `targets` to reuse it across recipes.

## Recipe format

A recipe contains an `id`, `title`, ordered `steps` and optionally `inputs`. Identifiers for adapters, recipes, targets, inputs and output keys use lower-case letters, digits and hyphens, beginning with a letter. Names in `as` must be unique within a recipe. A recipe has up to 30 steps. Inputs use `{"type":"string"}` or `{"type":"attachment"}`, and may set `"required":true`. Referenced inputs must be supplied.

| Operation | Fields in addition to `op` | Effect |
| --- | --- | --- |
| `navigate` | `path` | Navigate the selected tab to a same-origin absolute path. |
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

A step that takes `target` can instead supply a CSS `selector` directly. Every step resolves its selector against the current top-level document. A missing or ambiguous single-element target stops the run. Most operations require a visible element. After a write, read back the saved value to check that the app accepted it.

`readList` returns up to 500 visible rows, each with rendered text and the requested public attributes when present. Supported attributes are `aria-label`, `aria-checked`, `aria-selected`, `aria-expanded`, `data-eventid`, `data-calitemid`, `data-datekey`, `label`, and `checked`. The `label` attribute returns the associated form label or explicit ARIA label. For a checkbox, `checked` reports its current state as `"true"` or `"false"`. Use `text` for a case-insensitive substring match and `waitMs` (up to 8000) to wait for a result. An empty list can be legitimate. Add an `assert` on a control unique to the starting view when a recipe needs to distinguish an empty result from the wrong page.

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
