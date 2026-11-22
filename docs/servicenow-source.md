# Configure a read-only ServiceNow source

Use the selected-tab document workflow when the source records and links are available in your browser session. The optional ServiceNow source uses a separately authorized service account when the records are available through REST. Its credential stays in a private file on the Linux host.

## Register and configure

1. From the runtime checkout, run `./bridge/browser-recipes-servicenow install YOUR_EXTENSION_ID`. Add `--browser chromium` or `--browser browseros-neo` when applicable.
2. Create `${XDG_CONFIG_HOME:-$HOME/.config}/browser-recipes/servicenow.json` and an absolute-path credential file, both with mode `0600`. The credential file contains just the token for Bearer authentication or the password for Basic authentication. Ask your ServiceNow administrator for a read-only integration account and the allowed table and attachment permissions.
3. Replace the illustrative instance, source alias, and fields below with those approved by your administrator. For Basic authentication use `{"type":"basic","username":"INTEGRATION_USER","file":"/absolute/path/to/private-password"}` instead.

```json
{
  "origin": "https://example.service-now.test",
  "auth": {"type": "bearer", "file": "/absolute/path/to/private-token"},
  "sources": {
    "approved-records": {
      "table": "example_invoice_tasks",
      "label": "number",
      "fields": ["number", "short_description"],
      "filter": {"active": "true"},
      "limit": 30
    }
  }
}
```

The host uses HTTPS GETs on that exact instance. It sends only fixed table and attachment requests. It applies configured field and equality-filter allowlists, rejects redirects, checks that selected attachments belong to the selected permitted record, and limits downloads to 8 MiB. ServiceNow access controls still apply. [Table API](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html) · [Attachment API](https://www.servicenow.com/docs/r/xanadu/api-reference/rest-apis/c_AttachmentAPI.html)

## Run and review

Load [the local document example catalog](../examples/document-review/catalog.json). Under **Local data sources** in extension Settings, enable `servicenow`. Leave model sharing off until you have authority to share the source data. In **Review an invoice from a configured source**, enter your configured source name and choose one listed record and one attachment. Each explicit source step reads data into the workflow. Select **Use data from servicenow in AI prompts** only if you want the workflow to prepare or send the reviewed source result for inference.

The repository tests simulate the REST responses and validate local PDF conversion. They do not contact a ServiceNow tenant.
