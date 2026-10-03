// Placement ledger (R4 persistente): i blocchi che il bot ha piazzato *lui*.
// È l'unico titolo che lo autorizza a rimuoverli senza toccare la base, quindi
// deve sopravvivere ai restart dell'harness e deve poter sparire quando il
// blocco non è più quello (o quando il bot se lo riprende).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldMemory } from '../world-memory.mjs';

const quiet = { warn () {} };
const BACKENDS = ['json', 'sqlite'];

const withMemory = (backend, fn) => {
  const dir = mkdtempSync(join(tmpdir(), `mp-${backend}-`));
  try {
    const wm = createWorldMemory({ dir, backend, logger: quiet });
    return fn(wm, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

for (const backend of BACKENDS) {
  test(`[${backend}] a placement is remembered and read back by position`, () => withMemory(backend, (wm) => {
    const record = wm.rememberPlacement({ position: { x: 1, y: 64, z: 2 }, block: 'torch', item: 'torch' });
    assert.equal(record.id, 'placement_1_64_2', "l'id è spaziale");
    assert.equal(record.kind, 'placement');
    assert.equal(record.type, 'torch');
    assert.equal(record.item, 'torch');
    assert.equal(record.circuitId, null);
    assert.equal(record.status, 'known');
    assert.equal(record.confidence, 1);

    const found = wm.placementAt({ x: 1, y: 64, z: 2 });
    assert.equal(found?.id, 'placement_1_64_2');
    assert.deepEqual(found.position, { x: 1, y: 64, z: 2 });
    assert.equal(wm.placementAt({ x: 9, y: 9, z: 9 }), null, 'cella ignota');
    assert.equal(wm.placementAt(null), null, 'nessuna posizione non è un errore');
    assert.equal(wm.placements().length, 1);
    assert.equal(wm.placements().length, wm.repo.count({ kind: 'placement' }));
    assert.equal(wm.observeView().counts.placement, 1, 'il registro si vede nella vista del mondo');
    assert.equal(wm.placementId({ x: 1.4, y: 64.6, z: 2.2 }), 'placement_1_65_2', "l'id è arrotondato come le altre celle");
  }));

  // Una cella = un titolo: piazzare di nuovo sopra (o sostituire il blocco) non
  // deve creare una seconda riga, né perdere la prima scoperta.
  test(`[${backend}] the same cell is one record, updated in place`, () => withMemory(backend, (wm) => {
    const first = wm.rememberPlacement({ position: { x: 3, y: 70, z: 3 }, block: 'torch', placedAt: 1000 });
    const second = wm.rememberPlacement({ position: { x: 3, y: 70, z: 3 }, block: 'oak_planks', item: 'oak_planks', placedAt: 2000 });
    assert.equal(second.id, first.id);
    assert.equal(wm.placements().length, 1, 'una cella, un record');
    const now = wm.placementAt({ x: 3, y: 70, z: 3 });
    assert.equal(now.type, 'oak_planks');
    assert.equal(now.item, 'oak_planks');
    assert.equal(now.placedAt, 2000);
    assert.equal(now.discoveredAt, 1000, 'la prima scoperta resta la prima');
  }));

  // Il cantiere impara *dopo* il piazzamento che quella cella è di un circuito
  // (R4): l'aggiornamento non deve duplicare il record.
  test(`[${backend}] a circuit step is tagged after the fact and can be filtered`, () => withMemory(backend, (wm) => {
    wm.rememberPlacement({ position: { x: 5, y: 70, z: 5 }, block: 'redstone_torch', source: 'circuit' });
    wm.rememberPlacement({ position: { x: 6, y: 70, z: 5 }, block: 'torch' });

    const tagged = wm.setPlacementCircuit({ x: 5, y: 70, z: 5 }, 'auto_door');
    assert.equal(tagged.circuitId, 'auto_door');
    assert.equal(wm.placementAt({ x: 5, y: 70, z: 5 }).source, 'circuit', 'gli altri campi non si perdono');
    assert.equal(wm.placements().length, 2, 'nessun record nuovo');
    assert.equal(wm.setPlacementCircuit({ x: 7, y: 7, z: 7 }, 'auto_door'), null, 'cella ignota: nessun record inventato');

    assert.equal(wm.placements({ circuitId: 'auto_door' }).length, 1);
    assert.equal(wm.placements({ circuitId: 'auto_lamp' }).length, 0);
    assert.equal(wm.placements().length, 2, 'senza filtro ci sono entrambi');
  }));

  // Chi rimuove vuole il più vicino: l'ordine per distanza evita che il bot
  // attraversi mezza base per togliersi di torno una torcia.
  test(`[${backend}] placements are ordered by distance from a reference`, () => withMemory(backend, (wm) => {
    wm.rememberPlacement({ position: { x: 0, y: 64, z: 40 }, block: 'torch' });
    wm.rememberPlacement({ position: { x: 0, y: 64, z: 2 }, block: 'torch' });
    wm.rememberPlacement({ position: { x: 0, y: 64, z: 20 }, block: 'torch' });
    assert.deepEqual(wm.placements({ near: { x: 0, y: 64, z: 0 } }).map(r => r.position.z), [2, 20, 40]);
    assert.equal(wm.placements({ limit: 2 }).length, 2);
  }));

  test(`[${backend}] forgetting a placement removes it and only it`, () => withMemory(backend, (wm) => {
    wm.rememberPlacement({ position: { x: 1, y: 1, z: 1 }, block: 'torch' });
    wm.rememberPlacement({ position: { x: 2, y: 1, z: 1 }, block: 'torch' });
    assert.equal(wm.forgetPlacement({ x: 1, y: 1, z: 1 }), true);
    assert.equal(wm.forgetPlacement({ x: 1, y: 1, z: 1 }), false, 'idempotente');
    assert.equal(wm.forgetPlacement(null), false, 'nessuna posizione: niente da dimenticare');
    assert.equal(wm.placements().length, 1);
    assert.equal(wm.placementAt({ x: 2, y: 1, z: 1 })?.id, 'placement_2_1_1');
    assert.equal(wm.observeView().counts.placement, 1);
  }));

  // La proprietà che rende utile tutto il resto: un restart dell'harness non
  // deve far perdere la titolarità dei propri blocchi.
  test(`[${backend}] the ledger survives a restart of the store`, () => withMemory(backend, (wm, dir) => {
    wm.rememberPlacement({ position: { x: 115, y: 73, z: 160 }, block: 'crafting_table', item: 'crafting_table' });
    wm.rememberPlacement({ position: { x: 116, y: 73, z: 158 }, block: 'torch', item: 'torch', circuitId: 'auto_lamp' });
    wm.flush();
    wm.close();

    const reopened = createWorldMemory({ dir, backend, logger: quiet });
    assert.equal(reopened.placements().length, 2, 'il registro è persistito');
    const table = reopened.placementAt({ x: 115, y: 73, z: 160 });
    assert.equal(table?.type, 'crafting_table');
    assert.equal(table?.item, 'crafting_table');
    assert.equal(reopened.placements({ circuitId: 'auto_lamp' })[0].position.z, 158);
    reopened.close();
  }));

  test(`[${backend}] a placement without position or block is refused`, () => withMemory(backend, (wm) => {
    assert.throws(() => wm.rememberPlacement({ block: 'torch' }), /position and block required/);
    assert.throws(() => wm.rememberPlacement({ position: { x: 1, y: 2, z: 3 } }), /position and block required/);
    assert.equal(wm.placements().length, 0);
  }));
}
