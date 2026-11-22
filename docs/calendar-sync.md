# Copy Outlook events to Google Calendar

Use this catalog workflow to mark Outlook meetings as **Busy** on a Google calendar. You can stop at the preview to see what it would import. The workflow reads two signed-in browser tabs. Its agent step uses your ChatGPT plan to interpret the event labels. Browser Recipes compares times and prepares the file locally.

## Prepare the tabs

1. Open **Browse workflows**, choose **Copy Outlook events to Google Calendar**, and install it. Follow **Set up Copy Outlook events to Google Calendar** to grant site access. Grant the origin your signed-in Outlook tab uses, either `outlook.cloud.microsoft` or `outlook.office.com`. [Getting started](getting-started.md)
2. Open Outlook and Google Calendar in the same browser profile. Choose Week view in both tabs. Show only the intended calendar in Google if you want to compare against that calendar alone. Any other visible event can count as occupied time.
3. Open **Browser Recipes → Workflows**, choose **Copy Outlook events to Google Calendar**, and assign each tab by title and ID. You can keep another tab in front.
4. Under **ChatGPT connection**, choose **Sign in with ChatGPT** and complete plan authorization. This connects the agent to OpenAI. Outlook and Google keep using their existing browser sessions. [Helper setup and account storage](chatgpt-agent.md)

## Preview what would be imported

1. Enter the first and last day to compare (one to seven days, inclusive). Choose **Run to next review**. The readers page to those dates. Check both returned ranges and event lists. Remove details you do not want to send. An incomplete week or a missing meeting calls for checking the source view before proceeding.
2. Enter each calendar’s time zone. Choose a model and **Send to ChatGPT**. The model returns event times and identifies entries it could not resolve.
3. Choose **Prepare review**. Check the proposed blocks against Outlook. For example, if Outlook shows meetings from 9–10 and 11–12 and Google already shows the 9–10 block, only 11–12 should be offered as missing. **Stop here for a preview.** Reading, comparing and displaying this list creates no events.

![A test week with one missing Outlook block available for selection](images/getting-started/calendar-review.png)

## Filter or change events with your own instructions

Before reading Outlook, check **Review each recipe’s inputs and outputs for optional ChatGPT edits**. Run the Outlook read, then open **Filter or change outputs with ChatGPT**. For example, enter “Remove events whose title starts with FYI. Change the remaining meeting titles to Busy in both the text and the event labels.” Choose **Review request**, check the data, and send it. ChatGPT interprets the instruction and proposes edits to the rows. The review shows how many list items it proposes to remove and how many values it proposes to change. If it proposes no edits, your original output stays in use. Compare the proposal with the original. Choose **Use proposed outputs** and then **Continue with these outputs** to pass the edited week to the next step. The meetings in Outlook stay as they were.

For a recipe that takes inputs, the same controls appear before it runs. Applying a proposed input fills in the reviewed values. You still choose whether to execute the recipe.

## Import the blocks you approve

1. Check the missing blocks you want and choose **Use selected items**. Titles default to **Busy**. Enable **Copy event titles to Google Calendar** if you want the reviewed meeting names. Run the file preparation step.
2. Enter the exact destination calendar name and choose **Choose destination calendar**. This opens import settings in the selected background tab and checks the account and calendar.
3. Review the file and destination, then choose **Import approved blocks into Google Calendar**. The recipe checks the account and calendar again, attaches the file, clicks Import and looks for Google’s receipt. If the receipt is missing or unclear, inspect the destination week before trying again.

Each run copies selected occurrences in one direction. A change or cancellation in Outlook requires checking the old Google block. The file omits attendees, locations and meeting links.

The [browser integration test](../integration/calendar.mjs) uses synthetic calendars and a simulated model response. It checks the preview, the destination guard and the import receipt. The [live recipe-edit test](../integration/live-recipe-edit.mjs) uses your existing Browser Recipes ChatGPT sign-in with synthetic event rows. Run `node integration/live-recipe-edit.mjs` after building the extension to check that accepted model edits reach the next workflow step.
