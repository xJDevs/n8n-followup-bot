-- ═══════════════════════════════════════════════════════════════════════════
-- Followup bot · Operational queries
--
-- Run them from the `Followup | SQL Console` workflow in n8n.
-- That workflow uses the `n8n_bot` credential, which does NOT have DELETE
-- permission: nothing can be broken from there by accident. Deleting requires
-- logging into the Supabase panel as `postgres`, which is deliberate and leaves a trace.
--
-- Every table lives in the `bot` schema, not in `public`. Always qualify
-- them: `bot.sends`, never plain `sends`.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- ERRORS
-- ───────────────────────────────────────────────────────────────────────────

-- Latest recorded errors
select id, workflow, node, message, notified, occurred_at
from bot.errors
order by id desc
limit 20;

-- Errors that could NOT be notified.
-- `notified = false` means the error was stored but the alert did not
-- go out — typically Telegram being down. This is what the daily heartbeat picks up.
select id, workflow, node, message, occurred_at
from bot.errors
where not notified
order by occurred_at desc;

-- How many times each thing failed, last 30 days
select workflow, node, count(*) as times
from bot.errors
where occurred_at > now() - interval '30 days'
group by workflow, node
order by times desc;


-- ───────────────────────────────────────────────────────────────────────────
-- SENDS
-- ───────────────────────────────────────────────────────────────────────────

-- The ones that need human eyes.
-- `ambiguous` = the POST got no response and nobody knows whether the message went out.
-- NEVER resend one of these without checking in WhatsApp (INV-5, golden rule).
select unique_key, last_name, phone, milestone, template, status, created_at
from bot.sends
where status in ('pending', 'ambiguous', 'failed')
order by created_at desc;

-- Sent without a delivery confirmation after the 12 h TTL.
-- They are treated as NOT delivered. They are not resent either.
select unique_key, last_name, milestone, sent_at
from bot.sends
where status = 'sent'
  and sent_at < now() - interval '12 hours'
order by sent_at;

-- Everything from today
select unique_key, last_name, milestone, template, status, created_at
from bot.sends
where created_at::date = current_date
order by created_at desc;

-- Full history of one patient
select unique_key, milestone, template, status, created_at, sent_at, closed_at
from bot.sends
where patient_id = 'PUT_ID_HERE'
order by created_at desc;

-- Which template the patient's next milestone 20 would get (spec §4.6).
-- Returns the last one used: if it was opt1, opt2 is due, and vice versa.
select template, created_at
from bot.sends
where patient_id = 'PUT_ID_HERE' and milestone = '20'
order by created_at desc
limit 1;

-- Summary by status
select status, count(*) as how_many
from bot.sends
group by status
order by how_many desc;


-- ───────────────────────────────────────────────────────────────────────────
-- SYSTEM HEALTH
-- ───────────────────────────────────────────────────────────────────────────

-- The watermark of the empty-table guard.
-- If the `count(*)` of sends drops BELOW this number, the gate aborts the
-- run: it means the table shrank, and that only happens through a
-- backup restore or a manual delete (INV-10, INV-17).
select
  (select value::bigint from bot.config where name = 'sends_max_seen') as watermark,
  (select count(*) from bot.sends)                                      as rows_now;

-- Which role n8n is connecting as.
-- It must say `n8n_bot`. If it says `postgres`, the credential was left with the
-- default user and the least-privilege protection does not exist.
select current_user, session_user;

-- Who has privileges on the `bot` schema.
-- Only `postgres` and `n8n_bot` should show up. If `anon` or
-- `authenticated` appears, the table is reachable from the internet.
select grantee, table_name, privilege_type
from information_schema.table_privileges
where table_schema = 'bot'
order by grantee, table_name;


-- ───────────────────────────────────────────────────────────────────────────
-- DANGEROUS OPERATIONS — only from the Supabase panel, as `postgres`
-- ───────────────────────────────────────────────────────────────────────────

-- Delete a key so a patient can be contacted again.
-- ⚠️ This UNLOCKS a resend. It is the only operation able to break the
-- golden rule from outside the system. Before: back up the row, and afterwards
-- lower the watermark or the gate will abort the next run.
--
--   select * from bot.sends where unique_key = 'KEY';   -- back this up
--   delete from bot.sends where unique_key = 'KEY';
--   update bot.config
--      set value = (select count(*)::text from bot.sends)
--    where name = 'sends_max_seen';
