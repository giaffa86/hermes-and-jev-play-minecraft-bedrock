// Il dispatcher delle azioni (`_runAction`) è una catena if/else if su `key`: un
// ramo `key === 'X'` che sta *dopo* un ramo `key.startsWith('P')` con
// `X.startsWith(P)` è codice morto, perché il prefisso lo inghiotte. È il difetto
// visto live l'08/10/2026 (`craft_boat` finiva in `_craftItem('boat')` invece che
// in `_craftBoat`, e con lui `craft_blaze_powder` e `craft_ender_eye`), nella
// stessa famiglia di `mine_owned` e `place_water`.
//
// Per chiave il caso era già coperto il 03/10/2026 (`M5: fill_bucket, place_water
// e mount_boat arrivano al ramo giusto` in tests/bedrock-fluids-adapter.test.mjs),
// ma una guardia per chiave copre solo le chiavi che qualcuno si è ricordato:
// questa legge la sorgente e vale per tutte, comprese quelle che verranno.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../bedrock-adapter.mjs', import.meta.url), 'utf8');

// I rami, nell'ordine in cui il dispatcher li prova: `{ kind: 'eq'|'prefix', value }`.
// Sono escluse le condizioni che non nominano `key` (nessuna oggi lo fa) e i rami
// d'ingresso fuori dalla catena (il controllo di `resourceSites.gatherKey`).
function dispatchedBranches () {
  const from = source.indexOf('async _runAction (');
  const to = source.indexOf("'unknown_action'", from);
  assert.ok(from > 0 && to > from, 'la catena di `_runAction` non è stata trovata: la guardia non guarda nulla');
  const chain = source.slice(from, to);
  const branches = [];
  const branch = /key === '([^']+)'|key\.startsWith\('([^']+)'\)/g;
  let match;
  while ((match = branch.exec(chain)) !== null) {
    branches.push(match[1] ? { kind: 'eq', value: match[1] } : { kind: 'prefix', value: match[2] });
  }
  return branches;
}

test('nel dispatcher nessuna chiave specifica sta dopo il prefisso che la inghiotte', () => {
  const branches = dispatchedBranches();
  assert.ok(branches.length > 100, `catena sospetta: ${branches.length} rami letti`);
  const shadowed = [];
  branches.forEach((branch, index) => {
    if (branch.kind !== 'eq') return;
    const swallow = branches.slice(0, index).find(b => b.kind === 'prefix' && branch.value.startsWith(b.value));
    if (swallow) shadowed.push(`${branch.value} (dietro startsWith('${swallow.value}'))`);
  });
  assert.deepEqual(shadowed, [], `rami irraggiungibili: ${shadowed.join(', ')}`);
});

test('le chiavi craft con un passo loro stanno prima del prefisso `craft_`', () => {
  const branches = dispatchedBranches();
  const prefix = branches.findIndex(b => b.kind === 'prefix' && b.value === 'craft_');
  assert.ok(prefix > 0, 'il ramo del prefisso `craft_` non è più nella catena');
  for (const key of ['craft_boat', 'craft_blaze_powder', 'craft_ender_eye']) {
    const at = branches.findIndex(b => b.kind === 'eq' && b.value === key);
    assert.ok(at > 0 && at < prefix, `${key} deve stare prima di \`craft_\``);
  }
});
