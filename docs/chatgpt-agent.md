# Plan with ChatGPT

The optional local agent uses the open-source Sign in with ChatGPT flow to
request model access through your ChatGPT plan. This is a separate sign-in for
Browser Recipes. The native agent sends the prompt you review to OpenAI and
returns the model's text. It exposes no browser actions to the model.
[OpenAI's ChatGPT plan usage overview](https://developers.openai.com/siwc/token-sharing-open-source)

## Install the local agent

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

Use **Sign in with ChatGPT** in the extension. Finish the authorization and
plan consent in your system browser, then return to the extension. Select a
model from the list available to your account. Review the prompt before you
send it. Responses use your ChatGPT plan, subject to its usage limits.
[ChatGPT usage settings](https://chatgpt.com/settings/usage)

## Where credentials live

The native agent keeps the active account's credentials in a private Linux
configuration directory named `browser-recipes-agent` under
`${XDG_CONFIG_HOME:-$HOME/.config}`. The extension receives connection status,
the account email, model names, and the resulting plan. When you sign out, the
agent clears local tokens and reports whether OpenAI confirmed remote
revocation. Browser Recipes currently keeps one account registration on each
host. [OpenAI's account and session guide](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

## Verification

```sh
node --test bridge/agent.test.mjs
```

The tests exercise the native host framing, a loopback callback with mocked
OpenAI endpoints, identity verification before credential replacement, and
completed versus interrupted inference streams. A live account still needs
to complete and consent to the sign-in flow.
