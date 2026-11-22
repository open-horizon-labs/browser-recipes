# Local CLI bridge

The bridge uses Chrome Native Messaging and a Unix domain socket inside a
private directory for your Linux user. Python 3.9 or newer is required.
Programs running as your Linux user can send commands when the bridge is
enabled and connected. They act through Tab Recipes in the connected browser.

1. Load Tab Recipes as an unpacked extension and copy its ID from the browser's Extensions page.
2. Register the executable for that ID. Run from the repository root:

   ```sh
   ./bridge/tab-recipes install YOUR_EXTENSION_ID
   ```

   For Chromium, add `--browser chromium`. The manifest uses the absolute
   path of this checkout. Register again if you move it.
3. Open Tab Recipes Options and enable the local bridge. Only one browser
   connection can own the local socket at a time.

## Commands

```sh
./bridge/tab-recipes catalog
./bridge/tab-recipes tabs
./bridge/tab-recipes run '{"tabId":123,"adapterId":"example","recipeId":"read","inputs":{}}'
./bridge/tab-recipes dev.inspect '{"tabId":123,"adapterId":"example"}'
./bridge/tab-recipes dev.test - < test-request.json
./bridge/tab-recipes dev.failures
```

Pass an argument object as a JSON string or use `-` to read JSON from stdin.
`dev.test` accepts an object with `tabId`, `adapterId`, `recipe`, and
`inputs`. Use `catalog` and `tabs` to obtain identifiers from the browser.

Successful commands print the JSON result to stdout. Errors from the browser
print a JSON object with an `error` key to stdout and exit with status 1.
Local bridge errors use stderr and exit with status 1. The bridge reports
`BUSY` if a second command arrives during an active command. A timeout means
the bridge did not receive the result before its deadline. The browser action
may already have run.

To disconnect the bridge, disable it in Options. To remove the registration,
delete the manifest whose path was printed by `install`.

## Tests

```sh
python3 -m unittest discover -s bridge
```
