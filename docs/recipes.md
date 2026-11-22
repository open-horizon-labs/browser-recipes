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

Call `tabs` to get the explicit tab ID and `dev.inspect` to see candidate controls and same-origin links. Use a draft to confirm the selector matches exactly one visible element. A stable app-owned ID, role or data attribute generally survives layout changes better than a long chain of child indices. Store shared selectors under `targets` so recipes can refer to a control by name.

## Recipe format

A recipe contains an `id`, `title`, ordered `steps` and optionally `inputs`. Identifiers for adapters, recipes, targets, inputs and output keys use lower-case letters, digits and hyphens, beginning with a letter. Names in `as` must be unique within a recipe. A recipe has up to 30 steps. Inputs use `{"type":"string"}` or `{"type":"attachment"}`, and may set `"required":true`. Referenced inputs must be supplied.

| Operation | Fields in addition to `op` | Effect |
| --- | --- | --- |
| `navigate` | `path` | Navigate the selected tab to a same-origin absolute path. |
| `read` | `target`, `as` | Return the element's rendered text. |
| `assert` | `target`, optional `text` | Check visibility and, if supplied, a text substring. |
| `fill` | `target`, `input` | Set a supported form control's value and dispatch input and change events. |
| `click` | `target` | Click an enabled element. This can submit a transaction. |
| `document` | `target`, `as` | Extract the selected page region as Markdown. The current path must be within the adapter's `documentPaths`. |
| `readAttachment` | `target`, `allowedPathPrefix`, `as` | Fetch the target link in the tab's session. The prefix must appear in `documentPaths`. |
| `attach` | `target`, `input` | Set a file input from a JSON object with `name`, `mimeType` and `base64` (up to 384 KiB of input bytes). |

A step that takes `target` can instead supply a CSS `selector` directly. Every step resolves its selector against the current top-level document. The runner stops on a missing, hidden or ambiguous target. A recipe should read back the app's committed value after a write when the caller needs evidence that the change took effect.

## Attachments

Declare a directory with a trailing slash, as in `"documentPaths":["/files/"]`. An entry such as `/download.do` grants that exact endpoint and accepts query parameters. Same-origin downloads reject redirects and are bounded at 8 MiB. Conversion runs locally for text PDFs, DOCX, XLSX and PPTX. It returns `{kind:"markdown",name,markdown}` when text is available. The alternate result is `{kind:"file",name,mimeType,base64}`. An image-only PDF can go directly to a caller that understands PDF files. An LLM client decides whether to transmit a document.

## Failure handoff

Save the CLI's error JSON and the catalog commit you installed. Open developer tools in extension settings and use `dev.failures` for recent failures. Compare the operation and step number with the versioned recipe, use `dev.inspect` to find the current control, and exercise the patch using `dev.test`. A successful draft can be saved as its own file under the adapter’s `recipes/` directory and shared through a catalog pull request. Turn developer tools off when you return to ordinary replay.
