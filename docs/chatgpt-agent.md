# Plan with ChatGPT

The Guide and workflow agent steps use Sign in with ChatGPT for inference through your ChatGPT plan. Deterministic recipe steps run locally. This is a separate sign-in for
Browser Recipes. The native agent sends the prompt you review to OpenAI and
returns the model's text. It exposes no browser actions to the model.
[OpenAI's ChatGPT plan usage overview](https://developers.openai.com/siwc/token-sharing-open-source)

## Linux native helper

The Linux host needs Node.js 20 or later, `flock` from util-linux, and
`xdg-open` with a configured default browser. Find the Browser Recipes
extension ID on your browser's Extensions page. Run from your checkout:

```sh
./bridge/browser-recipes-agent install YOUR_EXTENSION_ID
```

Add `--browser chromium` for Chromium or `--browser browseros-neo` for
BrowserOS Neo. The installer prints the manifest path and configures the host
for that extension ID. Run the installer again if you move this checkout,
change Node installations, or reload the extension under a new ID.

## macOS or Windows local helper

Install Node.js 20 or later. On Windows this helper uses Windows PowerShell
to protect the session with your Windows account. Find the Browser Recipes
extension ID on your browser's Extensions page, then keep this terminal open:

```sh
node bridge/agent-companion.mjs YOUR_EXTENSION_ID
```

In Browser Recipes **Settings → Pair a local ChatGPT helper**, enter the code
printed in the terminal. Keep the helper running while you use the workflow.
If you restart the helper, pair again with its new code. The helper listens
on this computer only, at `127.0.0.1:18789`. Linux users can also use this
same local helper. Pairing selects the local connection for ChatGPT. Sign out
in Workflows to end your ChatGPT session before removing the browser pairing.

## Sign in and choose a model

Use **Sign in with ChatGPT** in the extension. Finish the authorization and
plan consent in your system browser, then return to the extension. Select a
model from the list available to your account. Review the prompt before you
send it. If the workflow includes a PDF or image, review its attachment list
as well. Choose a model that accepts those inputs. Responses use your ChatGPT
plan, subject to its usage limits.
[ChatGPT usage settings](https://chatgpt.com/settings/usage)

If authorization is declined or your workspace denies plan use, the built-in agent reports the denial. Your existing Outlook and Google tab sessions still work for deterministic recipes. The optional manual handoff copies a prompt and accepts a pasted reply. It never sends an inference request from the extension.

## Where credentials live

The Linux native helper keeps credentials in the owner-only
`browser-recipes-agent` configuration directory. The paired helper keeps a
separate `browser-recipes-companion` directory under the current user's
configuration directory. On macOS this defaults to
`~/Library/Application Support`. On Windows it defaults to `%LOCALAPPDATA%`,
where Windows Data Protection encrypts the session for the current Windows user.
The browser keeps the pairing code for the local helper. The extension receives connection status,
the account email, model names, and the resulting plan. When you sign out, the
agent clears local tokens and reports whether OpenAI confirmed remote
revocation. Browser Recipes currently keeps one account registration on each
host. [OpenAI's account and session guide](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

## Verification

```sh
node --test bridge/agent.test.mjs bridge/agent-companion.test.mjs
```

The tests exercise native framing, local pairing restrictions, a loopback
callback with mocked OpenAI endpoints, identity verification, and inference
stream handling. Live sign-in and receipt of Windows or macOS credentials
still need to be verified on those platforms.
