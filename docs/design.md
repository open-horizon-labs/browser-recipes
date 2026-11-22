# Design notes from the hackathon prototype

The goal was to let a maintainer use an agent to discover a browser task once, then run the same steps from a scheduled script while the user works in another tab.

## Keep the browser runner independent

The prototype let a person pick an open tab, run a recipe, and review the result in the side panel. During the rewrite we kept the interpreter and moved its only Run control into the CLI. That made an external host a prerequisite even when the caller already lived inside the extension. The restored panel calls the same dispatcher directly. The CLI and ChatGPT helper serve the callers that cross a process boundary. The integration checks exercise the panel with the CLI bridge switched off.

## Run with Chrome remote debugging disabled

A workflow runner must work in the user’s existing browser with remote debugging disabled. A runner that requires a Chrome DevTools Protocol (CDP) connection would rule out desktops where IT prohibits it, even if it could replay every recipe.

The CLI connects through a private Unix socket on Linux and macOS, or an authenticated named pipe on Windows. Chrome Native Messaging carries the request between the host and the extension. The host registration names the permitted extension ID. The extension checks both the exact origin approved in its settings and Chrome’s host permission before acting on the selected tab. Replay requires neither a debugging port nor the extension’s `debugger` permission. Programs running under the same desktop account can call the bridge while it is enabled. [Host registration](../bridge/browser-recipes) · [Origin checks](../extension/access.js)

## Verify without taking over the desktop

Use a disposable headless browser for installation, side-panel, and permission-dialog tests. To check a live signed-in tab while its owner works, use the installed runtime’s background commands. If setup needs a foreground prompt, leave it for the user to open when convenient. Desktop focus switches, pointer clicks, and synthetic keystrokes defeat the reason to use this runtime.

## Confirm writes in the app

In a background tab, a date field displayed the new value while the app still held the old one. Save validation failed. A write recipe should check the app’s confirmation or read back the saved record. The integration test submits a response and compares the stored text with the input.

## Download attachments in the signed-in tab

The prototype needed a document behind an authenticated link. A separate process with just the URL lacked the user’s session. The extension fetches the file in the selected tab, checks the adapter’s allowed path, and converts the document locally. For a scan with no extractable text, it returns the file. Failure records omit document bytes and form values.

## Separate authoring from replay

During discovery an agent needs page labels, links, and permission to try draft steps. A scheduled script needs only the installed recipe, tab ID, and inputs. Users enable discovery and draft execution in extension settings. Site selectors and recipes live in the community catalog so a contributor can fix them independently of the extension.

The runner stops at the first failed step and reports which earlier steps completed. A caller can then check whether a write took effect before deciding to retry. The browser test breaks a target, checks the error record, and runs a repaired draft while another tab stays selected. [Integration test](../integration/smoke.mjs)

## Compose recipes in the catalog

The Workflows page reads the installed list of tab roles and steps. The catalog defines which recipes to run, which results to pass to the next step, and where to request approval. A workflow can use deterministic transforms, a reviewed Sign in with ChatGPT inference call, or both. The calendar example shares its runner with headline comparison and invoice review. [Prototype audit](prototype-audit.md) · [Workflow format](https://github.com/open-horizon-labs/browser-recipes-catalog/blob/main/docs/workflows.md)
