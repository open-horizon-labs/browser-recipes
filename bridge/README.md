# Run recipes from the terminal

The CLI sends JSON over a Unix socket to a native messaging host. The host forwards requests to the extension and returns its replies. The socket is private to your Linux user. Any process running as that user can send commands while the bridge is connected.

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
