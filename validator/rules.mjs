import { IDS, INVENTORY, INVENTORY_BY_ID } from './inventory.mjs';

export const SLUGS = Object.freeze([
  'inventory',
  'send-without-retry',
  'key-before-send',
  'gates-before-sender',
  'telegram-html',
  'no-deletes',
  'error-output-wired',
  'sql-params-array',
  'error-workflow-assigned',
  'executions-without-data',
  'timezone',
]);

const INV = Object.freeze({
  inventory: 'INVENTORY',
  'send-without-retry': 'INV-4',
  'key-before-send': 'INV-2',
  'gates-before-sender': 'INV-8',
  'telegram-html': 'INV-15',
  'no-deletes': 'INV-16',
  'error-output-wired': 'INV-13',
  'sql-params-array': 'INV-13',
  'error-workflow-assigned': 'INV-13',
  'executions-without-data': 'INV-13',
  timezone: 'INV-8',
});

function violation(slug, workflow, node, message) {
  return {
    slug,
    invariant: INV[slug],
    workflow: workflow?.name ?? workflow ?? '(unknown workflow)',
    node: node?.name ?? node ?? '(no node)',
    message,
  };
}

function findNode(workflow, name) {
  return workflow?.nodes?.find((item) => item.name === name);
}

function connections(workflow) {
  const edges = [];
  for (const [from, groups] of Object.entries(workflow?.connections ?? {})) {
    for (const [type, outputs] of Object.entries(groups ?? {})) {
      for (let output = 0; output < (outputs?.length ?? 0); output += 1) {
        for (const target of outputs[output] ?? []) {
          edges.push({ from, to: target.node, type, output, input: target.index ?? 0 });
        }
      }
    }
  }
  return edges;
}

function mainGraph(workflow) {
  const names = new Set((workflow?.nodes ?? []).map((item) => item.name));
  const edges = connections(workflow).filter(
    (edge) => edge.type === 'main' && names.has(edge.from) && names.has(edge.to),
  );
  const withInput = new Set(edges.map((edge) => edge.to));
  const roots = [...names].filter((name) => !withInput.has(name));
  return { names, edges, roots };
}

function reachable(graph, starts, target, { skipNodes = new Set(), allowEdge } = {}) {
  const queue = starts.filter((start) => !skipNodes.has(start));
  const seen = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current) || skipNodes.has(current)) continue;
    seen.add(current);
    if (current === target) return true;
    for (const edge of graph.edges) {
      if (edge.from !== current || skipNodes.has(edge.to)) continue;
      if (allowEdge && !allowEdge(edge)) continue;
      queue.push(edge.to);
    }
  }
  return false;
}

function outputTargets(graph, name, output) {
  return graph.edges
    .filter((edge) => edge.from === name && edge.output === output)
    .map((edge) => edge.to);
}

function checkPath(workflow, targetName, guards) {
  const slug = guards.slug;
  const out = [];
  const target = findNode(workflow, targetName);
  if (!target) {
    return [violation(slug, workflow, targetName, `target ${targetName} not found`)];
  }

  const graph = mainGraph(workflow);
  const roots = graph.roots.filter((name) => name !== targetName);
  if (!reachable(graph, roots, targetName)) {
    out.push(
      violation(
        slug,
        workflow,
        target,
        'the target is not reachable from any entry point in the intact graph',
      ),
    );
  }

  for (const guardDef of guards.items) {
    const guard = findNode(workflow, guardDef.name);
    if (!guard) {
      out.push(
        violation(
          slug,
          workflow,
          guardDef.name,
          `guard ${guardDef.name} not found; was it renamed?`,
        ),
      );
      continue;
    }
    if (guard.disabled === true) {
      out.push(violation(slug, workflow, guard, 'the guard is disabled'));
    }
    if (reachable(graph, roots, targetName, { skipNodes: new Set([guard.name]) })) {
      out.push(violation(slug, workflow, guard, `there is a path to ${targetName} that bypasses it`));
    }
    if (guardDef.trueOutput) {
      const trueTargets = outputTargets(graph, guard.name, 0);
      if (!reachable(graph, trueTargets, targetName)) {
        out.push(
          violation(slug, workflow, guard, `the true output does not reach ${targetName}`),
        );
      }
      const otherOutputs = [...new Set(
        graph.edges
          .filter((edge) => edge.from === guard.name && edge.output !== 0)
          .map((edge) => edge.output),
      )];
      for (const output of otherOutputs) {
        if (reachable(graph, outputTargets(graph, guard.name, output), targetName)) {
          out.push(
            violation(
              slug,
              workflow,
              guard,
              `output ${output} also reaches ${targetName}; only the true output may do so`,
            ),
          );
        }
      }
    }
  }
  return out;
}

function selectorValue(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.value === 'string') return value.value;
  return undefined;
}

function ruleInventory(workflows) {
  const out = [];
  const relevant = workflows.filter(
    (workflow) => workflow?.isArchived !== true && workflow?.name?.startsWith('Followup |'),
  );
  const byId = new Map(relevant.map((workflow) => [workflow.id, workflow]));

  for (const workflow of relevant) {
    const expected = INVENTORY_BY_ID.get(workflow.id);
    if (!expected) {
      out.push(
        violation('inventory', workflow, 'inventory', 'unknown Followup workflow; it has to be classified'),
      );
    } else if (workflow.name !== expected.name) {
      out.push(
        violation(
          'inventory',
          workflow,
          'inventory',
          `the id belongs to ${expected.name}, but today it is called ${workflow.name}`,
        ),
      );
    }
  }

  for (const expected of INVENTORY) {
    if (!byId.has(expected.id)) {
      out.push(
        violation(
          'inventory',
          expected.name,
          'inventory',
          `id ${expected.id} is missing (${expected.role})`,
        ),
      );
    }
  }
  return out;
}

function ruleSendWithoutRetry(workflows) {
  const workflow = workflows.find((item) => item.id === IDS.SENDER);
  if (!workflow) return [];
  const send = findNode(workflow, 'Send');
  if (!send) {
    return [violation('send-without-retry', workflow, 'Send', 'node Send not found')];
  }
  if (!Object.hasOwn(send, 'retryOnFail') || send.retryOnFail !== false) {
    return [
      violation(
        'send-without-retry',
        workflow,
        send,
        'retryOnFail is not an explicit false',
      ),
    ];
  }
  return [];
}

function ruleKeyBeforeSend(workflows) {
  const workflow = workflows.find((item) => item.id === IDS.SENDER);
  if (!workflow) return [];
  return checkPath(workflow, 'Send', {
    slug: 'key-before-send',
    items: [
      { name: 'Claim Key' },
      { name: 'Claimed?', trueOutput: true },
    ],
  });
}

function ruleGatesBeforeSender(workflows) {
  const workflow = workflows.find((item) => item.id === IDS.ORCHESTRATOR);
  if (!workflow) return [];
  const targets = (workflow.nodes ?? []).filter(
    (item) =>
      item.type === 'n8n-nodes-base.executeWorkflow' &&
      selectorValue(item.parameters?.workflowId) === IDS.SENDER,
  );
  if (targets.length === 0) {
    return [
      violation(
        'gates-before-sender',
        workflow,
        'executeWorkflow',
        'no call to the sender by its id was found',
      ),
    ];
  }
  return targets.flatMap((target) =>
    checkPath(workflow, target.name, {
      slug: 'gates-before-sender',
      items: [
        { name: 'Channel Healthy?', trueOutput: true },
        { name: 'OK To Send Today?', trueOutput: true },
      ],
    }),
  );
}

function ruleTelegramHtml(workflows) {
  const out = [];
  for (const workflow of workflows) {
    for (const item of workflow.nodes ?? []) {
      if (item.type !== 'n8n-nodes-base.telegram') continue;
      const operation = item.parameters?.operation ?? 'sendMessage';
      if (operation !== 'sendMessage') {
        out.push(
          violation(
            'telegram-html',
            workflow,
            item,
            `unexpected Telegram operation: ${String(operation)}`,
          ),
        );
      } else if (item.parameters?.additionalFields?.parse_mode !== 'HTML') {
        out.push(
          violation(
            'telegram-html',
            workflow,
            item,
            'parameters.additionalFields.parse_mode is not an explicit HTML',
          ),
        );
      }
    }
  }
  return out;
}

function withoutCommentsOrLiterals(sql) {
  let out = '';
  let i = 0;
  let state = 'normal';
  while (i < sql.length) {
    const pair = sql.slice(i, i + 2);
    const char = sql[i];
    if (state === 'normal' && pair === '--') {
      state = 'line-comment';
      out += '  ';
      i += 2;
    } else if (state === 'normal' && pair === '/*') {
      state = 'block-comment';
      out += '  ';
      i += 2;
    } else if (state === 'line-comment' && char === '\n') {
      state = 'normal';
      out += '\n';
      i += 1;
    } else if (state === 'block-comment' && pair === '*/') {
      state = 'normal';
      out += '  ';
      i += 2;
    } else if (state === 'normal' && char === "'") {
      state = 'single-literal';
      out += ' ';
      i += 1;
    } else if (state === 'single-literal' && char === "'" && sql[i + 1] === "'") {
      out += '  ';
      i += 2;
    } else if (state === 'single-literal' && char === "'") {
      state = 'normal';
      out += ' ';
      i += 1;
    } else if (state === 'normal' && char === '"') {
      state = 'identifier';
      out += ' ';
      i += 1;
    } else if (state === 'identifier' && char === '"' && sql[i + 1] === '"') {
      out += '  ';
      i += 2;
    } else if (state === 'identifier' && char === '"') {
      state = 'normal';
      out += ' ';
      i += 1;
    } else {
      out += state === 'normal' ? char : ' ';
      i += 1;
    }
  }
  return out;
}

function valuesOfKey(value, wanted, found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (key === wanted) found.push(child);
    valuesOfKey(child, wanted, found);
  }
  return found;
}

function ruleNoDeletes(workflows) {
  const out = [];
  for (const workflow of workflows) {
    for (const item of workflow.nodes ?? []) {
      const operations = valuesOfKey(item.parameters, 'operation');
      if (operations.some((value) => typeof value === 'string' && /delete/i.test(value))) {
        out.push(violation('no-deletes', workflow, item, 'the operation contains delete'));
      }
      if (item.type === 'n8n-nodes-base.httpRequest') {
        const method = item.parameters?.method ?? item.parameters?.requestMethod;
        if (typeof method === 'string' && method.toUpperCase() === 'DELETE') {
          out.push(violation('no-deletes', workflow, item, 'the HTTP method is DELETE'));
        }
      }
      if (item.type === 'n8n-nodes-base.postgres') {
        const sql = item.parameters?.query;
        if (typeof sql === 'string' && /\b(delete|truncate|drop)\b/i.test(withoutCommentsOrLiterals(sql))) {
          out.push(violation('no-deletes', workflow, item, 'the SQL contains DELETE, TRUNCATE or DROP'));
        }
      }
    }
  }
  return out;
}

function ruleErrorOutputWired(workflows) {
  const out = [];
  const twoRegularOutputs = new Set(['n8n-nodes-base.if', 'n8n-nodes-base.splitInBatches']);
  const expectedMultiOutputTypes = new Set([...twoRegularOutputs]);
  for (const workflow of workflows) {
    for (const item of workflow.nodes ?? []) {
      if (item.onError !== 'continueErrorOutput') continue;
      const outputs = workflow.connections?.[item.name]?.main ?? [];
      const typeLooksMulti = /\.(if|splitInBatches|switch)$/.test(item.type);
      if (typeLooksMulti && !expectedMultiOutputTypes.has(item.type)) {
        out.push(
          violation(
            'error-output-wired',
            workflow,
            item,
            `unexpected multi-output node type: ${item.type}`,
          ),
        );
        continue;
      }
      const errorIndex = twoRegularOutputs.has(item.type) ? 2 : 1;
      if (!Array.isArray(outputs[errorIndex]) || outputs[errorIndex].length === 0) {
        out.push(
          violation(
            'error-output-wired',
            workflow,
            item,
            `onError declares an error output, but main[${errorIndex}] is not connected`,
          ),
        );
      }
    }
  }
  return out;
}

function ruleSqlParamsArray(workflows) {
  const out = [];
  const arrayExpression = /^=\s*\{\{\s*\[[\s\S]*\]\s*\}\}\s*$/;
  for (const workflow of workflows) {
    for (const item of workflow.nodes ?? []) {
      if (item.type !== 'n8n-nodes-base.postgres') continue;
      const value = item.parameters?.options?.queryReplacement;
      const empty = value === undefined || value === null || value === '';
      if (!empty && (typeof value !== 'string' || !arrayExpression.test(value))) {
        out.push(
          violation(
            'sql-params-array',
            workflow,
            item,
            'options.queryReplacement is not an expression that builds an array',
          ),
        );
      }
    }
  }
  return out;
}

function ruleErrorWorkflowAssigned(workflows) {
  const out = [];
  const required = new Set([IDS.ORCHESTRATOR, IDS.WEBHOOK, IDS.BACKUP, IDS.DAILY_WATCH]);
  for (const workflow of workflows) {
    if (!required.has(workflow.id)) continue;
    if (selectorValue(workflow.settings?.errorWorkflow) !== IDS.ERROR_MANAGER) {
      out.push(
        violation(
          'error-workflow-assigned',
          workflow,
          'settings.errorWorkflow',
          `does not point to ${IDS.ERROR_MANAGER}`,
        ),
      );
    }
  }
  return out;
}

function ruleExecutionsWithoutData(workflows) {
  const out = [];
  const required = new Set([IDS.BACKUP, IDS.DAILY_WATCH, IDS.BACKUP_CONSOLE]);
  for (const workflow of workflows) {
    if (!required.has(workflow.id)) continue;
    if (workflow.settings?.saveDataSuccessExecution !== 'none') {
      out.push(
        violation(
          'executions-without-data',
          workflow,
          'settings.saveDataSuccessExecution',
          'is not an explicit none',
        ),
      );
    }
    if (workflow.settings?.saveManualExecutions !== false) {
      out.push(
        violation(
          'executions-without-data',
          workflow,
          'settings.saveManualExecutions',
          'is not an explicit false',
        ),
      );
    }
  }
  return out;
}

function ruleTimezone(workflows) {
  const out = [];
  for (const workflow of workflows) {
    const schedules = (workflow.nodes ?? []).filter(
      (item) => item.type === 'n8n-nodes-base.scheduleTrigger',
    );
    if (schedules.length > 0 && workflow.settings?.timezone !== 'America/Costa_Rica') {
      for (const schedule of schedules) {
        out.push(
          violation(
            'timezone',
            workflow,
            schedule,
            'settings.timezone is not America/Costa_Rica',
          ),
        );
      }
    }
  }
  return out;
}

export function runRules(workflows) {
  return [
    ruleInventory,
    ruleSendWithoutRetry,
    ruleKeyBeforeSend,
    ruleGatesBeforeSender,
    ruleTelegramHtml,
    ruleNoDeletes,
    ruleErrorOutputWired,
    ruleSqlParamsArray,
    ruleErrorWorkflowAssigned,
    ruleExecutionsWithoutData,
    ruleTimezone,
  ].flatMap((rule) => rule(workflows));
}
