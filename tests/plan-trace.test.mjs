// R3: la traccia del piano. Una riga per segmento di piano in
// `runs/<run>/plan-trace.jsonl`, con la provenienza del piano, i suoi step, le
// decisioni prese, i rifiuti visti e il motivo per cui il segmento si e' chiuso.
// E' quello che oggi andrebbe ricostruito a mano incrociando `controller.jsonl`
// con `actions.jsonl`: il *perche'* di un replan, in un file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPlanTrace, planTraceSource, planTraceShape, planTraceSteps,
  readPlanTrace, summarizePlanTrace, PLAN_SOURCES, PLAN_TRACE_VERSION,
} from '../plan-trace.mjs';
import { readRunFacts } from '../run-ledger.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const tmp = () => mkdtempSync(join(tmpdir(), 'plan-trace-'));

const IRON_PLAN = {
  objective: 'mine iron to craft a pickaxe',
  subgoal: 'gather iron ore',
  source: 'curriculum',
  skill: 'mine_iron',
  steps: [{ id: 'mine_iron', skill: 'mine_iron', targets: { iron_ore: 4 }, verify: ['inventoryGte'] }],
};

test('a closed segment carries the plan source, its steps and the step count', () => {
  const dir = tmp();
  const trace = createPlanTrace({ dir });
  trace.adopt({ step: 0, reason: 'start', plan: IRON_PLAN });
  trace.record({ step: 1, key: 'mine_iron_ore', by: 'jev', reason: 'mine_it', ok: true, ms: 1200 });
  trace.flush({ endedBy: 'goal_met', step: 1 });

  const rows = readPlanTrace(dir);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.v, PLAN_TRACE_VERSION);
  assert.equal(row.planId, 'p1');
  assert.equal(row.source, 'curriculum');
  assert.equal(row.stepCount, 1);
  assert.equal(row.objective, IRON_PLAN.objective);
  assert.equal(row.subgoal, IRON_PLAN.subgoal);
  assert.deepEqual(row.steps, IRON_PLAN.steps);
  assert.equal(row.reason, 'start');
  assert.equal(row.endedBy, 'goal_met');
  assert.equal(row.untilStep, 1);
  assert.equal(row.actions, 1);
  assert.equal(row.ok, 1);
  assert.equal(row.failed, 0);
  assert.deepEqual(row.decisions.map(d => d.key), ['mine_iron_ore']);
  assert.equal(row.decisions[0].by, 'jev');
  assert.ok(row.ms >= 0);
});

test('a refusal lands in the segment with its typed error, and never as a decision', () => {
  const dir = tmp();
  const trace = createPlanTrace({ dir });
  trace.adopt({ step: 0, reason: 'start', plan: { objective: 'mine iron', source: 'hermes' } });
  trace.record({ step: 1, key: 'mine_iron_ore', by: 'jev', ok: true, ms: 800 });
  trace.record({ step: 2, key: 'mine_iron_ore', by: 'jev', ok: false, error: 'no reachable iron_ore found nearby', ms: 300 });
  trace.flush({ endedBy: 'run_end', step: 2 });

  const [row] = readPlanTrace(dir);
  assert.equal(row.actions, 2);
  assert.equal(row.ok, 1);
  assert.equal(row.failed, 1);
  assert.deepEqual(row.decisions.map(d => d.step), [1]);
  assert.deepEqual(row.refusals, [{ step: 2, key: 'mine_iron_ore', error: 'no reachable iron_ore found nearby', ms: 300 }]);
});

test('every replan reason is written: the reason in, the endedBy out', () => {
  const dir = tmp();
  const trace = createPlanTrace({ dir });
  const reasons = ['skill_failed', 'anti_loop:goto_waypoint:3', 'human_order_override'];
  trace.adopt({ step: 0, reason: 'start', plan: { objective: 'a', source: 'hermes' } });
  for (const [index, reason] of reasons.entries()) {
    const at = index + 1;
    trace.record({ step: at, key: 'goto_waypoint', by: 'jev', ok: true });
    const traceReason = reason === 'human_order_override' ? 'human_order_override' : `replan:${reason}`;
    trace.flush({ endedBy: traceReason, step: at });
    trace.adopt({ step: at + 1, reason: traceReason, plan: { objective: `plan ${at}`, source: 'hermes' } });
  }
  trace.flush({ endedBy: 'goal_met', step: 4 });

  const rows = readPlanTrace(dir);
  assert.deepEqual(rows.map(r => r.endedBy), [...reasons.map(r => (r === 'human_order_override' ? r : `replan:${r}`)), 'goal_met']);
  assert.deepEqual(rows.map(r => r.reason), ['start', 'replan:skill_failed', 'replan:anti_loop:goto_waypoint:3', 'human_order_override']);
  const summary = summarizePlanTrace(rows);
  assert.equal(summary.plans, 4);
  assert.equal(summary.replans, 2);
  assert.equal(summary.endedBy['human_order_override'], 1);
  assert.equal(summary.decisions, 3);
  assert.equal(summary.lastPlan.objective, 'plan 3');
});

test('adopting a new plan closes the previous segment as `replaced`: a missing flush loses nothing', () => {
  const dir = tmp();
  const trace = createPlanTrace({ dir });
  trace.adopt({ step: 0, reason: 'start', plan: { objective: 'a', source: 'hermes' } });
  trace.record({ step: 1, key: 'wait', by: 'jev', ok: true });
  trace.adopt({ step: 2, reason: 'replan:periodic', plan: { objective: 'b', source: 'hermes' } });
  trace.flush({ endedBy: 'run_end', step: 2 });

  const rows = readPlanTrace(dir);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].endedBy, 'replaced');
  assert.equal(rows[0].actions, 1, 'the decisions taken before the missing flush are still counted');
  assert.equal(rows[1].endedBy, 'run_end');
});

test('flush is idempotent: two closers do not write two rows', () => {
  const dir = tmp();
  const trace = createPlanTrace({ dir });
  trace.adopt({ step: 0, reason: 'start', plan: { objective: 'a', source: 'hermes' } });
  assert.ok(trace.flush({ endedBy: 'goal_met' }));
  assert.equal(trace.flush({ endedBy: 'goal_end' }), null);
  assert.equal(trace.current, null);
  assert.equal(readPlanTrace(dir).length, 1);
});

test('a plan without a declared source is a Hermes plan; the vocabulary is closed', () => {
  assert.equal(planTraceSource({ objective: 'x' }), 'hermes');
  assert.equal(planTraceSource(null), 'hermes');
  assert.equal(planTraceSource({ source: 'governor:emergency' }), 'hermes');
  for (const source of PLAN_SOURCES) assert.equal(planTraceSource({ source }), source);
  assert.deepEqual([...PLAN_SOURCES].sort(), ['construction', 'curriculum', 'deterministic', 'hermes']);
});

test('steps are compacted and truncated, but the count is the real one', () => {
  const plan = {
    objective: 'x',
    steps: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, skill: null, targets: {}, verify: [] })),
  };
  const shape = planTraceShape(plan);
  assert.equal(shape.stepCount, 20);
  assert.equal(shape.steps.length, 12);
  assert.deepEqual(planTraceSteps({ steps: [{ id: 's', skill: 'k', circuit: 'c', targets: {}, verify: ['a'] }] }),
    [{ id: 's', skill: 'k', circuit: 'c', verify: ['a'] }]);
  // Un piano senza `steps` non inventa uno step: la traccia dice che non c'e'.
  assert.deepEqual(planTraceShape({ objective: 'x' }).steps, []);
  assert.equal(planTraceShape({ objective: 'x' }).stepCount, 0);
  assert.equal(planTraceShape({}).objective, null);
});

test('a segment is bounded: the omitted entries are counted, not hidden', () => {
  const dir = tmp();
  const trace = createPlanTrace({ dir });
  trace.adopt({ step: 0, reason: 'start', plan: { objective: 'a', source: 'hermes' } });
  for (let step = 1; step <= 70; step++) trace.record({ step, key: 'wait', by: 'jev', ok: true });
  trace.flush({ endedBy: 'run_end', step: 70 });

  const [row] = readPlanTrace(dir);
  assert.equal(row.actions, 70);
  assert.equal(row.decisions.length, 64);
  assert.equal(row.omitted.decisions, 6);
  assert.equal(summarizePlanTrace([row]).omitted, 6);
});

test('readRunFacts exposes the trace summary and tools/run-facts.mjs prints it', () => {
  const dir = tmp();
  const trace = createPlanTrace({ dir });
  trace.adopt({ step: 0, reason: 'start', plan: IRON_PLAN });
  trace.record({ step: 1, key: 'mine_iron_ore', by: 'jev', ok: false, error: 'no reachable iron_ore found nearby' });
  trace.flush({ endedBy: 'replan:skill_failed', step: 1 });
  trace.adopt({ step: 2, reason: 'replan:skill_failed', plan: { objective: 'mine coal', source: 'hermes', subgoal: 'gather coal', steps: [{ id: 'mine_coal', skill: 'mine_coal', verify: ['inventoryGte'] }] } });
  trace.flush({ endedBy: 'goal_met', step: 3 });
  // Il riassunto esiste anche senza ledger: la traccia e' un artefatto a se'.
  writeFileSync(join(dir, 'actions.jsonl'), JSON.stringify({ t: 1, key: 'mine_iron_ore', ok: false, ms: 300, error: 'no reachable iron_ore found nearby' }) + '\n');

  const facts = readRunFacts(dir);
  assert.equal(facts.planTrace.count, 2);
  const summary = facts.planTrace.summary;
  assert.deepEqual(summary.bySource, { curriculum: 1, hermes: 1 });
  assert.equal(summary.plans, 2);
  assert.equal(summary.replans, 1);
  assert.equal(summary.refusalsByError['no reachable iron_ore found nearby'], 1);
  assert.equal(summary.lastPlan.objective, 'mine coal');

  const out = execFileSync(process.execPath, [join(ROOT, 'tools/run-facts.mjs'), dir], { encoding: 'utf8' });
  assert.match(out, /plan-trace: 2 piani \(curriculum=1, hermes=1\), 2 passi, 0 decisioni, 1 rifiuti, 1 replan/);
  assert.match(out, /rifiuti: no reachable iron_ore found nearby=1/);
  assert.match(out, /ultimo piano: hermes "mine coal" -> gather coal \(1 step\)/);  assert.ok(existsSync(join(dir, 'plan-trace.jsonl')), 'the trace is a file, not a memory');
  // Il file e' JSONL append-only: una riga per segmento, leggibile a mano.
  assert.equal(readFileSync(join(dir, 'plan-trace.jsonl'), 'utf8').trim().split('\n').length, 2);
});
