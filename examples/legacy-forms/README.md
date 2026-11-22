# Legacy form exercises

These adapters exercise the prototype's **local** ZCAL and invoice forms. The adapters are scoped to the fake server on `http://127.0.0.1:8790`, bind the displayed account, and require a background target tab. Use a new temporary database and synthetic values. Keep the extension runner or a different tab in front while a recipe runs.

Start the prototype fake server from an existing checkout:

```sh
tmp=$(mktemp -d)
node /path/to/browser-workflow-poc/dev/fake-sap/server.mjs --user FIXTURE --data "$tmp/forms.json"
```

Import `catalog.json` in Browser Recipes Settings, grant the loopback origin for the form you want to use, and open the exact paths below.

- **Appointments** at `/index.html`. Acknowledge the startup message, then stage a timed or all-day appointment. The recipe selects the main calendar, handles the custom controls, opens Additional Data, and checks the app's model. Use `DD.MM.YYYY` and, for timed events, `HH:MM:SS`. Enter a cost center manually if needed. After reviewing the staged values, use the matching save recipe with the same fields. It checks the form before confirmation and returns the app's receipt.
- **Invoices** at `/concur/index.html`. Stage the invoice with ISO dates and the fixture's exact entity and currency values. Use empty strings for the optional fields you want blank. Review the validation result, then click **Save invoice** yourself or explicitly run the separate save recipe with the same values. The save recipe checks the entire staged form and returns the app’s receipt. Use the read recipe to retrieve the saved invoice row.

- **SAPUI5 appointments** at `/sapcal/`, or in the launchpad at `/launchpad/`. The framed adapter also needs access to `http://localhost:8790`, the frame origin. Acknowledge the fixture message, stage a timed appointment, review the form, and run its separate save recipe. The app loads the pinned SAPUI5 framework from the public CDN. The UI5 account marker is the fixture's visible display name, so this scope is for the fake app only.

Live SAP and live Concur require separately verified adapters. The plain ZCAL Cost Center field requires trusted keyboard input. The recipe leaves it for the operator.


## Browser verification

After building Browser Recipes and installing the integration dependencies, run:

```sh
FAKE_SAP_ROOT=/path/to/browser-workflow-poc/dev/fake-sap CHROMIUM_PATH=/path/to/chromium node integration/legacy-forms.mjs
```

The test starts the fake app on a disposable loopback port and discards its synthetic database afterward. Set `VERIFY_UI5=1` to add the direct and framed SAPUI5 scenarios. That run also allows the pinned public UI5 assets.
