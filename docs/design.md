# Aim and salvage · 2026-11-22

A maintainer should be able to teach an agent a browser task once, put its recipe through code review, and give the same recipe to a scheduled program. The user can keep working in the foreground. When the app changes, a maintainer should be able to find the broken step from one failed run.

## What the prototype taught us

The hackathon explored transferring information between signed-in apps. Its documentation records a date field that looked filled but still failed the app's save validation when the tab lacked focus. A DOM mutation is weak evidence of a successful write. A useful recipe checks an app-owned result, such as the saved row or confirmation state. The workshop checks the saved status and reads back the stored response.

Another workflow needed documents behind an authenticated link. A URL alone could not carry the user's access to a separate worker. Fetch in the target tab's session, scope the request to declared paths, convert locally, and preserve a file result for image-only documents. Treat attachment bytes as caller data and keep them out of repair logs.

The prototype had a development capture loop alongside a panel for reviewed tasks. Those users need different capabilities. A runtime caller needs to choose a tab, bind inputs, execute a known recipe, and receive a result. An author needs to inspect links and controls, try a draft, and investigate failure. Give the user control of authoring access.

## Restart decisions

* Keep the browser connection, permission checks, interpreter and error contract in one project. Put site knowledge in community-owned data that can be patched independently. Share target names across recipes so a site change can have one fix.
* Address tabs explicitly. An open, authenticated, scriptable top-level document is an assumption. Native dialogs, trusted gestures and controls inside inaccessible frames can require a different integration.
* Use a single machine-readable call path for agents and conventional programs. The runtime owns execution order. The caller owns decisions about retrying a partial write.
* Use read-only live apps and a local write-and-attachment fixture. These examples and the implementation were authored for this project. Organization-specific workflows and captured sessions are outside the public catalog.

## Feedback

On each change, exercise an inactive tab while another tab stays selected. Read a result, save and read back a value, and retrieve an attachment. Break one target and use the reported step to repair a draft. If an agent needs browser screenshots or fresh planning on every successful replay, the project has missed its aim. If the handoff contains form values, document bytes or private page text, it exposes more than a maintainer needs.
