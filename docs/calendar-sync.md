# Copy Outlook events to Google Calendar

Use this catalog workflow to mark Outlook meetings as **Busy** on a Google calendar. You can stop at the preview to see what it would import. The workflow reads two signed-in browser tabs. Its agent step uses your ChatGPT plan to interpret the event labels. Browser Recipes compares times and prepares the file locally.

## Prepare the tabs

1. Install the extension and load the catalog. Grant the Outlook and Google Calendar sites in Settings. Grant the origin your signed-in Outlook tab uses, either `outlook.cloud.microsoft` or `outlook.office.com`. [Getting started](getting-started.md)
2. Open Outlook and Google Calendar in the same browser profile. Show the same week on both sides. Show only the intended calendar in Google if you want to compare against that calendar alone. Any other visible event can count as occupied time.
3. Open **Browser Recipes → Workflows**, choose **Copy Outlook events to Google Calendar**, and assign each tab by title and ID. You can keep another tab in front.
4. Under **ChatGPT connection**, choose **Sign in with ChatGPT** and complete plan authorization. This connects the agent to OpenAI. Outlook and Google keep using their existing browser sessions. [Helper setup and account storage](chatgpt-agent.md)

## Preview what would be imported

1. Choose **Run to next review**. Check the two local snapshots, dates and time zones. Remove details you do not want to send. An incomplete week or a missing meeting calls for checking the source view before proceeding.
2. Enter the first and last dates shown and each calendar’s time zone. Choose a model and **Send to ChatGPT**. The model returns event times and identifies entries it could not resolve.
3. Choose **Prepare review**. Check the proposed blocks against Outlook. For example, if Outlook shows meetings from 9–10 and 11–12 and Google already shows the 9–10 block, only 11–12 should be offered as missing. **Stop here for a preview.** Reading, comparing and displaying this list creates no events.

![A test week with one missing Outlook block available for selection](images/getting-started/calendar-review.png)

## Import the blocks you approve

1. Check the missing blocks you want and choose **Use selected items**. Titles default to **Busy**. Enable **Copy event titles to Google Calendar** if you want the reviewed meeting names. Run the file preparation step.
2. Enter the exact destination calendar name and choose **Choose destination calendar**. This opens import settings in the selected background tab and checks the account and calendar.
3. Review the file and destination, then choose **Import approved blocks into Google Calendar**. The recipe checks the account and calendar again, attaches the file, clicks Import and looks for Google’s receipt. If the receipt is missing or unclear, inspect the destination week before trying again.

Each run copies selected occurrences in one direction. A change or cancellation in Outlook requires checking the old Google block. The file omits attendees, locations and meeting links.

The [browser integration test](../integration/calendar.mjs) uses synthetic calendars and a simulated model response. It checks the preview, the destination guard and the import receipt. Live ChatGPT consent and an import into a real account require separate verification.
