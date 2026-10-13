import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { IDS } from './inventory.mjs';
import { evaluate, readFolder } from './validate.mjs';

const BASE = fileURLToPath(new URL('./cases/base/', import.meta.url));

function clone(value) {
  return structuredClone(value);
}

function workflow(workflows, id) {
  return workflows.find((item) => item.id === id);
}

function node(workflows, id, name) {
  return workflow(workflows, id).nodes.find((item) => item.name === name);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const cases = [
  {
    name: 'inventory',
    slug: 'inventory',
    mutate(items) {
      workflow(items, IDS.YCLOUD_CONSOLE).name = 'Followup | Unknown Console';
    },
    workflow: 'Followup | Unknown Console',
    node: 'inventory',
  },
  {
    name: 'send with retry',
    slug: 'send-without-retry',
    mutate(items) {
      node(items, IDS.SENDER, 'Send').retryOnFail = true;
    },
    workflow: 'Followup | Send To Patient',
    node: 'Send',
  },
  {
    name: 'shortcut without key',
    slug: 'key-before-send',
    mutate(items) {
      workflow(items, IDS.SENDER).connections.Input.main[0].push({
        node: 'Send',
        type: 'main',
        index: 0,
      });
    },
    workflow: 'Followup | Send To Patient',
    node: 'Claim Key',
  },
  {
    name: 'gate B disabled',
    slug: 'gates-before-sender',
    mutate(items) {
      node(items, IDS.ORCHESTRATOR, 'OK To Send Today?').disabled = true;
    },
    workflow: 'Followup | Bot',
    node: 'OK To Send Today?',
  },
  {
    name: 'Telegram without HTML',
    slug: 'telegram-html',
    mutate(items) {
      delete node(items, IDS.ERROR_MANAGER, 'Notify').parameters.additionalFields.parse_mode;
    },
    workflow: 'Followup | Error Manager',
    node: 'Notify',
  },
  {
    name: 'destructive SQL',
    slug: 'no-deletes',
    mutate(items) {
      node(items, IDS.SENDER, 'Claim Key').parameters.query = 'delete from bot.sends';
    },
    workflow: 'Followup | Send To Patient',
    node: 'Claim Key',
  },
  {
    name: 'loose error output',
    slug: 'error-output-wired',
    mutate(items) {
      workflow(items, IDS.SENDER).connections.Send.main[1] = [];
    },
    workflow: 'Followup | Send To Patient',
    node: 'Send',
  },
  {
    name: 'comma-separated SQL parameters',
    slug: 'sql-params-array',
    mutate(items) {
      node(items, IDS.SENDER, 'Claim Key').parameters.options.queryReplacement =
        '={{ $json.unique_key }}, {{ $json.phone }}';
    },
    workflow: 'Followup | Send To Patient',
    node: 'Claim Key',
  },
  {
    name: 'Error Workflow missing',
    slug: 'error-workflow-assigned',
    mutate(items) {
      delete workflow(items, IDS.ORCHESTRATOR).settings.errorWorkflow;
    },
    workflow: 'Followup | Bot',
    node: 'settings.errorWorkflow',
  },
  {
    name: 'successful executions saved',
    slug: 'executions-without-data',
    mutate(items) {
      workflow(items, IDS.BACKUP).settings.saveDataSuccessExecution = 'all';
    },
    workflow: 'Followup | Backup',
    node: 'settings.saveDataSuccessExecution',
  },
  {
    name: 'Schedule without timezone',
    slug: 'timezone',
    mutate(items) {
      delete workflow(items, IDS.DAILY_WATCH).settings.timezone;
    },
    workflow: 'Followup | Daily Watch',
    node: 'Daily 11:30',
  },
];

async function main() {
  const base = await readFolder(BASE);
  const baseResult = evaluate(base, 'from cases/base');
  expect(baseResult.code === 0, `V1: the base did not pass:\n${baseResult.lines.join('\n')}`);
  console.log('✓ V1 · fabricated base passes');

  for (const item of cases) {
    const items = clone(base);
    item.mutate(items);
    const result = evaluate(items, `mutation ${item.name}`);
    const text = result.lines.join('\n');
    expect(result.code === 1, `${item.name}: expected code 1, got ${result.code}`);
    expect(text.includes(item.slug), `${item.name}: did not name ${item.slug}`);
    expect(text.includes(item.workflow), `${item.name}: did not name ${item.workflow}`);
    expect(text.includes(`› ${item.node} —`), `${item.name}: did not name ${item.node}`);
    console.log(`✓ V2 · ${item.slug}`);
  }

  const comment = clone(base);
  node(comment, IDS.SENDER, 'Claim Key').parameters.query +=
    '\n-- never delete or drop here\n/* truncate is only a comment too */';
  const commentResult = evaluate(comment, 'SQL false positive');
  expect(commentResult.code === 0, 'an SQL comment triggered no-deletes');

  const intentionalFailure = clone(base);
  const dailyWatch = workflow(intentionalFailure, IDS.DAILY_WATCH);
  dailyWatch.nodes.push({
    id: 'fake-stop-error',
    name: 'Fail On Purpose',
    type: 'n8n-nodes-base.stopAndError',
    parameters: { errorMessage: 'fabricated test' },
    disabled: false,
  });
  dailyWatch.connections['Daily 11:30'].main[0].push({
    node: 'Fail On Purpose',
    type: 'main',
    index: 0,
  });
  const failureResult = evaluate(intentionalFailure, 'intentional error false positive');
  expect(failureResult.code === 0, 'an intentional failure without a declared output was flagged');
  console.log('✓ V2 · known false positives pass');

  const empty = await mkdtemp(path.join(os.tmpdir(), 'followup-validator-empty-'));
  try {
    const emptyResult = evaluate(await readFolder(empty), `from ${empty}`);
    expect(emptyResult.code === 2, `V3: empty folder exited with ${emptyResult.code}`);
    expect(emptyResult.lines.at(-1).includes('COULD NOT VERIFY'), 'V3: RESULT line missing');
  } finally {
    await rm(empty, { recursive: true });
  }
  console.log('✓ V3 · an empty folder is not mistaken for a pass');
  console.log(`RESULT: PASS · ${cases.length} mutations · 2 false positives · 0 failures`);
}

try {
  await main();
} catch (error) {
  console.error(`RESULT: FAIL · ${error.message}`);
  process.exitCode = 1;
}
