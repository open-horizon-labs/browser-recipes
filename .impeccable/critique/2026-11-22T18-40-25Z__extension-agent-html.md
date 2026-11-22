---
target: Workflow and recipe runners
total_score: 24
max_score: 40
na_heuristics: ""
p0_count: 0
p1_count: 2
target_identity: "file:extension/agent.html"
target_fingerprint: "sha256:7d4186bec46f6751a2ac929cf8bf7ee46589869a3f276ff4797bf18903fdefb4"
target_path: extension/agent.html
timestamp: 2026-11-22T18-40-25Z
slug: extension-agent-html
---
# Workflow and recipe run inspection

Two independent assessments reviewed the browser extension's task runner on commit 2cffc5e. The design review examined the workflow implementation and the calendar review screenshot. The detector and narrow-screen assessment used disposable headless Chromium.

## Findings before changes

| Heuristic | Score / 4 |
| --- | --- |
| Visibility of system status | 2 |
| Match to the user's language | 3 |
| Control and freedom | 2 |
| Consistency | 3 |
| Error prevention | 2 |
| Recognition | 2 |
| Efficiency | 2 |
| Visual economy | 3 |
| Error recovery | 2 |
| Help | 3 |

The total was 24/40. Native labels, explicit write approvals and structured failure records served the operator well. In a repeated workflow, a reviewer could recognize a completed step but had to reconstruct which execution it belonged to. At a handoff, the reviewer needed the pending request, affected destination and safe next action together.

- **P1.** Step history did not identify the workflow execution. Two runs of the same definition could look identical. The recipe panel also lost its output and run reference when the user changed tabs.
- **P1.** Selecting another workflow discarded the active workflow's unsaved review and results.
- **P2.** The missing-tab instructions appeared after execution steps and directed the operator to a disabled picker. On a 360-pixel screen, the remedy sat below the initial viewport. The calendar review also kept both Prepare review and Use selected items emphasized after the items were ready.
- **P2.** A human who needed to sign in or complete a draft had no shared list of tagged requests, destination control or review history.

The desktop detector found no primary or advisory issues. At 360 pixels it reported one final word on its own line in each of two paragraphs. These affected the missing-tab workflow guidance and the recipe runner status. The code scan found no violations.

## Changes and evidence

Runs now groups each workflow execution with its child recipe runs and records which actions a human answered. People can filter by tag and open a waiting run from either runner. Sign-in recovery and foreground access appear at the point of need. Each destination opens only when the user activates its button. Inputs and outputs can be retained for the browser session by explicit choice. Guided execution remains available, with the active step above the step list and a confirmation when leaving unsaved work.

A real extension in a disposable Chromium profile launched an expense review fixture, rendered the pending handoff at 1280 and 360 pixels, accepted its JSON response and found the completed run under its submission tag. A separate fixture approved a recipe write after reviewing its inputs, reviewed its outputs, reopened the retained result and deleted the finished record. Both widths fit the viewport. The post-change markup scan returned zero findings across the workflow runner, recipe runner and Runs page. The checks used fixture data and never selected a tab in the user's browser.

Questions skipped: the project owner had already chosen to implement the findings.
