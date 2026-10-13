# Invariant validator

Reads the `Followup |` workflows from the live n8n instance and checks the structural invariants
that can break without n8n raising any error. It only does `GET`, works in memory and never saves
exports.

## How to run it

From the repository root:

```bash
node validator/validate.mjs
```

The API key is read directly from the macOS Keychain (`n8n-api-key`); it is never taken as an
argument nor printed. The instance URL is the `API_URL` constant in `validate.mjs`. The last line
always starts with `RESULT` and tells three outcomes apart:

- exit code `0`: every check passed;
- exit code `1`: violations found; each fix is done separately, with notice and a backup;
- exit code `2`: could not verify (access, API, or no `Followup |` workflow). It does not count
  as a pass.

`--from <folder>` reads workflow exports from disk instead of the instance, and says so in the
`RESULT` line. It is how the exports in `workflows/` and the fabricated cases are checked, with no
network access:

```bash
node validator/validate.mjs --from workflows
node validator/validate.mjs --from validator/cases/base
node validator/test.mjs
```

The files in `cases/base/` are hand-written and contain no exports, webhook paths, Telegram chats
or real data.

## When to run it

1. After any change to a `Followup |` workflow, before closing that change.
2. Before activating a Schedule or switching a workflow on.
3. After re-importing a backup.

The validator checks structure and parameters; it does not evaluate expressions or the code of
Code nodes. A `PASS` does not replace the functional checks of each change.

## What it checks

| Slug | Invariant | What breaks it |
|---|---|---|
| `inventory` | — | A `Followup \|` workflow with an unknown id, a renamed one, or a missing one |
| `send-without-retry` | INV-4 | The `Send` node of `Followup \| Send To Patient` without an explicit `retryOnFail: false` |
| `key-before-send` | INV-2 | Any path to `Send` that skips `Claim Key` or the true branch of `Claimed?` |
| `gates-before-sender` | INV-8 | Any path to the sender call in `Followup \| Bot` that skips `Channel Healthy?` or `OK To Send Today?` |
| `telegram-html` | INV-15 | A Telegram node without an explicit `parse_mode: HTML` |
| `no-deletes` | INV-16 | A delete operation, an HTTP `DELETE`, or `DELETE`/`TRUNCATE`/`DROP` in SQL (comments and literals ignored) |
| `error-output-wired` | INV-13 | `onError: continueErrorOutput` with the error output left unconnected |
| `sql-params-array` | INV-13 | A Postgres `queryReplacement` that is not an expression building an array |
| `error-workflow-assigned` | INV-13 | A scheduled or webhook workflow without `Followup \| Error Manager` as its error workflow |
| `executions-without-data` | INV-13 | Backup, Daily Watch or Backup Console saving successful executions (they carry patient data) |
| `timezone` | INV-8 | A workflow with a Schedule trigger whose `settings.timezone` is not `America/Costa_Rica` |
