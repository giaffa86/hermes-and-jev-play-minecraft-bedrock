// Il ledger della run: i numeri che un agente può citare devono uscire da un file,
// non dalla memoria. Origine (06/10/2026): la sessione che ha estratto il primo
// diamante è stata guidata a mano su `/act` e non ha lasciato né controller.jsonl né
// metriche, quindi "7 minuti e 17 secondi di lavoro attivo" non era verificabile.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunLedger, readRunFacts, summarizeLedger, isExecuted } from '../run-ledger.mjs';

const newDir = () => mkdtempSync(join(tmpdir(), 'run-ledger-'));

test('busy is a lock, not work: it is refused and never counted as action time', () => {
  const records = [
    { t: 1000, key: 'mine_stone', ok: true, ms: 2000, error: null },
    { t: 1100, key: 'mine_stone', ok: false, ms: 1, error: 'busy' },
    { t: 4000, key: 'mine_stone', ok: false, ms: 500, error: 'unreachable' },
  ];
  const summary = summarizeLedger(records, { startedAt: 1000 });
  assert.equal(summary.attempts, 3);
  assert.equal(summary.executed, 2);
  assert.equal(summary.ok, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.refused, 1);
  assert.deepEqual(summary.refusals, { busy: 1 });
  assert.equal(summary.actionMs, 2500);
  assert.equal(summary.actionSeconds, 2.5);
  assert.equal(summary.wallClockMs, 3000);
  assert.equal(summary.spanMs, 3000);
  assert.deepEqual(summary.byKey.mine_stone, { count: 2, ok: 1, ms: 2500 });
  assert.equal(isExecuted({ ok: false, error: 'busy' }), false);
  assert.equal(isExecuted({ ok: false, error: 'not_connected' }), false);
  assert.equal(isExecuted({ ok: false, error: 'action_timeout' }), true);
});

test('a run ledger appends one line per attempt and writes the aggregate on shutdown', () => {
  const dir = newDir();
  const ledger = createRunLedger(dir, { startedAt: 1000 });
  ledger.record({ key: 'craft_iron_pickaxe', ok: true, ms: 1200 });
  ledger.record({ key: 'mine_deepslate_diamond_ore', ok: true, ms: 8000 });
  ledger.record({ key: 'mine_deepslate_diamond_ore', ok: false, ms: 300, error: 'unreachable' });
  assert.equal(ledger.records.length, 3);
  const lines = readFileSync(join(dir, 'actions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(JSON.parse(lines[1]).key, 'mine_deepslate_diamond_ore');
  assert.equal(JSON.parse(lines[1]).ok, true);
  assert.equal(JSON.parse(lines[2]).error, 'unreachable');

  const summary = ledger.writeSummary({ run: 'diamond-20261006-4', stoppedAt: 20000 });
  assert.equal(summary.run, 'diamond-20261006-4');
  assert.equal(summary.executed, 3);
  assert.equal(summary.actionSeconds, 9.5);
  assert.equal(summary.byKey.mine_deepslate_diamond_ore.count, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).run, 'diamond-20261006-4');
});

test('readRunFacts reads the ledger, the controller and their cost, and says when nothing is verifiable', () => {
  const dir = newDir();
  const ledger = createRunLedger(dir, { startedAt: Date.now() });
  ledger.record({ key: 'goto_waypoint', ok: true, ms: 5000 });
  writeFileSync(join(dir, 'controller.jsonl'), [
    { t: 1000, type: 'goal_start', goalId: 'g1', objective: 'Collect one diamond' },
    { t: 2000, type: 'decision', controller: 'jev', provider: 'typesafe' },
    { t: 3000, type: 'result', step: 1, key: 'mine_deepslate_diamond_ore', ok: true, ms: 7000 },
    { t: 4000, type: 'result', step: 2, key: 'collect_drop', ok: false, ms: 100, error: 'no_drops' },
    { t: 5000, type: 'goal_met', steps: 2, totalCost: 0.0413 },
    { t: 6000, type: 'run_end', steps: 2, totalCost: 0.0413 },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  const facts = readRunFacts(dir);
  assert.equal(facts.verifiable, true);
  assert.equal(facts.ledger.attempts, 1);
  assert.equal(facts.ledger.actionSeconds, 5);
  assert.equal(facts.controller.actions, 2);
  assert.equal(facts.controller.actionMs, 7100);
  assert.equal(facts.controller.failed, 1);
  assert.equal(facts.controller.decisions, 1);
  assert.equal(facts.controller.steps, 2);
  assert.equal(facts.controller.totalCost, 0.0413);
  assert.equal(facts.controller.finished, true);
  assert.deepEqual(facts.controller.byKey, { mine_deepslate_diamond_ore: 1, collect_drop: 1 });

  // Una run senza file di misura non si inventa: `verifiable` è false e il tool lo dice.
  const empty = readRunFacts(newDir());
  assert.equal(empty.verifiable, false);
  assert.equal(empty.ledger, null);
  assert.equal(empty.controller, null);

  // Un file troncato o rotto non deve far fallire la lettura della run.
  const torn = newDir();
  appendFileSync(join(torn, 'actions.jsonl'), '{"t":1,"key":"wait","ok":true,"ms":10,"error":null}\n{"t":');
  assert.equal(readRunFacts(torn).ledger.attempts, 1);
});
