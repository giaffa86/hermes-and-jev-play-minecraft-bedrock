// V0 — discovery and inspection are two different facts.
//
// The two properties this file exists to protect (the whole point of V0):
//   (a) a later *discovery* never erases *known* contents;
//   (b) *inspection* staleness never makes the container's *discovery* disappear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldMemory, CONTAINER_INSPECTION_STATE, MEMORY_STATUS, describeContainer } from '../world-memory.mjs';

const quiet = { warn () {} };
const BACKENDS = ['json', 'sqlite'];
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const chest = { x: 10, y: 64, z: 10 };

const withMemory = (backend, fn) => {
  const dir = mkdtempSync(join(tmpdir(), `wm-container-${backend}-`));
  try {
    const wm = createWorldMemory({ dir, backend, logger: quiet });
    return fn(wm, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

for (const backend of BACKENDS) {
  // (a) the property the user asked to close V0 with.
  test(`[${backend}] a later discovery never erases known contents (nor the contains edges)`, () => withMemory(backend, (wm) => {
    const t0 = 1_700_000_000_000;
    wm.rememberContainer({ type: 'chest', position: chest, contents: { iron_ingot: 5, coal: 2 }, observedAt: t0, source: 'read_container' });
    const id = wm.containerId(chest);
    assert.equal(wm.relationsFrom(id, { type: 'contains' }).length, 2);

    // A sweep walks past the same chest: it knows the place, not the contents.
    const after = wm.rememberContainer({ type: 'chest', position: chest, observedAt: t0 + HOUR, source: 'discovered' });

    assert.equal(after.contentsKnown, true, 'la discovery non declassa la conoscenza');
    assert.deepEqual(after.contents, { iron_ingot: 5, coal: 2 }, 'il contenuto appreso sopravvive');
    assert.equal(after.inspectedAt, t0, 'inspectedAt resta quello della misura');
    assert.equal(after.discoveredAt, t0, 'discoveredAt resta quello della prima scoperta');
    assert.equal(after.lastSeenAt, t0 + HOUR, 'lastSeenAt sì: il posto è stato rivisto');
    assert.equal(wm.relationsFrom(id, { type: 'contains' }).length, 2, 'nessun arco contains toccato');
    assert.equal(after.inspectionStale, true, 'un\'ora dopo la misura è vecchia: stale, mai cancellata');
    assert.equal(wm.findContainers({ now: t0 + MIN })[0].inspectionState, CONTAINER_INSPECTION_STATE.CONTENTS);
  }));

  test(`[${backend}] a discovery carrying an empty payload is not an empty chest`, () => withMemory(backend, (wm) => {
    const t0 = 1_700_000_000_000;
    const known = wm.rememberContainer({ type: 'barrel', position: chest, contents: { carrot: 12 }, observedAt: t0 });
    assert.equal(known.contentsKnown, true);

    // The explicit form of "I saw it, I did not measure it".
    const seen = wm.rememberContainer({ type: 'barrel', position: chest, contents: {}, contentsKnown: false, observedAt: t0 + MIN });
    assert.equal(seen.contentsKnown, true, '`contentsKnown:false` non deve degradare una misura già presa');
    assert.deepEqual(seen.contents, { carrot: 12 });

    // A never-inspected container: unknown is not empty.
    const other = { x: 11, y: 64, z: 10 };
    const fresh = wm.rememberContainer({ type: 'chest', position: other, observedAt: t0 });
    assert.equal(fresh.contentsKnown, false);
    assert.equal(fresh.contents, null, '`null` = non misurato, `{}` = misurato e vuoto');
    assert.equal(fresh.inspectionState, CONTAINER_INSPECTION_STATE.NEVER_INSPECTED);
    assert.equal(fresh.needsInspection, true);
    assert.equal(wm.relationsFrom(wm.containerId(other), { type: 'contains' }).length, 0);
  }));

  test(`[${backend}] an empty inspection is a fact, and it is not the same as never inspected`, () => withMemory(backend, (wm) => {
    const t0 = 1_700_000_000_000;
    const other = { x: 12, y: 64, z: 10 };
    wm.rememberContainer({ type: 'chest', position: other, observedAt: t0 });
    const opened = wm.rememberContainer({ type: 'chest', position: other, contents: {}, observedAt: t0 + MIN });

    assert.equal(opened.contentsKnown, true);
    assert.deepEqual(opened.contents, {});
    assert.equal(opened.inspectionState, CONTAINER_INSPECTION_STATE.EMPTY);
    assert.equal(opened.needsInspection, false, 'appena aperto e vuoto: riaprirlo ora non aggiunge nulla');
    assert.equal(wm.relationsFrom(wm.containerId(other), { type: 'contains' }).length, 0);
  }));

  test(`[${backend}] discovery is idempotent: it updates the place, not the measure`, () => withMemory(backend, (wm) => {
    const t0 = 1_700_000_000_000;
    wm.rememberContainer({ position: chest, contents: { dirt: 1 }, observedAt: t0 });
    const a = wm.rememberContainer({ type: 'barrel', position: chest, observedAt: t0 + MIN });
    const b = wm.rememberContainer({ type: 'barrel', position: chest, observedAt: t0 + 2 * MIN });

    assert.equal(a.type, 'barrel', 'la discovery aggiorna il tipo osservato');
    assert.equal(b.type, 'barrel');
    assert.deepEqual(b.contents, { dirt: 1 });
    assert.equal(b.discoveredAt, t0, 'la prima scoperta è la data della scoperta');
    assert.equal(wm.findContainers().length, 1, 'un id spaziale, una riga');
    assert.equal(wm.observationCount(), 1, 'una discovery non logga osservazioni di contenuto');
  }));

  test(`[${backend}] the four knowledge states are distinguishable`, () => withMemory(backend, (wm) => {
    const t0 = 1_700_000_000_000;
    const at = (dx) => ({ x: chest.x + dx, y: chest.y, z: chest.z });
    wm.rememberContainer({ position: at(0), observedAt: t0 });                                   // never inspected
    wm.rememberContainer({ position: at(1), contents: {}, observedAt: t0 });                     // inspected, empty
    wm.rememberContainer({ position: at(2), contents: { torch: 4 }, observedAt: t0 });           // inspected, contents
    wm.rememberContainer({ position: at(3), contents: { torch: 2 }, observedAt: t0 - 30 * MIN }); // inspected, stale

    const byState = Object.fromEntries(wm.findContainers({ now: t0 }).map((c) => [c.position.x, c.inspectionState]));
    assert.equal(byState[chest.x], CONTAINER_INSPECTION_STATE.NEVER_INSPECTED);
    assert.equal(byState[chest.x + 1], CONTAINER_INSPECTION_STATE.EMPTY);
    assert.equal(byState[chest.x + 2], CONTAINER_INSPECTION_STATE.CONTENTS);
    assert.equal(byState[chest.x + 3], CONTAINER_INSPECTION_STATE.STALE);
    assert.deepEqual(wm.findContainers({ contentsKnown: false, now: t0 }).map((c) => c.position.x), [chest.x]);
    assert.deepEqual(wm.findContainers({ needsInspection: true, now: t0 }).map((c) => c.position.x).sort(), [chest.x, chest.x + 3]);
  }));

  test(`[${backend}] inspection staleness is computed on read, with no timer and no hydrate`, () => withMemory(backend, (wm) => {
    const t0 = 1_700_000_000_000;
    wm.rememberContainer({ position: chest, contents: { iron_ingot: 1 }, observedAt: t0 });

    const later = t0 + 10 * MIN;
    assert.equal(wm.findContainers({ includeStale: false, now: later }).length, 0, 'scaduto in lettura, senza refreshStatuses');
    const [stale] = wm.findContainers({ includeStale: true, now: later });
    assert.equal(stale.status, MEMORY_STATUS.STALE);
    assert.equal(stale.storedStatus, MEMORY_STATUS.KNOWN, 'la riga memorizzata non è stata riscritta da nessun timer');
    assert.equal(stale.contentsKnown, true, 'stale non significa ignorante');
    assert.equal(stale.inspectionStale, true);
    assert.equal(stale.discoveryStale, false, 'il posto è vecchio di 10 minuti, non di 6 ore');
    assert.equal(wm.containersWithItem('iron_ingot', { now: later }).length, 1, 'lo stale resta ricercabile (da verificare)');
  }));

  // (b) the second property the user asked to close V0 with.
  test(`[${backend}] a stale inspection never makes the discovery disappear`, () => withMemory(backend, (wm) => {
    const t0 = 1_700_000_000_000;
    wm.rememberContainer({ type: 'chest', position: chest, contents: { iron_ingot: 3 }, observedAt: t0 });

    const old = t0 + 10 * HOUR; // oltre il TTL di inspection (5 min) e di discovery (6 h)
    const [row] = wm.findContainers({ includeStale: true, now: old });
    assert.ok(row, 'la riga c\'è ancora');
    assert.equal(row.discoveryStale, true, 'il *posto* è vecchio');
    assert.equal(row.inspectionStale, true, 'e la misura anche');
    assert.equal(row.status, MEMORY_STATUS.STALE, 'vecchia, non inesistente');

    // Gradino 2: vale la pena riaprirlo, e la query dedicata lo dice.
    assert.equal(wm.containersToInspect({ now: old }).length, 1);
    assert.equal(wm.containersToInspect({ now: old, includeDiscoveryStale: false }).length, 0);
    assert.equal(wm.findContainers({ needsInspection: true, now: old }).length, 1);
  }));

  test(`[${backend}] rung 2 is ordered by distance and can be limited`, () => withMemory(backend, (wm) => {
    const t0 = 1_700_000_000_000;
    for (const [dx, dz] of [[30, 0], [5, 0], [12, 0]]) wm.rememberContainer({ position: { x: dx, y: 64, z: dz }, observedAt: t0 });
    const ordered = wm.containersToInspect({ from: { x: 0, y: 64, z: 0 }, now: t0 });
    assert.deepEqual(ordered.map((c) => c.position.x), [5, 12, 30]);
    assert.deepEqual(wm.containersToInspect({ from: { x: 0, y: 64, z: 0 }, limit: 2, now: t0 }).map((c) => c.position.x), [5, 12]);
  }));

  test(`[${backend}] a row written before the two facts still describes itself`, () => withMemory(backend, (wm) => {
    const t0 = 1_700_000_000_000;
    wm.repo.upsert({
      id: 'container_1_2_3',
      kind: 'container',
      type: 'chest',
      position: { x: 1, y: 2, z: 3 },
      contents: { apple: 1 },
      contentsKnown: true,
      lastSeenAt: t0,
      status: MEMORY_STATUS.KNOWN,
    });
    const view = describeContainer(wm.repo.get('container_1_2_3'), { now: t0 + 10 * MIN });
    assert.equal(view.inspectedAt, t0, 'senza inspectedAt vale l\'ultima lettura');
    assert.equal(view.inspectionStale, true);
    assert.equal(describeContainer(null), null);
    assert.equal(describeContainer({ kind: 'landmark' }), null);
  }));
}
