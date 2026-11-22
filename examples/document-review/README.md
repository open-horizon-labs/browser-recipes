# Review invoice fields against their source

This local example uses two fictional ticket records and text and raster copies of the same sample invoice. It shows record selection, file selection, local PDF conversion, and evidence review.

1. From the repository root, run `python3 -m http.server 8769 --bind 127.0.0.1 --directory examples/document-review/site`.
2. In Browser Recipes Settings, load [the example catalog](catalog.json) and add its entries to any catalog you already use. Grant the sample origin.
3. Open [the local record list](http://127.0.0.1:8769/). In **Workflows**, choose **Review invoice fields against the source** and select that tab.
4. Choose one record and one file. For the text PDF, the agent preview shows the converted Markdown. The raster PDF appears as an attachment, which you can choose to share.
5. Review the extracted fields. **verified-text** means the quoted text matched the specified page and supported the proposed normalized value. **review-scan** means a person must compare the value and quote against the scan.

The workflow performs reads and shows its results. It does not submit an invoice. [Configured ServiceNow source setup](../../docs/servicenow-source.md)

The isolated Chromium check at [integration/documents.mjs](../../integration/documents.mjs) exercises the workflow UI against mock native hosts. Build the extension, install the integration dependencies, and run `node integration/documents.mjs`. Set `CHROMIUM_PATH` if Chromium is installed outside Playwright’s default location.
