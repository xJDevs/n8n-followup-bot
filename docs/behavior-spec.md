# Behavior spec — patient follow-up bot

**Version:** draft 3 · 2026-09-02 · **Status: approved by the operator on 2026-09-02**

This document defines **what the bot must do**, not how it is built in n8n. It is normative:
the node graph is built to satisfy it, and any implementation that contradicts it is wrong even
if it works.

It is self-contained: you do not need to read any other document to understand it.

---

## 1. Purpose

Send a nutritional follow-up WhatsApp message to each patient when they reach certain milestones
of their plan. Nothing else. The bot **does not chat, does not reply, does not resend, and does
not make decisions when something is ambiguous**.

---

## 2. Golden rule

> **Never send a patient a duplicate message.** Not twice on the same day, and not today and
> again tomorrow. Whenever there is any doubt about whether a message went out, **it is not
> resent**: a human is alerted and decides.

Delivery is sacrificed before a duplicate is risked. A duplicate got the business WhatsApp number
banned on 2026-07-29, and the number was lost. Any finding that carries a duplicate risk is top
priority.

---

## 3. Definitions

| Term | Meaning |
|---|---|
| **Plan start date** | The date the clinic's app reports for that patient. It anchors every calculation. |
| **Plan day** | Days elapsed between the plan start date and today, counted in the `America/Costa_Rica` time zone. |
| **Milestone** | A point in the plan that warrants a message. There are two today: `20` and `42`. |
| **Window** | The 3 calendar days during which a milestone can be sent. It opens and closes on its own. |
| **Key** | Unique identifier of a send. Its existence is the anti-duplicate lock. |
| **Cutoff date** | Age filter: the bot ignores every patient whose plan started before that date. |

---

## 4. Business rules

### 4.1 Who is eligible

A patient enters the daily evaluation only if they meet **all** of the following:

1. Their plan started **on 2026-08-01 or later** (`CUTOFF_DATE = 2026-08-01`).
2. They have a valid plan start date in a recognizable date format.
3. They have a phone number with at least 8 digits after stripping everything that is not a
   digit.
4. They are active according to the role/status filter of the clinic's app.
5. **`MAIN` is among their branches and `SATELLITE` is not.** They may have other branches
   besides `MAIN`; if one of them is `SATELLITE`, they are still excluded (§4.3). See D15.

Anyone who fails 2 or 3, or has no branch at all, **is not dropped silently**: they are counted
and reported in the daily summary so the staff can fix the data. Anyone who has a branch but fails
5 is counted separately, as out by branch: that is a decision, not data to be fixed.

### 4.2 The milestones

| Milestone | Plan days | Template |
|---|---|---|
| `20` | 20, 21, 22 | `followup_20_days_opt1` *(Utility)* / `followup_20_days_opt2` *(Marketing)* — alternating per patient, see §4.6 |
| `42` | 42, 43, 44 | `followup_42_days_opt1` *(Utility)* |

**Milestones are independent.** The bot evaluates each one separately against the plan day.
There is no ordering and no prerequisite: **missing milestone 20 does not block 42.** The bot
keeps no progress history — every day it only asks "how many days into the plan is this patient
today?".

### 4.3 SATELLITE — out for now

The **SATELLITE** group existed, with a single milestone at 40 days (window 40–42) and its own
message-alternation logic. **It was excluded from operation by the operator's decision on
2026-09-02.**

While it is out, patients from that branch **receive no message at all** — neither their own nor
the regular milestones. It is only implemented again when the operator explicitly says so.

> The old design derived the alternation by counting history records, and the periodic cleanup
> reset that count. If SATELLITE comes back, that part gets redesigned; it is not reimplemented
> as it was. The milestone 20 alternation (§4.6) already avoids that mistake.

### 4.4 When a message is sent

- **The message goes out on the first day the patient enters the window.** No spreading and no
  randomness: if today is day 20, they get it today.
- **The 3-day window is a safety net, not a distribution schedule.** It exists so that a Sunday,
  a channel outage or a failed run does not cost the patient the message: they still have day 21
  and day 22.
- **Nothing is sent on Sundays.** A patient whose day 20 falls on a Sunday gets it on Monday
  (day 21).
- **There is no artificial daily cap.** The official channel allows 250 business-initiated
  conversations per 24 h with an unverified business portfolio (1,000 and more once verified),
  far above the real volume of this operation.

**Anomaly brake (`ANOMALY_THRESHOLD = 50`).** If the number of candidates in a run exceeds that
threshold, the bot **aborts without sending anything and raises an alert**.

> **Why abort instead of truncate.** Forty candidates in one day is unusual but legitimate (a
> batch of sign-ups 20 days ago). Three hundred is not: that is a date bug that made everyone
> eligible at once — exactly what nearly happened when the milestones were changed in August. A
> cap that sends the first N and stays quiet hides the bug; a threshold that aborts and shouts
> exposes it. The threshold must sit well above normal volume and well below the channel limit.

### 4.5 The key

```
unique_key = {patient.id}_{planStartDate}_{milestone}
```

**The date in the key is the PLAN START date, never the send date.** That is what keeps the key
identical across the 3 days of the window. If it carried today's date, each day would produce a
different key and the patient would get **three messages**.

Mandatory normalization when building and when comparing it: `planStartDate` as `YYYY-MM-DD`, in
the `America/Costa_Rica` time zone. If the source value does not look like a date, **abort with a
loud error**, do not guess. A format drift in the API (`2026-08-05` →
`2026-08-05T00:00:00.000Z`) would invalidate every key at once.

**The last name is NOT part of the key.** It goes in a separate column of the table, together with
the phone, the milestone and the send date, so alerts and the database can be read without
decoding IDs.

> **Why it is not in the key (decision D7, closed).** A last name is editable. If someone fixes a
> typo in the app — "Perez" → "Pérez" — the key would change, the new one would not find the old
> one, and the patient would get the message again. The patient ID never changes; the name does.

### 4.6 Milestone 20 template alternation

Milestone 20 has two versions of the message. **They alternate per patient, across different
plans:** the first time a patient reaches day 20 they get `opt1`; if they later renew their plan
and reach day 20 again, they get `opt2`; on a third plan, `opt1` again.

How it is decided, in order:

1. Look up that patient's most recent milestone `20` record (by `patient.id`, regardless of the
   plan). If it used `opt1` → `opt2` is next. If it used `opt2`, or there is none → `opt1` is next.
2. **If the patient has opted out of marketing messages and `opt2` was next, they get `opt1`
   instead.** The opt-out is checked before choosing, not after failing: the bot never attempts a
   send it already knows will be rejected.
3. The record stores **which template was actually used**, not which one was due. The next
   alternation reads that value.

> **Why read the template from the record instead of a counter.** The old SATELLITE design derived
> its alternation by counting history records, and the periodic cleanup reset that count: a
> patient who renewed got the same message twice, exactly what the alternation was meant to
> prevent. Reading the template actually used does not have that problem.


---

## 5. Invariants

Rules the system must hold **always**. They are the part that gets checked automatically against
the workflow JSON before every deployment (see [`../validator/`](../validator/)).

### 5.1 Anti-duplicate

| # | Invariant |
|---|---|
| **INV-1** | **Dedup is by key existence, not by status.** A written key blocks a resend forever, whatever status it is in. Changing the status does NOT unblock it; to contact the patient again, the record has to be **deleted** by hand, after a backup.<br>*Why:* a "pending" status mixes "it was not sent" with "it was sent, but recording that failed". Retrying the second case is a duplicate. |
| **INV-2** | **No record, no send.** The key is written *before* the send, and if the write fails the send **does not happen**. There is no path that sends a WhatsApp message without a persisted key.<br>*Why:* a message with no record is invisible — it is not in tomorrow's dedup nor in the alerts. It gets resent on its own, forever. |
| **INV-3** | **The key is claimed in a single atomic operation.** It uses `INSERT … ON CONFLICT (unique_key) DO NOTHING`: if no row comes back, someone else already holds it and **nothing is sent**.<br>*Why:* asking "does it exist?" and then writing leaves a gap between the two operations. Two overlapping runs both ask, both hear "it does not exist", and both send. With `ON CONFLICT` the database guarantees only one wins, and there is no gap to slip through. |
| **INV-4** | **No automatic retry of the send.** The channel's send endpoint does not accept an idempotency key: there is no way to tell it "if you already processed this message, do not repeat it".<br>*Why:* the dangerous failure is not "the send failed", it is "the message went out and the response was lost". An automatic retry there sends the message twice. |
| **INV-5** | **Missing response → ambiguous status → resolved by the webhook, not by a retry.** If the POST returns nothing (timeout, network drop, 502), the record stays `ambiguous`: the bot **does not retry and does not mark it failed**. The status webhook arrives later with the key inside and resolves it (§8).<br>*Why:* at that instant the bot cannot know whether the message went out. Guessing either way breaks something — resending duplicates, marking it failed hides a real delivery. |
| **INV-6** | **Dedup within the same run.** On top of the database uniqueness constraint (INV-3), the bot never emits the same key twice in a single pass.<br>*Why:* the clinic's app can return the same patient twice, and both items would go out before either reached the database. |
| **INV-7** | **The key uses the plan start date, normalized.** Never the send date, never the raw API string. See §4.5. |
| **INV-16** | **The send log is never purged.** There is no age-based cleanup. Rows are kept indefinitely.<br>*Why:* INV-1 says a written key blocks a resend **forever** — and that is only true while the key still exists. The old design deleted records after 65 days, so the lock had an expiry date. On top of that, the milestone 20 alternation (§4.6) breaks if the previous record disappears. Volume does not justify purging: a few thousand rows a year. |
| **INV-17** | **Restoring a database backup leaves the workflow deactivated.** It is not reactivated until the sends have been reconciled against the delivery webhooks and the channel's message log, which do keep the real history of what went out.<br>*Why:* every key written after the snapshot disappears on restore, so those patients look uncontacted again and the bot would resend to them. Restoring is the only event able to delete keys already written — that is, to break INV-1 from outside the system. It is the golden rule's worst case reached through an operational maneuver, not a bug. |

### 5.2 Anti-loss

| # | Invariant |
|---|---|
| **INV-8** | **Precondition gate before creating keys.** The run checks that the channel can send **before** writing the first key. If it cannot, it aborts without writing anything and alerts.<br>*Why:* creating keys and only then discovering you cannot send **burns patients** — they end up marked as handled without having received anything. It happened on 2026-07-29/30 with dozens of keys. |
| **INV-9** | **`delivered` only with real delivery confirmation.** A `2xx` from the API means "I received it for sending", not "the patient received it". The final status is written by the delivery webhook, not by the POST response.<br>*Why:* the July incident was dozens of patients marked as sent because the workflow reached its end, not because the message arrived. |
| **INV-10** | **An empty history read does NOT mean "nobody was contacted".** If the history query returns zero keys, the bot **aborts with an error**.<br>*Why:* a permissions or schema change returns empty without any HTTP error, and the bot would resend to everyone with "success".<br>*How it is implemented today:* the literal "zero keys" check was dropped on 2026-09-07 as a false positive: the lookup only fetches the keys of today's candidates, so zero is the normal result when none of them was contacted before. The invariant is enforced by a watermark instead: Gate B aborts when `bot.sends` has fewer rows than `sends_max_seen`, and the candidate step aborts on zero patients or a truncated read. |
| **INV-11** | **Explicit lineage between nodes, never positional index.** Every value is resolved by following the item it came from, not by its row number.<br>*Why:* asking for "the phone on row 3" only works while nothing drops out. As soon as one patient goes down an error branch, the rows shift and row 3 is now a different person: **Ana's message goes to Beto's phone**. Resolving by lineage fails loudly instead of silently crossing data. |
| **INV-12** | **Visible discards.** A patient skipped for missing data is counted and reported. Never dropped silently. |

### 5.3 Observability

| # | Invariant |
|---|---|
| **INV-13** | **Silence is failure.** Every day produces at least one signal, even when the result is "0 sends, 0 pending, all good". The absence of a signal is read as the system being down, never as "there was nothing to report".<br>*Why:* for 6 days during the incident there were zero alerts because there was nothing to alert about. The silence was the symptom. |
| **INV-14** | **Monitoring does not hang off the send chain.** It always runs, even on days with no sends.<br>*Why:* hung off the end of the sends, Sundays and days without candidates switch off the only alarm. |
| **INV-15** | **No alert can be brought down by its own text.** The content of an alert — keys, error messages from the channel — must never be able to break the sending of that alert. See the correction below: **the mechanism changed, the invariant did not**.<br>*Why:* keys contain underscores, and unbalanced Markdown kills the alert with a 400 exactly when it is needed. |

> 🚩 **Corrected on 2026-09-08: "disabling `parse_mode`" is not an option that exists.**
>
> This invariant used to say *"`parse_mode` disabled in every Telegram node"*. **n8n's Telegram
> node does not offer that option:** `parse_mode` only accepts `Markdown`, `MarkdownV2` or `HTML`,
> and **omitting the field does not disable parsing** — n8n sends a mode anyway. The bot's four
> workflows omitted the field believing that was enough. It was not.
>
> **What exposed it.** While building the delivery webhook, a test with the made-up key
> `THIS_KEY_DOES_NOT_EXIST` made Telegram respond
> `400 - can't parse entities: Can't find end of the entity starting at byte offset 52`. Byte 52
> was the **third underscore**: an odd count, an unclosed italic, a lost alert. It was the exact
> scenario this invariant described — with the defense the invariant itself prescribed in place.
>
> **Why it had never failed before.** Arithmetic luck. Real keys (`123_2026-08-17_20`,
> `45_2026-08-16_20`) have **two** underscores: even, the italic closes, Telegram accepts it. The
> bot's alerts worked because the keys, the way they are built today, happen to have an even
> number of underscores — not because they were protected. All it takes is an `error_message` from
> the channel containing an underscore, or an alert combining two keys, to break the parity.
>
> **What would have happened.** In `Followup | Send To Patient` the alert node sits **before** the
> output node: a Telegram 400 leaves the sub-workflow in error, the orchestrator receives it as a
> failure and **the run stops right there**, leaving the remaining patients without their message.
> No duplicate — the keys already written keep blocking — but a half-finished run **with no alert
> to say so**. That is INV-13 broken the same way it was broken in July: silence.
>
> **The fix.** An **explicit** `parse_mode: HTML`, and escaping `&`, `<` and `>` in the text before
> sending it. That way an underscore becomes an ordinary character, and no content in a key or an
> error message can bring the alert down. It was chosen over the alternatives because it is the
> only one that does not depend on content: escaping Markdown means getting right a list of special
> characters that differs between `Markdown` and `MarkdownV2`, and "be careful how alerts are
> written" is a rule somebody will forget.
>
> **Status.** ✅ **Closed on 2026-09-08.** Applied and verified on the bot's **7 Telegram nodes**:
> `Followup | Delivery Webhook`, `Followup | Send To Patient`, `Followup | Bot` and
> `Followup | Error Manager`. Every new Telegram node is born with the same pattern.

> 🚩 **Added on 2026-09-08: a signal people learn to ignore stops being a signal.**
>
> INV-13 says silence is failure, and from that follows that every day produces a signal. **It is
> missing the other half, discovered at the cost of three false alarms in one afternoon:** an
> alert that keeps going off over something that does not matter **is worse than having none**. It
> teaches people to ignore it, and the day it says something real nobody is looking anymore. It is
> INV-13 in reverse.
>
> **Where it came from.** On 2026-09-08, three hours after the delivery webhook was finished,
> someone replied to a patient from the YCloud inbox. Those messages generate status webhooks
> **without an `externalId`** (§8); the workflow treated them as its own and fired three alerts in
> a row of *"UNKNOWN KEY"*. **Nothing broke** — the database was not touched, no message went
> out — and that is precisely why it matters: it was pure noise, and it would have gone off
> **every time someone answered a patient by hand**.
>
> **What it means as a rule, and it is not optional.** When an alert keeps going off over something
> that requires no action, **the fix is the alert, not the habit of ignoring it** — and it is fixed
> on the spot, not when there is time. The bot can go quiet because of a bug; it can also become
> invisible through excess noise, and the operational outcome is the same as in July.
>
> **Who it binds first:** `Followup | Daily Watch`, whose only product is alerts. It is written
> into that workflow's design as a criterion.

---

## 6. State machine

A record is born when the key is claimed and **never goes backwards**. Every status blocks a
resend equally (INV-1); the status is for humans and alerts, not for deciding sends.

```
                    ┌─────────────┐
                    │   pending   │  key claimed, send not attempted
                    └──────┬──────┘
                           │ POST to the channel
              ┌────────────┼────────────┐
              │            │            │
         response OK   no response   explicit error
              │            │            │
              ▼            ▼            ▼
        ┌──────────┐  ┌───────────┐  ┌──────────┐
        │   sent   │  │ ambiguous │  │  failed  │
        └────┬─────┘  └─────┬─────┘  └──────────┘
             │              │         immediate alert
     delivery webhook       │
             │              └── does a webhook arrive with this key?
     ┌───────┴───────┐           ├─ yes → delivered
     ▼               ▼           └─ no, when the TTL expires → alert a human
┌───────────┐  ┌──────────┐
│ delivered │  │  failed  │
└───────────┘  └──────────┘
```

| Status | Meaning | Written by |
|---|---|---|
| `pending` | Key claimed, send not yet attempted | the bot |
| `sent` | The channel accepted the message. **It is not delivery.** | the bot |
| `ambiguous` | No response. Unknown whether it went out. **Never retried.** | the bot |
| `delivered` | Confirmed by the delivery webhook | the webhook |
| `failed` | Error confirmed by the channel | the bot or the webhook |
| `reviewed` | The operator looked at the case and closed it: it stops appearing in the daily alert. The bot never writes it. | the operator |

---

## 7. Run preconditions (the gate)

Before writing the day's first key, the bot checks **all** of this. If anything fails, it
**aborts the run without writing anything** and alerts (INV-8):

| Check | Stops the run if |
|---|---|
| Number status | it is not connected and operational |
| Number quality | it is red |
| Messaging limit | the allowed cap is below the day's candidates |
| Milestone templates | any of them is not approved |
| Account restrictions | the `account_restricted` flag in `bot.config` is `true`. 🚩 **It is a manual brake: there is no automatic detection** — see the 2026-09-11 note at the end of §7.1 |
| Anomaly brake | candidates exceed `ANOMALY_THRESHOLD` (§4.4) |
| **Sufficient balance** | the day's estimated cost exceeds the available balance (see below) |

### 7.1 Balance check

The provider bills against **its own prepaid credit**, not against the clinic's Meta portfolio.
Zero balance = every send fails = burned keys. That is why it is checked **beforehand**:

```
1. count today's candidates, grouped by template
2. estimated_cost = Σ (candidates × price of that template's category)
3. read the account's available balance
4. if balance < estimated_cost × BALANCE_MARGIN  →  abort, alert, create no key
```

Current prices (a configurable constant, **not hardcoded** — Meta changes them):

| Category | Per message |
|---|---|
| Marketing | $0.0740 |
| Utility | $0.0113 |
| Authentication | $0.0113 |
| Service | free |

Since milestone 20 alternates between a Utility and a Marketing template, its average cost is
~$0.043 per message, against $0.0113 for milestone 42. The calculation must be done per template,
not with a single price.

> 🚩 **Corrected on 2026-09-11: nothing detects an account restriction automatically, and that is
> stated on purpose.**
>
> This paragraph used to say that restrictions and suspensions arrived by webhook, were alerted
> immediately and got recorded for the gate to read. **That was never implemented**, and when it
> came time to implement it, it turned out it could not be done the other way either.
>
> **What was tested, on 2026-09-11.** Before adding anything to `Followup | Bot`, the account was
> queried from `Followup | YCloud Console` with `GET /v2/whatsapp/businessAccounts/{wabaId}`.
> **The response does not include `restrictions` or `banState`**, the fields the gate was going to
> decide on. With a clean account, that absence does not distinguish "no restrictions today" from
> "that field is never returned" — and a guard that stops the run by reading fields that may never
> arrive is a guard that cannot be proven.
>
> **What covers the gap in the meantime, and how far it reaches.** The number-status check of this
> same gate stops on any value other than `CONNECTED`, and YCloud's list of statuses includes
> `RESTRICTED`, `BANNED`, `FLAGGED` and `RATE_LIMITED`. **It is not full coverage:** an account
> restriction may not change the number's status. That is accepted, with two ways out — the
> `account_restricted` flag in `bot.config`, which the operator sets to `true` by hand to stop the
> bot, and the console's `Account` node, which is what gets checked the day Meta actually penalizes
> the account. If the fields show up that day, the decision is revisited with evidence.

---

## 8. Delivery confirmation

The send carries the `unique_key` as its external identifier, and that identifier **comes back
inside the status webhook**. That closes the loop without guessing:

1. The bot sends and leaves the record as `sent` (or `ambiguous` if there was no response).
2. The webhook arrives with the key and the real status → the record moves to `delivered` or
   `failed`.
3. If no webhook has arrived for that key by the time the TTL expires, it is treated as **not
   delivered** and alerted. The bot does not resend.

**This is what resolves the ambiguous case of INV-5.** It is not resolved by asking — the provider
does not let you look up a message by external identifier — but **by waiting**. And since the key
is already written, nobody can resend in the meantime.

**TTL = 12 hours** (43,200 seconds).

> **Why 12 hours.** A short TTL does not speed anything up: it only gets the message discarded
> because the patient's phone was off. A nutritional follow-up is not urgent, so delivery should
> be favored. With sends at 9:00, the verdict is in by 21:00 and makes it into the next morning's
> report.
>
> The opposite matters too: **the default is 30 days**. Without setting it, WhatsApp keeps
> retrying delivery for a month, and a day-20 follow-up can reach the patient on day 50 — when it
> no longer means anything, and with the daily watch alerting the whole time about a message that
> is technically still alive.

> 🚩 **Corrected on 2026-09-05: the TTL is set on the template, not on the send.**
>
> This paragraph used to give `ttlSeconds = 43200` as a field of the send POST. That field
> **exists**, but it only covers `utility` and `authentication` messages sent via *Direct Send*: it
> would leave out `followup_20_days_opt2`, which is **Marketing**, with the 30-day default.
>
> So the TTL is set on each template, in the **`messageSendTtlSeconds`** field, which is the only
> mechanism that covers all three uniformly. The 12 h value does not change; what changes is which
> knob applies it.
>
> **An operational consequence this spec did not anticipate:** changing that field **is editing
> the template**, and every template edit goes through Meta review — it leaves the template in
> `PENDING` and **it cannot be used to send until it is back to `APPROVED`**. That is why it is set
> once, with time to spare, and never the day before a run. If it ever needs changing, warn first:
> it is not a configuration tweak, it is touching an approved asset.

> 🚩 **Added on 2026-09-08: the endpoint receives all of the account's traffic, not just the
> bot's.**
>
> This section took for granted that incoming status webhooks belong to messages the bot sent.
> **That is not the case, and the assumption had never been written down.** The endpoint receives
> events for **any** message on the WhatsApp account — including the ones someone types by hand in
> the YCloud inbox.
>
> **How they are told apart, and the discriminator is exact, not a heuristic:** the bot always
> sends the `unique_key` as the external identifier (`externalId`), because it is the same key it
> already claimed in the database before sending. **A webhook without an `externalId` is not ours
> and is ignored silently**, answering 200. A webhook **with** an `externalId` that is not in the
> log is an anomaly and does alert: it means either that a message went out with a nonexistent
> key, or that someone managed to sign a webhook.
>
> **What it cost to discover:** three false *"UNKNOWN KEY"* alarms on 2026-09-08, after someone
> replied to a patient from the inbox. It is already fixed. The underlying lesson — a noisy alert
> is worse than none — went into §5.3.
>
> **And a corollary that applies to reading any of the bot's reports:** the send log is the full
> record of what **the bot** sent, not of what **the patient** received. A hand-written message
> leaves no row, has no key and does not show up in any report finding. *"We never wrote to this patient"*
> is a reading the log does **not** support.

---

## 9. What the bot NEVER does

1. **Never resends on its own.** Not a failed one, not an ambiguous one, not an old pending one.
2. **Never retries the send at the transport level.**
3. **Never marks delivered without delivery confirmation.**
4. **Never creates keys unless the channel is verified as operational and funded.**
5. **Never reads an empty result as "nobody was contacted".**
6. **Never drops a patient silently.**
7. **Never writes the `reviewed` status** — the operator sets it when closing a case.
8. **Never sends on Sundays.**
9. **Never truncates silently:** on anomalous volume it aborts and alerts; it does not send "the
   first N".

And on the operational side, three rules for humans:

- **Never re-run the whole workflow by hand.** It was the direct cause of the 2026-07-21
  duplicate. If it is needed, first check that the previous run left no ambiguous records.
- **Never bypass a guard to test.** Not the gate, not the lock, not the empty-history guard. A
  test that requires disabling a guard is badly designed.
- **Never test against a patient's phone.** Tests go to the operator's number, with
  `patient_id = 'TEST'`, and through the launcher below. A sent message cannot be taken back.

### 9.1 How a send is tested — added on 2026-09-07

Testing the bot **sends real WhatsApp messages**: no simulation mode is good enough, because the
value of the test is precisely that it walks the real path. That is why the test has its own piece:

**`Followup | Test Send · OPEN 24H WINDOW FIRST`** — manual trigger, no schedule and no webhook. A
message only goes out if the operator opens n8n and clicks.

**It calls the same `Followup | Send To Patient` that production uses**, and that is deliberate: a
separate test sender would prove something other than what actually runs. What differs between
test and production is not who sends, it is **who calls** — the manual launcher, or the daily
orchestrator.

Three properties make it safe, and none of them depends on anyone remembering:

1. **`patient_id` pinned to `TEST`** and the key always prefixed with `TEST_`. Using it against a
   patient requires breaking it by hand; it cannot happen by accident.
2. **A new key on every run**, generated from the time down to the second. It never collides with
   a previous one, so **there is never a need to delete a key from the database to test again** —
   which is exactly the maneuver INV-17 flags as the only one able to break INV-1 from outside.
3. **Manual trigger.** It does not run on its own, does not run at night, and cannot overlap a
   production run.

> **The service window is the human's responsibility, and there is no way to automate it.** Inside
> an open 24 h window, Utility templates **are not billed** — verified on 2026-09-06: with no
> credit loaded in YCloud, the message still arrived. Outside the window they are billed. And
> **neither Meta nor YCloud exposes whether the window is open**, so the workflow cannot check it:
> the operator opens the window by writing to the business number from their own WhatsApp. That is
> why the reminder lives in the workflow's name, which is the one thing that is always seen before
> clicking.
>
> ⚠️ **Meta removes that free tier on 2026-10-01.** From that date on, every test costs money.

---

## 10. What changes from the previous design

| | Before | Now |
|---|---|---|
| Channel | Evolution API (unofficial) | YCloud in coexistence mode (official) |
| Milestones | `18` (18–20) and `45` (45–47) | **`20` (20–22) and `42` (42–44)** |
| SATELLITE | its own milestone `40` with alternation | **excluded** |
| Cutoff date | 2026-08-03 | **2026-08-01** |
| Send log | Airtable | **Postgres**, with real uniqueness |
| Confirmation | `key.id` in the HTTP response | **delivery webhook**, 12 h TTL |
| Spreading within the window | random `1/(days left)` | **removed** — goes out on the first day |
| Daily cap | fixed at 10, truncated silently | **anomaly brake at 50, aborts and alerts** |
| Retention | cleanup after 65 days | **never purged** (INV-16) |
| Health gate | Evolution instance status | status, quality, limit, templates, restrictions and **balance** |

**Recorded consequence:** patients who started their plan between 2026-08-01 and 2026-08-10
**will not receive the milestone 20 message** — that window expired while the workflow was off.
All of them still have milestone 42 ahead, so none is left without contact. It is an accepted
loss, not a bug.

---

## 11. Decisions

| # | Decision | Status |
|---|---|---|
| **D7** | The last name goes in a separate column, not in the key. | ✅ **Closed** 2026-09-02 — §4.5 |
| **D8** | `followup_20_days_opt2` stays Marketing **on purpose**. Its consequences are accepted: 6.5× the cost, the obligation to honor opt-outs, and Meta's frequency caps. The operator flags it if that changes. | ✅ **Closed** 2026-09-02 |
| **D9** | Daily cap replaced by an anomaly brake at 50. | ✅ **Closed** 2026-09-02 — §4.4 |
| **D10** | Confirmation TTL = 12 h. | ✅ **Closed** 2026-09-02 — §8 |
| **D11** | The milestone 20 `opt1`/`opt2` alternation is **per patient, across plans**, and is derived from the template their previous record used. It implies the send log is never purged (INV-16). | ✅ **Closed** 2026-09-02 — §4.6 |
| **D12** | The marketing opt-out is checked **before** choosing the template. If the patient has opted out and `opt2` was due, they get `opt1`. | ✅ **Closed** 2026-09-02 — §4.6 |
| **D13** | The send log lives in **Supabase**, on the **Free** plan, in a US region, **not** on the server hosting n8n. n8n connects through the **pooler in Session mode**, not the direct connection. Backups are done by a **separate n8n workflow** that dumps the table to **S3-compatible object storage** once a day and alerts if it fails (INV-13). 🚩 *It said "to Google Drive" until 2026-09-10 — see the correction below.*<br>*Why Supabase and not self-hosting:* the data stays isolated from the machine running n8n — if the VPS dies, the database does not go with it. Per INV-16 and INV-17 this database is the most critical asset in the system: the workflow can be rebuilt from this spec, the database cannot.<br>*Why the backup is our own and not Supabase's:* the Free plan **includes no backups** — zero days of retention, and the backup system simply does not run on Free. Daily backups and point-in-time restore are Pro features ($25/month per project). If volume grows or our own backup turns out to be fragile, moving to Pro solves it out of the box.<br>*Watch out for the Free plan:* the project **is paused after 7 days without activity**. While the bot is deactivated, plan on unpausing it when reactivating.<br>*Data note:* the table holds last names and phone numbers of patients of a nutrition service, hosted in the US. | ✅ **Closed** 2026-09-03 |
| **D14** | **The operator is the system's only human operator.** All alerts go to them and only they close cases; the nutritionist does not touch the database, does not mark records and does not act on alerts. This is intentional.<br>*Accepted consequence:* there is no escalation. If the operator is unavailable, a `failed` or `ambiguous` case stays unresolved until they are back. The wait is safe — the bot does not resend on its own — so what is lost is a contact opportunity, never a duplicate. | ✅ **Closed** 2026-09-02 |
| **D15** | **Only patients of the `MAIN` branch get messages.** With no branch, they are skipped and reported. With several branches, they are in if one is `MAIN`, unless another one is `SATELLITE`, which always excludes. If no active patient has `MAIN`, the run aborts with an error.<br>*Why the guard:* a misspelled value leaves everyone out, and the bot sends zero messages every day without a single error. It is INV-10 by another route.<br>*Measured on 2026-09-14:* each patient carries a single branch — `MAIN`, `SATELLITE` or a third branch — so in practice the new filter leaves out that third branch. | ✅ **Closed** 2026-09-14 — §4.1 |

> 🚩 **Corrected on 2026-09-10: the backup goes to object storage, not Google Drive.**
>
> D13 said "dumps the table to Google Drive". **The destination changes; nothing else in the
> decision does** — it is still a separate n8n workflow, daily, alerting on failure, off the server
> where n8n runs, and for the same reasons.
>
> **Why it changed, and it was not a matter of preference.** Google Drive turned out to be the
> expensive path for a reason that has nothing to do with backups: **OAuth bureaucracy**. For a
> self-hosted n8n to write to Drive you need a Google Cloud project, a consent screen, and to
> **publish the app**. And publishing requires three public web pages — home page, privacy policy
> and terms of service — hosted on an authorized domain. For a backup only the operator uses.
>
> **And with a trap that really was serious.** While the app is in *"Testing"* status, Google
> **expires the refresh token after 7 days**. The backup would stop running **without any error**:
> it would not fail, there would simply be no new files. Silence, which is the symptom this system
> treats as the worst of all (INV-13).
>
> **On top of that, n8n requests `auth/drive`** — full access to the Drive — which Google
> classifies as a *restricted scope*: the category that normally drags in a verification process.
> So it was not even clear that writing the three pages would be enough.
>
> **What the change gains, besides avoiding all of that:**
>
> | | Drive | Objects (S3) |
> |---|---|---|
> | Access scope | **The whole Drive** of the account | **A single bucket** |
> | Credential | OAuth token that can expire | Access key that does not expire |
> | Paperwork | Consent, publishing, possible verification | None |
>
> Access becomes **narrower**, not wider: a key that can only write to one bucket, instead of a
> token with permission over the account's entire Drive.
>
> **What does NOT change:** the account still belongs to the client — it is created with the same
> dedicated email — it is still revocable, and it still stays with them on handover day. That was
> the underlying point and it remains intact.
>
> **What is lost:** browsing the backups in a familiar interface. An object storage dashboard is
> not Drive. That was accepted: a backup is not browsed, it is restored — and the restore is
> tested, which is the verification that actually matters.

---

## 12. Out of scope for this spec

- The shape of the n8n graph (nodes, wiring, expressions). That belongs in a separate
  implementation spec; the exported graphs are in [`../workflows/`](../workflows/).
- The exact Postgres table schema (see [`../db/schema.sql`](../db/schema.sql)).
- The text of the templates.
- The operational runbook (what a human does for each alert) — rewritten after this is approved.
  Handy operator queries are in [`../db/operations.sql`](../db/operations.sql).
