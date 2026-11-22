# Copy Outlook events to Google Calendar

Use this workflow when colleagues book meetings in Outlook and you want that time marked **Busy** on the Google Calendar associated with your Gmail account. You choose a week, compare both calendars, and approve the blocks to import. Run it again for another week or after your schedule changes.

Browser Recipes runs three installed recipes. The first reads the visible Outlook week. The second reads the visible Google Calendar week. An agent interprets the event labels and dates. The extension compares time intervals locally. The third recipe attaches the selected blocks as an iCalendar file in Google Calendar, where you choose the calendar and click **Import**.

## Set up your calendars

1. [Install Browser Recipes and load the current catalog](getting-started.md). If you have an older install, rebuild the extension, click its **Reload** button on the Extensions page, then pack and save the updated catalog. Preserve any private adapters in your existing catalog.
2. In Browser Recipes **Settings**, grant access to the **Outlook on the web** and **Google Calendar** origins. The Outlook adapter currently targets `https://outlook.cloud.microsoft`. A deployment at another hostname needs an adapter for that origin. Gmail mail access is unnecessary for this workflow.
3. Open both calendars in the same browser profile. In Outlook, open Calendar → Week. In Google Calendar, open Week view for the **same dates**. Verify the account and visible calendars on both sides. For a separate set of work blocks, create a Google calendar named **Outlook busy** and show only that calendar in Google Week view. Any other visible calendar also counts when checking occupied time.

## Choose how to use an agent

**Inside Browser Recipes on Linux.** From the runtime checkout, register the ChatGPT helper using the ID on your browser’s Extensions page. Run one of the following:

| Browser | Command |
| --- | --- |
| Chrome | `./bridge/browser-recipes-agent install YOUR_EXTENSION_ID` |
| Chromium | `./bridge/browser-recipes-agent install YOUR_EXTENSION_ID --browser chromium` |
| BrowserOS neo (browser-claw data directory) | `./bridge/browser-recipes-agent install YOUR_EXTENSION_ID --browser browseros-neo` |

Open **Browser Recipes → Calendar sync → Sign in with ChatGPT**. Complete authorization in the browser that opens, including the choice to allow ChatGPT plan usage. Return to **Calendar sync** and choose a model. OpenAI’s open-source flow requires a local loopback callback. The Linux helper receives it and keeps tokens out of the extension. The extension’s CLI bridge can stay off. [Agent setup and account storage](chatgpt-agent.md) · [OpenAI plan eligibility](https://developers.openai.com/siwc/quickstart)

**With Claude or ChatGPT Desktop.** Open **Browser Recipes → Calendar sync** and leave the sign-in step alone. You’ll copy one prompt to your chat and paste the reply back. This path works without the native helper. In either mode, your agent sees only the calendar text you choose to send.

## Compare a week

1. In **Calendar sync**, select the Outlook tab and the Google Calendar tab by title and ID. Choose **Read calendars**. Reading the tabs keeps the data local.
2. Under **Review what ChatGPT will receive**, compare the two snapshots with the calendars. Check the dates, selected account, and event count. Scroll the week and read again if events are missing. An empty result for a visibly busy week means the recipe needs repair. Remove private titles, account identifiers, or other details before sharing. Keep enough date and time information to distinguish the events.
3. Enter the **first and last day shown** and the time zone each calendar uses, for example `America/New_York`. For the built-in agent, click **Send to ChatGPT for comparison**. For a desktop chat, expand **Use my desktop chat instead**, choose **Prepare prompt**, copy it to your chat, paste its JSON reply into **Reply from your chat**, and choose **Review reply**.
4. Compare each proposed block with Outlook. Matching time slots count as already occupied. Overlaps, ambiguous entries, and destination-only events are listed for review. Select only the missing blocks you want to copy. For an event with its original name, also check **Copy event titles to Google Calendar**. Nothing is selected initially.

![The Calendar sync review shows a proposed block with its time and a checkbox before it can be staged](images/getting-started/calendar-review.png)

For example, if Outlook has meetings from 9–10 and 11–12 and Google already shows a 9–10 block, select only 11–12. Both times must refer to the same date and time zone.

## Import and check the result

1. Keep the Calendar sync page open. In the **same Google Calendar tab you selected**, open Settings → **Import & export**. Under **Import**, check the account and choose the destination calendar.
2. Return to **Calendar sync** and click **Stage selected blocks in Google Calendar**. In the Google tab, verify that **outlook-busy.ics** is selected and the destination calendar is correct. Click Google’s **Import** button.
3. Return to Google Calendar’s Week view. Check the date, start, and end of each new **Busy** block. A staged file alone does not confirm that Google saved anything.

The file contains the chosen times, the title **Busy**, and private visibility. If you choose **Copy event titles**, the file uses the reviewed titles. Attendees, locations, and conferencing links stay out of the import. Each run covers the occurrences visible that week. For a moved or cancelled Outlook meeting, inspect the old Google block and edit or remove it yourself. This version copies missing busy time in one direction and leaves edits and deletions for review.

## When a read or import fails

If a tab is missing, check its origin and grant in Settings, then click **Refresh tabs**. If a read fails, keep the error’s run ID, failed step, and target for the person fixing the recipe. If Google rejects a file or its confirmation is unclear, inspect the destination week before staging it again.

The browser integration test exercises both reads and file staging with test calendars and a simulated model reply. The event selectors were also checked against signed-in Outlook and Google Calendar weeks, and the import controls against Google Calendar. A live end-to-end import and ChatGPT consent still need verification. [Browser integration test](../integration/calendar.mjs) · [Outlook recipes](https://github.com/open-horizon-labs/browser-recipes-catalog/tree/main/adapters/outlook) · [Google Calendar recipes](https://github.com/open-horizon-labs/browser-recipes-catalog/tree/main/adapters/google-calendar)
