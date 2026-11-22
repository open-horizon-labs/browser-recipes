# Design notes from the hackathon prototype

The goal was to let a maintainer use an agent to discover a browser task once, then run the same steps from a scheduled script while the user works in another tab.

## Run with Chrome remote debugging disabled

A workflow runner must work in the user’s existing browser with remote debugging disabled. A runner that requires a Chrome DevTools Protocol (CDP) connection would rule out desktops where IT prohibits it, even if it could replay every recipe.

On Linux, the CLI connects to a Unix socket private to the user. Chrome Native Messaging carries the request between the host and the extension. The host registration names the permitted extension ID. The extension checks both the exact origin approved in its settings and Chrome’s host permission before acting on the selected tab. Replay requires neither a debugging port nor the extension’s `debugger` permission. Processes running as the same Linux user can call the bridge while it is enabled. [Host registration](../bridge/tab-recipes) · [Origin checks](../extension/access.js)

## Confirm writes in the app

In a background tab, a date field displayed the new value while the app still held the old one. Save validation failed. A write recipe should check the app’s confirmation or read back the saved record. The integration test submits a response and compares the stored text with the input.

## Download attachments in the signed-in tab

The prototype needed a document behind an authenticated link. A separate process with just the URL lacked the user’s session. The extension fetches the file in the selected tab, checks the adapter’s allowed path, and converts the document locally. For a scan with no extractable text, it returns the file. Failure records omit document bytes and form values.

## Separate authoring from replay

During discovery an agent needs page labels, links, and permission to try draft steps. A scheduled script needs only the installed recipe, tab ID, and inputs. Users enable discovery and draft execution in extension settings. Site selectors and recipes live in the community catalog so a contributor can fix them independently of the extension.

The runner stops at the first failed step and reports which earlier steps completed. A caller can then check whether a write took effect before deciding to retry. The browser test breaks a target, checks the error record, and runs a repaired draft while another tab stays selected. [Integration test](../integration/smoke.mjs)
