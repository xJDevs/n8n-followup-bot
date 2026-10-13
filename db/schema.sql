-- ═══════════════════════════════════════════════════════════════════════════
-- Followup bot · Database schema (PostgreSQL / Supabase)
--
-- Run once, from the Supabase SQL editor, as `postgres`.
-- Everything lives in its own `bot` schema, outside the reach of the
-- Supabase REST API (which only exposes `public`).
--
-- Replace <CHANGE_ME_LONG_RANDOM_PASSWORD> before running.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create schema if not exists bot;


-- ── The lock table ──────────────────────────────────────────────────────────
-- One row per message. The existence of the key blocks a resend forever (INV-1).
-- It is NEVER purged (INV-16).
create table bot.sends (
  unique_key    text primary key,          -- {patient_id}_{plan_start_date}_{milestone}
  patient_id    text not null,
  last_name     text,                      -- readability only. NOT part of the key
  phone         text not null,             -- E.164
  milestone     text not null check (milestone in ('20','42')),
  template      text not null,             -- the template ACTUALLY used (spec §4.6)
  status        text not null default 'pending'
                check (status in ('pending','sent','ambiguous','delivered','failed','reviewed')),
  wamid         text,                      -- WhatsApp message id
  ycloud_id     text,                      -- YCloud's own message id (GET /v2/whatsapp/messages/{id})
  error_code    text,
  error_message text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz,
  closed_at     timestamptz
);

comment on table  bot.sends is
  'One row per message. The existence of the key blocks a resend forever (INV-1). NEVER PURGED (INV-16).';
comment on column bot.sends.unique_key is
  'Primary key = the anti-duplicate lock. The date is the PLAN START date, never the send date.';
comment on column bot.sends.ycloud_id is
  'YCloud message id, written by the sender and by the delivery webhook (coalesce). Lets a send be looked up in the YCloud API.';
comment on column bot.sends.status is
  'pending -> sent | failed | ambiguous (sender); pending/sent/ambiguous -> delivered | failed (delivery webhook; only it writes delivered, INV-9); reviewed is set by hand by the operator.';

-- Serves the milestone-20 template alternation query (spec §4.6)
create index sends_alternation on bot.sends (patient_id, milestone, created_at desc);


-- ── The bot's own state ─────────────────────────────────────────────────────
create table bot.config (
  name  text primary key,
  value text not null
);

comment on table bot.config is
  'Internal state of the bot. sends_max_seen is the watermark of the table-health guard (INV-10, INV-17).';

insert into bot.config (name, value) values
  ('sends_max_seen',     '0'),        -- watermark: highest row count ever seen in bot.sends
  ('price_marketing',    '0.0740'),   -- USD per Marketing template message
  ('price_utility',      '0.0113'),   -- USD per Utility template message
  ('anomaly_threshold',  '50'),       -- more candidates than this in one day aborts the run
  ('balance_margin',     '2.0'),      -- the balance must cover estimated cost x this margin
  ('account_restricted', 'false')     -- 'true' = Gate A aborts every run (manual brake)
on conflict (name) do nothing;

-- Written by hand, from this SQL editor, so the secret never sits in a workflow JSON:
--   insert into bot.config (name, value) values ('ycloud_webhook_secret', '<the endpoint secret from YCloud>');
--
-- Written by `Followup | Backup` after every successful upload (no seed needed):
--   last_backup = '<ISO 8601> | <row count> | <object key>'


-- ── Durable error trail ─────────────────────────────────────────────────────
create table bot.errors (
  id           bigserial primary key,
  workflow     text,
  execution_id text,
  node         text,
  message      text,
  occurred_at  timestamptz not null default now(),
  notified     boolean     not null default false
);

comment on table bot.errors is
  'Durable trail of failures. Written BEFORE trying to notify, so a Telegram outage does not mean silence (INV-13).';
comment on column bot.errors.notified is
  'false = the alert did not go out. The daily watch picks these rows up.';

create index errors_unnotified on bot.errors (occurred_at desc) where not notified;


-- ── n8n role with least privilege ───────────────────────────────────────────
create role n8n_bot with login password '<CHANGE_ME_LONG_RANDOM_PASSWORD>';

grant usage on schema bot to n8n_bot;
grant select, insert, update on bot.sends  to n8n_bot;
grant select, insert, update on bot.config to n8n_bot;
grant select, insert, update on bot.errors to n8n_bot;
grant usage, select on sequence bot.errors_id_seq to n8n_bot;
-- No DELETE anywhere: INV-16 is enforced by the database, not by memory.

commit;
