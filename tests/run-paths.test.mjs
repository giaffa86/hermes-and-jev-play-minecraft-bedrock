// Il ledger di un run deve essere leggibile da chi non lo ha lanciato: il harness
// gira in un container, quindi la cartella dei run è una variabile (run-paths.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runsRoot, runDir } from '../run-paths.mjs';
import { createRunLedger, readRunFacts } from '../run-ledger.mjs';

test('RUNS_DIR moves the whole run directory', () => {
  assert.equal(runsRoot({}), 'runs');
  assert.equal(runsRoot({ RUNS_DIR: '/mnt/runs' }), '/mnt/runs');
  assert.equal(runDir('demo', {}), join('runs', 'demo'));
  assert.equal(runDir('demo', { RUNS_DIR: '/mnt/runs' }), join('/mnt/runs', 'demo'));
  // un RUNS_DIR relativo resta relativo al processo che scrive (il container)
  assert.equal(runDir('demo', { RUNS_DIR: './vol/runs' }), join('./vol/runs', 'demo'));
});

test('a ledger written through RUNS_DIR is readable from outside the harness', () => {
  const root = mkdtempSync(join(tmpdir(), 'runs-dir-'));
  const dir = runDir('demo', { RUNS_DIR: root });
  // come fa il harness all'avvio: la cartella del run la crea chi scrive
  mkdirSync(dir, { recursive: true });
  const ledger = createRunLedger(dir);
  ledger.record({ key: 'mine_diamond_ore', ok: true, ms: 1200 });
  ledger.record({ key: 'mine_diamond_ore', ok: false, ms: 300, error: 'block_still_present' });
  ledger.record({ key: 'mine_diamond_ore', ok: false, ms: null, error: 'busy' });
  ledger.writeSummary({ run: 'demo' });

  assert.ok(existsSync(join(dir, 'actions.jsonl')));
  assert.ok(existsSync(join(dir, 'summary.json')));
  const lines = readFileSync(join(dir, 'actions.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 3, 'una riga per tentativo, append-only');
  const facts = readRunFacts(dir);
  assert.equal(facts.verifiable, true);
  assert.equal(facts.ledger.executed, 2, 'busy non è lavoro');
  assert.equal(facts.ledger.failed, 1);
  assert.deepEqual(facts.ledger.refusals, { busy: 1 });
  assert.equal(facts.summary.run, 'demo');
});

test('every entry point that resolves a run directory imports the resolver', () => {
  // I driver M1/M2/M4 non sono caricati dalla suite: un `runDir` senza import
  // resta un ReferenceError al primo avvio (`explore.mjs`, `explore-find.mjs` e
  // `explore-replay.mjs` sono rimasti così per un giro). Questo test li legge
  // come testo e pretende che ogni funzione usata sia importata.
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = ['harness.mjs', 'bedrock-harness.mjs', 'controller.mjs', 'explore.mjs', 'explore-find.mjs', 'explore-replay.mjs'];
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    for (const name of ['runDir', 'runsRoot']) {
      if (!new RegExp(`\\b${name}\\s*\\(`).test(source)) continue;
      const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'\\./run-paths\\.mjs'`).test(source);
      assert.ok(imported, `${file} usa ${name} ma non lo importa da run-paths.mjs`);
    }
  }
});
