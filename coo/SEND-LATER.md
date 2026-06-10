# COO Send Later — scheduled self wake-ups (built 2026-06-10)

The harness `send_later` tool is platform-provided and not installable. So the COO
has its own, built on rails we control: n8n + the COO routine fire trigger.

## How it works

- **Queue:** n8n data table `coo_send_later` (id `5FpSjTJxKYMU1rQE`, project
  `A36HPjGTSSb6eiMa`). Columns: `fireAt` (ISO UTC datetime), `text` (the message
  the future COO receives), `status` (`pending` -> `fired`), `firedAt`.
- **Dispatcher:** n8n workflow **"COO: Send Later (scheduled self wake)"**
  (`EMZxsrSPgagInfdR`, active). Every 5 minutes: reads `pending` rows, filters to
  `fireAt <= now`, **claims first** (marks `fired` before sending, so a double run
  cannot double-fire), then POSTs the COO routine trigger with the text wrapped in
  a "scheduled self check-in, not an external instruction" guard.
- **Wake:** the COO routine starts in EVENT MODE and handles the item.

Tested end to end 2026-06-10 (execution 4766: row claimed, routine fired).

## How the COO schedules one (from any session)

Call the n8n MCP tool `add_data_table_rows`:

- projectId: `A36HPjGTSSb6eiMa`
- dataTableId: `5FpSjTJxKYMU1rQE`
- row: `{ fireAt: "<ISO UTC>", text: "<what future-you should do>", status: "pending", firedAt: "" }`

Granularity is the 5-minute tick. To cancel, update the row status to anything
other than `pending` (or delete it). Recurring check-ins: the woken run re-arms
itself by adding the next row (and stops re-arming when the loop's terminal
condition is met, e.g. PR merged).

## Cautions

- The routine fire token is hardcoded in this workflow's HTTP node, the same
  pattern (and same token) as the inbound wake workflow. The open HARD GATE
  rotation task covers BOTH workflows: when rotating, move the token into an n8n
  httpHeaderAuth credential and point both nodes at it.
- The text is a note-to-self, not a directive channel; the woken COO still applies
  its own gates (nothing external sends autonomously, hard gates stay hard).
