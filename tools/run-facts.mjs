// Facts about a run, read from the files it left in `runs/<run>/`. The point is to
// answer "how long did it take / how many actions / what did it cost" with numbers
// that come from a file read in the same turn, instead of from memory: on 06/10 an
// agent answered "7 minutes 17 seconds of active work" and no artifact contained
// that number.
//
//   node tools/run-facts.mjs <run|path> [--json] [--top N]
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readRunFacts } from '../run-ledger.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));
const topIndex = args.indexOf('--top');
const TOP = topIndex >= 0 ? Number(args[topIndex + 1]) || 10 : 10;

if (!positional.length) {
  const runs = existsSync('runs') ? readdirSync('runs').filter(name => {
    try { return statSync(join('runs', name)).isDirectory(); } catch { return false; }
  }) : [];
  console.error('usage: node tools/run-facts.mjs <run|path> [--json] [--top N]');
  console.error(`runs available: ${runs.slice(-12).join(', ')}${runs.length > 12 ? ` (${runs.length} total)` : ''}`);
  process.exit(2);
}

const dir = positional[0].includes('/') ? resolve(positional[0]) : resolve('runs', positional[0]);
if (!existsSync(dir)) {
  console.error(`no such run: ${dir}`);
  process.exit(2);
}

const facts = readRunFacts(dir);
if (flags.has('--json')) {
  console.log(JSON.stringify(facts, null, 2));
  process.exit(0);
}

const clock = (t) => (Number.isFinite(t) ? new Date(t).toTimeString().slice(0, 8) : '--:--:--');
const duration = (ms) => (ms == null ? 'n/a' : `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(1)}s`);

console.log(`run: ${dir}`);
if (!facts.verifiable) {
  console.log('  verificabile: NO — nessun actions.jsonl, summary.json o controller.jsonl');
  console.log('  (una run guidata a mano sull\'API HTTP non lasciava numeri: il ledger è stato aggiunto il 06/10)');
  process.exit(0);
}

const ledger = facts.ledger;
if (ledger) {
  console.log(`  ledger: ${ledger.attempts} tentativi, ${ledger.executed} eseguiti (${ledger.ok} ok, ${ledger.failed} falliti), ${ledger.refused} rifiuti ${JSON.stringify(ledger.refusals)}`);
  console.log(`  azioni: ${ledger.actionSeconds}s di tempo d'azione, ${duration(ledger.wallClockMs)} di orologio fra la prima e l'ultima (${clock(ledger.firstAt)} → ${clock(ledger.lastAt)})`);
  const keys = Object.entries(ledger.byKey).sort((a, b) => b[1].count - a[1].count).slice(0, TOP);
  for (const [key, entry] of keys) console.log(`    ${key}: ${entry.count} azioni, ${(entry.ms / 1000).toFixed(1)}s, ${entry.ok} ok`);
}
if (facts.controller) {
  const c = facts.controller;
  console.log(`  controller: ${c.count} record, ${c.decisions} decisioni, ${c.actions} azioni (${(c.actionMs / 1000).toFixed(1)}s), ${c.steps} passi, concluso: ${c.finished ? 'sì' : 'NO'}`);
  console.log(`    costo registrato: ${c.totalCost == null ? 'assente (run interrotta prima di run_end)' : `${c.totalCost}`}`);
  const keys = Object.entries(c.byKey).sort((a, b) => b[1] - a[1]).slice(0, TOP);
  for (const [key, count] of keys) console.log(`    ${key}: ${count} azioni`);
}
if (facts.planTrace) {
  const p = facts.planTrace.summary;
  const sources = Object.entries(p.bySource).map(([k, v]) => `${k}=${v}`).join(', ');
  console.log(`  plan-trace: ${p.plans} piani (${sources}), ${p.steps} passi, ${p.decisions} decisioni, ${p.refusals} rifiuti, ${p.replans} replan`);
  if (p.topRefusals.length) console.log(`    rifiuti: ${p.topRefusals.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (p.topEndedBy.length) console.log(`    chiusure: ${p.topEndedBy.map(([k, v]) => `${k ?? 'open'}=${v}`).join(', ')}`);
  if (p.lastPlan) console.log(`    ultimo piano: ${p.lastPlan.source} "${p.lastPlan.objective ?? ''}"${p.lastPlan.subgoal ? ` -> ${p.lastPlan.subgoal}` : ''} (${p.lastPlan.stepCount} step)`);
}
if (facts.summary) console.log(`  summary.json: ${JSON.stringify({ attempts: facts.summary.attempts, actionSeconds: facts.summary.actionSeconds, wallClockMs: facts.summary.wallClockMs })}`);
if (facts.events) console.log(`  events: ${facts.events.count} (${Object.entries(facts.events.types).map(([k, v]) => `${k}=${v}`).join(', ')})`);
if (facts.skills) console.log(`  skills: ${facts.skills.count} tentativi, ${facts.skills.ok} ok`);
if (facts.circuits) console.log(`  circuits: ${facts.circuits.count} tentativi, ${facts.circuits.ok} ok`);
