# Call a recipe or workflow and inspect its run

The toolbar runner and local command-line helper can both start a run. A recipe performs one app operation. A workflow calls installed recipes and passes named outputs to later steps. To see what’s installed, run the following from the runtime checkout after connecting the terminal helper.

```sh
./bridge/browser-recipes definitions.list
./bridge/browser-recipes tabs
```

Recipe definitions describe the inputs, output names, operation kind and effect. For example, a search accepts criteria, while a get operation retrieves a particular item. Check the effect to see whether the recipe can change the app. Workflows describe their tab roles, public inputs and output bindings. A caller starts either kind on demand.

## Start and inspect

For the catalog’s headline comparison, replace 123 with your Hacker News tab ID.

```sh
./bridge/browser-recipes runs.start '{"kind":"workflow","workflowId":"compare-hacker-news","tabs":{"news":123}}'
./bridge/browser-recipes runs.start '{"kind":"recipe","adapterId":"hacker-news","recipeId":"front-page","tabId":123,"inputs":{}}'
```

The reply includes a run ID and status. A completed call returns its result. Supply an optional caller-generated UUID as `runId` if a retry might otherwise start the same job twice. Reuse that ID only for the original request. If the local command times out, look up that run before attempting another write. The older `run` command still executes a single recipe directly and returns its usual outputs.

```sh
./bridge/browser-recipes runs.list '{"status":"waiting","tag":"draft-submission"}'
./bridge/browser-recipes runs.get '{"runId":"RUN_ID"}'
```

In the browser, open **Runs** and choose the same ID. Each workflow step records its input references and output names. For example, the calendar import can show that its file came from the file-preparation step. A recipe called from a workflow has its own run ID and links back to the parent. The run records its start and finish times, caller, and definition revision.

## Respond to a request

Every user action uses the same `waiting` status. The pending request has an ID, a label and tags. A Concur workflow can pause when its draft is ready for submission. The reviewer opens the report, checks it, submits if appropriate, and acknowledges the handoff. A recipe write has a separate approval requesting an explicit decision. Use the browser controls, or send the answer for that specific action from the calling program.

```sh
./bridge/browser-recipes runs.get '{"runId":"RUN_ID","includeData":true}'
./bridge/browser-recipes runs.resume '{"runId":"RUN_ID","actionId":"ACTION_ID","answer":{"decision":"run"}}'
```

The decision above approves a write. A handoff accepts an object such as `{}` or `{"value":{"reviewed":true}}`. A selection takes `{"indices":[0,2]}`. The next pause gets its own action ID. Answering a stale request fails. If a write might already have happened, the run asks for verification before another attempt.

For sign-in, choose **Open app in browser** on the request. Sign in on the site and return to Runs. Runs checks the site and account again and continues when the connection is ready. If the run needs a background tab, select another tab. **Check now** retries from the same screen. Scripts can include the review link in a handoff.

## Private results and history

Run records keep timing, status, action tags and data-flow references locally. Private values needed to resume a shared run are available within the browser session. Request them with `includeData:true` only when needed. The reply that completes a run includes its result. When you continue a paused run in the browser, Runs keeps its final result until the browser closes. To keep intermediate step data in the same session, enable result retention at start or pass `"retainData":true`. An ordinary history query omits payloads. Losing the browser session can end a paused run.

```sh
./bridge/browser-recipes runs.cancel '{"runId":"RUN_ID"}'
./bridge/browser-recipes runs.forget '{"runId":"FINISHED_ROOT_RUN_ID"}'
```

Cancellation stops remaining steps. Deleting a finished run removes its history, child records, and retained results. A record marked completed means the declared steps finished. Use the app’s receipt or a verification recipe to confirm an external write.
