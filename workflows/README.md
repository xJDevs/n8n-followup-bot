# `workflows/` — exported n8n workflows

The 10 `Followup |` workflows, exported through the n8n public API.

**This is a snapshot, not the source of truth.** In a running deployment the real artifact lives
on the n8n server. The source of truth for *behavior* is
[`../docs/behavior-spec.md`](../docs/behavior-spec.md).

**What it is for:** it is the rollback net. n8n instances do not necessarily keep a queryable
version history, so without these files a change that breaks something has nowhere to go back to.

## What they do NOT contain

- **No credentials.** n8n stores them separately and the JSON only keeps a **reference** (`id` +
  name). In this copy every reference points to a placeholder id (`CREDENTIAL_ID_n`), so an export
  is not enough to connect to anything.
- **No patient data.** They are the graph, not the table.
- **No real contact data.** The business number, the test phone and the Telegram alert chat are
  embedded in some nodes; here they are placeholders (`+15555550199`, `+15555550100`,
  `YOUR_TELEGRAM_CHAT_ID`) that must be replaced with your own values.

**Every workflow is exported with `active: false`.** Nothing runs, and nothing sends, until you
activate it on purpose.

## How they are regenerated

```bash
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  "$N8N_URL/api/v1/workflows/<id>"
```

The fields `shared`, `meta`, `pinData`, `staticData`, `triggerCount`, `versionCounter` and
`activeVersion` are stripped — they are instance state, not the graph — and the files are saved
with sorted keys, so `git diff` shows only what really changed.

## Importing or restoring one

> ⚠️ **Re-importing is a risk event, not routine.**

1. **Deactivate the workflow first.** Re-importing an active one can leave it running with a
   half-applied graph.
2. Import the JSON.
3. **Re-link the credentials by hand.** References point by `id`; the placeholder ids do not
   exist in your instance, so until you re-link them the node has no credential and fails when it
   runs.
4. Run the validator. Offline, against these files (from this folder):

   ```bash
   node ../validator/validate.mjs --from .
   ```

   Or against the live instance, as described in [`../validator/README.md`](../validator/README.md).
   It must end in `RESULT: PASS`. Re-importing is one of the three moments the validator must be
   run (after changing a workflow, before activating a schedule, after re-importing).
5. Only then activate.

**And be careful with `Followup | Bot`:** once active, it sends WhatsApp messages to patients
every day at 9:00. While working on it, stop it from the database, which does not leave it mute:

```sql
update bot.config set value = 'true' where name = 'account_restricted';
```

Gate A aborts the run before writing a single key and alerts every day that the bot is stopped.
Release it with `'false'`.

| File | Workflow | Trigger in production |
|---|---|---|
| `bot.json` | `Followup \| Bot` — daily orchestrator | schedule, 9:00 |
| `backup.json` | `Followup \| Backup` — to S3-compatible storage (Backblaze B2) | schedule, 10:00 |
| `daily-watch.json` | `Followup \| Daily Watch` — daily report | schedule, 11:30 |
| `delivery-webhook.json` | `Followup \| Delivery Webhook` — YCloud status events | webhook |
| `send-to-patient.json` | `Followup \| Send To Patient` — **the only one that sends** | sub-workflow |
| `error-manager.json` | `Followup \| Error Manager` | Error Trigger |
| `test-send.json` | `Followup \| Test Send · OPEN 24H WINDOW FIRST` — manual test launcher | manual |
| `sql-console.json` · `ycloud-console.json` · `backup-console.json` | read-only consoles | manual |
