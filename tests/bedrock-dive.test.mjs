// M2 di docs/wiki/fluids.md: respirare e gestire una discesa controllata.
// Modulo puro: nessun mondo, nessun socket. I numeri del budget sono quelli che
// il percorso di scavo e la raccolta usano davvero, quindi vanno fissati qui.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEffectName, waterBreathingSources, divePlan, underwaterWork,
  WATER_BREATHING_EFFECT, TURTLE_HELMET, CONDUIT_BLOCK,
  DIVE_RESERVE_SECONDS, DIVE_DESCENT_SECONDS_PER_BLOCK, DIVE_ASCENT_SECONDS_PER_BLOCK,
} from '../bedrock-dive.mjs';

test('normalizeEffectName porta i nomi del registry al vocabolario', () => {
  assert.equal(normalizeEffectName('WaterBreathing'), WATER_BREATHING_EFFECT);
  assert.equal(normalizeEffectName('water_breathing'), WATER_BREATHING_EFFECT);
  assert.equal(normalizeEffectName('NightVision'), 'night_vision');
  assert.equal(normalizeEffectName(null), '');
  assert.equal(CONDUIT_BLOCK, 'conduit');
});

test('waterBreathingSources riconosce elmo di tartaruga ed effetto, e non inventa i conduit', () => {
  const none = waterBreathingSources({});
  assert.equal(none.active, false);
  assert.deepEqual(none.sources, []);
  assert.equal(none.conduitsNear, 0);

  const helmetName = waterBreathingSources({ armor: { helmet: TURTLE_HELMET } });
  assert.equal(helmetName.active, true);
  assert.deepEqual(helmetName.sources, [{ kind: 'armor', name: TURTLE_HELMET }]);
  assert.equal(waterBreathingSources({ armor: 'turtle_helmet' }).active, true, 'forma stringa');
  assert.equal(waterBreathingSources({ armor: { helmet: 'iron_helmet' } }).active, false);

  const effect = waterBreathingSources({ effects: [{ name: 'WaterBreathing', duration: 600, amplifier: 0 }] });
  assert.equal(effect.active, true);
  assert.equal(effect.sources[0].kind, 'effect');
  assert.equal(effect.sources[0].seconds, 30, 'duration è in tick: 600 tick = 30 s');
  assert.equal(waterBreathingSources({ effects: [{ name: 'WaterBreathing', duration: -1 }] }).sources[0].seconds, 'infinite');
  assert.equal(waterBreathingSources({ effects: [{ name: 'WaterBreathing', duration: 0 }] }).active, false, 'effetto scaduto');
  assert.equal(waterBreathingSources({ effects: [{ name: 'night_vision', duration: 600 }] }).active, false);

  // Un conduit vicino resta un indizio: l'attivazione (prisma d'acqua validato
  // dal server) non è verificabile, e dichiararla attiva sarebbe una sicurezza
  // inventata.
  const conduits = waterBreathingSources({ conduits: [{ x: 1, y: 60, z: 1 }] });
  assert.equal(conduits.active, false);
  assert.equal(conduits.conduitsNear, 1);
});

test('divePlan rifiuta ciò che non sta nel budget, con numeri leggibili', () => {
  assert.deepEqual(divePlan({ air: 300, depth: 0 }), {
    ok: false, error: 'no_water', depth: 0, descentSeconds: 0, ascentSeconds: 0, reserveSeconds: DIVE_RESERVE_SECONDS,
  });
  assert.equal(divePlan({ air: null, depth: 5 }).error, 'unknown_air');
  // 5 blocchi: discesa 3 s, risalita 3.5 s (roundtrip 6.5). Con 300 tick (15 s) e
  // 3 s di riserva il budget è 12 s: 5.5 s di lavoro, non un secondo in più.
  const tight = divePlan({ air: 300, depth: 5, workSeconds: 6 });
  assert.equal(tight.error, 'work_too_long');
  assert.equal(tight.maxWorkSeconds, 5.5);
  assert.equal(tight.roundTrip ?? tight.descentSeconds + tight.ascentSeconds, 6.5);
  assert.equal(tight.abortAtSeconds, 8.5, 'budget meno la risalita');

  const ok = divePlan({ air: 300, depth: 5, workSeconds: 5 });
  assert.equal(ok.ok, true);
  assert.equal(ok.held, false);
  assert.equal(ok.airSeconds, 15);
  assert.equal(ok.budgetSeconds, 12);
  assert.equal(ok.totalSeconds, 11.5);

  // Aria troppo poca nemmeno per andare e tornare: non si scende.
  const low = divePlan({ air: 100, depth: 5 });
  assert.equal(low.error, 'air_too_low');
  assert.equal(low.maxWorkSeconds, 0);
  assert.equal(low.abortAtSeconds, null, 'non c\'è una discesa da interrompere');
  assert.equal(DIVE_DESCENT_SECONDS_PER_BLOCK, 0.6);
  assert.equal(DIVE_ASCENT_SECONDS_PER_BLOCK, 0.7);
});

test('divePlan con il respiro attivo non ha budget da spendere', () => {
  const held = divePlan({ air: 5, depth: 20, workSeconds: 60, waterBreathing: true });
  assert.equal(held.ok, true);
  assert.equal(held.held, true);
  assert.equal(held.reason, 'water_breathing');
  assert.equal(held.budgetSeconds, null);
  assert.equal(held.maxWorkSeconds, null);
  assert.equal(held.totalSeconds, 12 + 60 + 14);
});

test('underwaterWork decide solo quando la testa è sotto', () => {
  assert.deepEqual(underwaterWork({}), { allowed: true, reason: 'head_above_water', plan: null });
  assert.equal(underwaterWork({ headInWater: true, inWater: false }).allowed, true);

  const dryBudget = underwaterWork({ inWater: true, headInWater: true, depth: 3, air: 300, workSeconds: 3 });
  assert.equal(dryBudget.allowed, true);
  assert.equal(dryBudget.reason, 'budget_ok');
  assert.equal(dryBudget.plan.ok, true);

  const refused = underwaterWork({ inWater: true, headInWater: true, depth: 3, air: 40, workSeconds: 3 });
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, 'air_too_low');
  assert.equal(refused.plan.error, 'air_too_low');

  const breathed = underwaterWork({ inWater: true, headInWater: true, depth: 30, air: 1, workSeconds: 30, waterBreathing: true });
  assert.equal(breathed.allowed, true);
  assert.equal(breathed.reason, 'water_breathing');
});
