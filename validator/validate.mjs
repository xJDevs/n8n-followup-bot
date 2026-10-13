import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import process from 'node:process';

import { runRules, SLUGS } from './rules.mjs';

const API_URL = 'https://n8n.example.com';

export function evaluate(workflows, source) {
  const relevant = workflows.filter(
    (workflow) => workflow?.isArchived !== true && workflow?.name?.startsWith('Followup |'),
  );
  if (relevant.length === 0) {
    return {
      code: 2,
      lines: [`RESULT: COULD NOT VERIFY · ${source} contains no Followup | workflows`],
      violations: [],
    };
  }

  const violations = runRules(workflows);
  const lines = violations.map(
    (item) =>
      `✗ ${item.invariant} · ${item.slug} · ${item.workflow} › ${item.node} — ${item.message}`,
  );
  const status = violations.length === 0 ? 'PASS' : 'FAIL';
  lines.push(
    `RESULT: ${status} · ${source} · ${relevant.length} workflows · ${SLUGS.length} checks · ${violations.length} violations`,
  );
  return { code: violations.length === 0 ? 0 : 1, lines, violations };
}

function readKeychain() {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-a', process.env.USER, '-s', 'n8n-api-key', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    throw new Error('could not read n8n-api-key from the Keychain (see validator/README.md)');
  }
}

async function fetchJson(url, key) {
  let response;
  try {
    response = await fetch(url, { headers: { 'X-N8N-API-KEY': key } });
  } catch (error) {
    throw new Error(`the API did not respond: ${error.message}`);
  }
  if (response.status === 401) {
    throw new Error('the API returned 401 — check the key (see validator/README.md)');
  }
  if (!response.ok) {
    throw new Error(`the API returned HTTP ${response.status}`);
  }
  return response.json();
}

async function readInstance() {
  const key = readKeychain();
  const list = [];
  let cursor;
  do {
    const url = new URL('/api/v1/workflows', API_URL);
    url.searchParams.set('limit', '100');
    url.searchParams.set('excludePinnedData', 'true');
    if (cursor) url.searchParams.set('cursor', cursor);
    const page = await fetchJson(url, key);
    list.push(...(page.data ?? []));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const relevant = list.filter(
    (workflow) => workflow?.isArchived !== true && workflow?.name?.startsWith('Followup |'),
  );
  if (relevant.length === 0) return [];
  return Promise.all(
    relevant.map((workflow) =>
      fetchJson(new URL(`/api/v1/workflows/${encodeURIComponent(workflow.id)}`, API_URL), key),
    ),
  );
}

async function jsonFiles(folder) {
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(absolute);
    }
  }
  await walk(folder);
  return found.sort();
}

export async function readFolder(folder) {
  const workflows = [];
  for (const file of await jsonFiles(folder)) {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    if (Array.isArray(parsed)) workflows.push(...parsed);
    else if (Array.isArray(parsed.data)) workflows.push(...parsed.data);
    else workflows.push(parsed);
  }
  return workflows;
}

function parseArgs(argv) {
  if (argv.length === 0) return { mode: 'instance' };
  if (argv.length === 2 && argv[0] === '--from' && argv[1]) {
    return { mode: 'folder', folder: path.resolve(argv[1]) };
  }
  throw new Error('usage: node validator/validate.mjs [--from <folder>]');
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArgs(argv);
    const workflows =
      args.mode === 'instance' ? await readInstance() : await readFolder(args.folder);
    const source = args.mode === 'instance' ? 'instance' : `from ${args.folder}`;
    const result = evaluate(workflows, source);
    for (const line of result.lines) console.log(line);
    return result.code;
  } catch (error) {
    console.log(`RESULT: COULD NOT VERIFY · ${error.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
