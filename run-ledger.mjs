// Every run must leave readable numbers behind: how many actions, how much action
// time, how much wall clock. A driver that walks `/act` by hand (the Codex session
// on 06/10 that mined the first diamond) wrote no ledger at all, so claims like
// "7 minutes 17 seconds of active work" could not be checked against any file and
// stayed unverifiable. The ledger is append-only, one line per attempt, because it
// has to survive a kill; the aggregate is written to `summary.json` on shutdown.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// A refusal before execution is not an action: `busy` is the adapter's lock, not a
// verdict on the action (tests/controller-busy.test.mjs). Counting `busy` replies
// as work would inflate a run that only waited for the previous action.
const NOT_EXECUTED = new Set(['busy', 'not_connected', 'dead', 'sleeping', 'unknown_action']);

export const isExecuted = (record) => record.ok === true || !NOT_EXECUTED.has(record.error ?? '');

export function summarizeLedger (records = [], { startedAt = null } = {}) {
  const byKey = {};
  const refusals = {};
  let actionMs = 0;
  let executed = 0;
  let ok = 0;
  let failed = 0;
  let refused = 0;
  for (const record of records) {
    if (!isExecuted(record)) {
      refused++;
      const reason = record.error ?? 'unknown';
      refusals[reason] = (refusals[reason] ?? 0) + 1;
      continue;
    }
    executed++;
    if (record.ok) ok++;
    else failed++;
    const ms = Number.isFinite(record.ms) ? record.ms : 0;
    actionMs += ms;
    const entry = byKey[record.key ?? 'null'] ?? { count: 0, ok: 0, ms: 0 };
    entry.count++;
    if (record.ok) entry.ok++;
    entry.ms += ms;
    byKey[record.key ?? 'null'] = entry;
  }
  const firstAt = records.length ? records.at(0).t : null;
  const lastAt = records.length ? records.at(-1).t : null;
  return {
    attempts: records.length,
    executed,
    ok,
    failed,
    refused,
    refusals,
    actionMs,
    actionSeconds: +(actionMs / 1000).toFixed(1),
    // Wall clock between the first and the last attempt: this is the number a
    // reader can compare with what an agent told them it took.
    wallClockMs: firstAt != null && lastAt != null ? lastAt - firstAt : 0,
    // From process start to the last attempt, when the harness recorded its own start.
    spanMs: lastAt != null && startedAt != null ? lastAt - startedAt : null,
    startedAt,
    firstAt,
    lastAt,
    byKey,
  };
}

export function createRunLedger (dir, { startedAt = Date.now() } = {}) {
  const file = join(dir, 'actions.jsonl');
  const records = [];
  return {
    dir,
    startedAt,
    file,
    get records () { return records; },
    record (entry) {
      const record = {
        t: Date.now(),
        key: entry.key ?? null,
        ok: entry.ok === true,
        ms: Number.isFinite(entry.ms) ? entry.ms : null,
        error: entry.error ?? null,
      };
      records.push(record);
      try { appendFileSync(file, JSON.stringify(record) + '\n'); }
      catch (error) { console.error('[ledger] write failed:', error.message); }
      return record;
    },
    summary () { return summarizeLedger(records, { startedAt }); },
    writeSummary (extra = {}) {
      const summary = { ...this.summary(), ...extra };
      try { writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); }
      catch (error) { console.error('[ledger] summary write failed:', error.message); }
      return summary;
    },
  };
}

const readJsonl = (path) => {
  if (!existsSync(path)) return null;
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn last line is not a record */ }
  }
  return rows;
};

const readJson = (path) => {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { console.error('[ledger] unreadable file', path, error.message); return null; }
};

const countBy = (rows, selector) => {
  const counts = {};
  for (const row of rows) counts[selector(row)] = (counts[selector(row)] ?? 0) + 1;
  return counts;
};

// What a run can prove about itself, from the files it left. `verifiable` is the
// honest answer to "how long did it take / what did it cost": false means the only
// source is somebody's memory.
export function readRunFacts (dir) {
  const actions = readJsonl(join(dir, 'actions.jsonl'));
  const controller = readJsonl(join(dir, 'controller.jsonl'));
  const events = readJsonl(join(dir, 'events.jsonl'));
  const skills = readJsonl(join(dir, 'skills.jsonl'));
  const circuits = readJsonl(join(dir, 'circuits.jsonl'));
  const summary = readJson(join(dir, 'summary.json'));

  const facts = {
    dir,
    verifiable: false,
    ledger: actions ? summarizeLedger(actions) : null,
    summary,
    controller: null,
    events: events ? { count: events.length, types: countBy(events, r => r.type ?? 'unknown'), firstAt: events.at(0)?.t ?? null, lastAt: events.at(-1)?.t ?? null } : null,
    skills: skills ? { count: skills.length, ok: skills.filter(s => s.ok === true).length } : null,
    circuits: circuits ? { count: circuits.length, ok: circuits.filter(c => c.ok === true).length } : null,
  };

  if (controller) {
    const results = controller.filter(r => r.type === 'result');
    const withCost = controller.filter(r => typeof r.totalCost === 'number');
    facts.controller = {
      count: controller.length,
      types: countBy(controller, r => r.type ?? 'unknown'),
      decisions: controller.filter(r => r.type === 'decision').length,
      actions: results.length,
      actionMs: results.reduce((sum, r) => sum + (Number.isFinite(r.ms) ? r.ms : 0), 0),
      failed: results.filter(r => r.ok !== true).length,
      byKey: countBy(results, r => r.key ?? 'null'),
      steps: controller.reduce((max, r) => Number.isFinite(r.step) ? Math.max(max, r.step) : max, 0),
      totalCost: withCost.length ? withCost.at(-1).totalCost : null,
      finished: controller.some(r => ['run_end', 'goal_met', 'goal_end'].includes(r.type)),
      firstAt: controller.at(0)?.t ?? null,
      lastAt: controller.at(-1)?.t ?? null,
    };
  }

  facts.verifiable = Boolean(facts.ledger?.attempts || facts.controller?.actions || facts.summary);
  return facts;
}
