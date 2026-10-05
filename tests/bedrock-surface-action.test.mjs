import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

// M2 — respirare. Il bot non nuota: con la testa sott'acqua l'unica cura e'
// uscire dall'acqua, cioe' camminare sul fondo o sulla riva dove la testa
// esce. Prima di questa patch il governor sapeva dichiarare `drowning` ma il
// harness non offriva nessuna azione con intento `surface`: la regola restava
// lettera morta. Questi test fissano l'azione e il suo rifiuto tipizzato.

function wetAdapter ({ air = 80, waterBreathing = { active: false }, shoreline = true } = {}) {
  const events = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: entry => events.push(entry) });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.client = { queue () {} };
  adapter.inventory = {};
  adapter.nearbyBlocks = {};
  adapter.position = { x: 0.5, y: 72.62, z: 0.5 };
  adapter._feet = { x: 0.5, y: 71, z: 0.5 };
  adapter.air = air;
  // Tutte le celle sono acqua tranne la testa della riva in (2, 71, 0).
  adapter._fluidKindAt = (x, y) => (shoreline && x === 2 && y === 71 ? 'air' : 'water');
  adapter._waterBreathing = () => waterBreathing;
  adapter._reachabilityUsable = () => false;
  adapter._standableNear = (point) => (shoreline && point.x > 1.2 ? { x: 2.5, y: 70, z: 0.5 } : null);
  let wet = true;
  const state = {
    adapter,
    events,
    get wet () { return wet; },
    keepWet () { wet = true; },
  };
  adapter._headInWater = () => wet;
  adapter._moveTo = async (target) => {
    adapter._feet = { x: target.x, y: target.y, z: target.z };
    wet = false;
    return { ok: true, distance: 0.5, pathNodes: 1 };
  };
  return state;
}

test('l opzione surface compare solo con la testa sott acqua e l aria che scende', () => {
  const low = wetAdapter({ air: 80 });
  assert.ok(low.adapter.options().some(option => option.key === 'surface'), 'con 4 s di aria serve un azione per risalire');

  const full = wetAdapter({ air: 299 });
  assert.ok(!full.adapter.options().some(option => option.key === 'surface'), 'con l aria piena non si disturba il piano');

  const held = wetAdapter({ air: 20, waterBreathing: { active: true } });
  assert.ok(!held.adapter.options().some(option => option.key === 'surface'), 'elmo di tartaruga o effetto attivo: non c e nulla da risalire');
});

test('_shoreCell trova la cella dove la testa non e sott acqua', () => {
  const { adapter } = wetAdapter();
  const shore = adapter._shoreCell();
  assert.equal(shore.x, 2.5);
  assert.equal(shore.y, 70);
  assert.equal(shore.distance, 2, 'distanza orizzontale dal bot');
});

test('senza nessuna riva il rifiuto e tipizzato e non finge un successo', async () => {
  const { adapter } = wetAdapter({ shoreline: false });
  assert.equal(adapter._shoreCell(), null);
  const result = await adapter._surfaceFromWater();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'no_shore');
});

test('_surfaceFromWater cammina fino alla riva e lo verifica col respiro', async () => {
  const state = wetAdapter();
  const result = await state.adapter._surfaceFromWater();
  assert.equal(result.ok, true);
  assert.equal(result.surfaced, true);
  assert.equal(result.air, 80, 'aria prima e dopo: la risalita non la consuma oltre il tempo che ci mette');
  assert.equal(state.wet, false, 'la testa e fuori dall acqua');
  const logged = state.events.filter(entry => entry.type === 'surface');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].surfaced, true);
});

test('arrivare a riva non basta: se la testa e ancora in acqua lo dice', async () => {
  const state = wetAdapter();
  state.adapter._moveTo = async () => ({ ok: true, distance: 0 });
  const result = await state.adapter._surfaceFromWater();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'still_underwater');
  assert.equal(result.surfaced, false);
  assert.equal(state.adapter._surfaceLast.error, 'still_underwater');
});

test('l azione e raggiungibile dal dispatch e ha un rifiuto per chi la chiama a sproposito', () => {
  const src = readFileSync(new URL('../bedrock-adapter.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/key === 'surface'/g) || []).length, 2, 'un ramo di esecuzione e un fallback tipizzato');
  assert.match(src, /_surfaceFromWater \(/);
});
