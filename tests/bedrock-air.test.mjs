// Aria (M1 di docs/wiki/fluids.md): contatore puro e deterministico. Il server
// non espone il budget d'aria, quindi lo simula l'adapter col modello vanilla.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_AIR, AIR_RECOVER_PER_TICK, airStep, airSeconds, AirMeter } from '../bedrock-air.mjs';

test('sott\'acqua l\'aria scende di un tick per tick e non va sotto zero', () => {
  assert.equal(airStep(MAX_AIR, { headInWater: true }), MAX_AIR - 1);
  assert.equal(airStep(1, { headInWater: true }), 0);
  assert.equal(airStep(0, { headInWater: true }), 0);
  assert.equal(airStep(200, { headInWater: true, ticks: 3 }), 197);
  assert.equal(airStep(300, { headInWater: true, ticks: 300 }), 0);
});

test('fuori dall\'acqua si recupera in fretta e non si supera il massimo', () => {
  assert.equal(airStep(100, {}), 100 + AIR_RECOVER_PER_TICK);
  assert.equal(airStep(MAX_AIR, {}), MAX_AIR);
  assert.equal(airStep(MAX_AIR - 1, {}), MAX_AIR);
  assert.equal(airStep(0, { ticks: 2 }), 2 * AIR_RECOVER_PER_TICK);
});

test('valori malformati non fanno esplodere il contatore', () => {
  assert.equal(airStep(null, { headInWater: true }), MAX_AIR - 1, 'aria ignota ⇒ piena');
  assert.equal(airStep(Number.NaN, {}), MAX_AIR);
  assert.equal(airStep(100, { ticks: 0 }), 100 + AIR_RECOVER_PER_TICK, 'zero tick vale un tick');
  assert.equal(airStep(100, { ticks: -5 }), 100 + AIR_RECOVER_PER_TICK);
});

test('airSeconds converte i tick in secondi di gioco', () => {
  assert.equal(airSeconds(MAX_AIR), 15);
  assert.equal(airSeconds(0), 0);
  assert.equal(airSeconds(10), 0.5);
  assert.equal(airSeconds(null), 15);
});

test('AirMeter tiene il contatore e accetta la verità del server', () => {
  const meter = new AirMeter();
  assert.equal(meter.value, MAX_AIR);
  assert.equal(meter.fraction, 1);
  meter.update({ headInWater: true, ticks: 60 });
  assert.equal(meter.value, MAX_AIR - 60);
  assert.ok(Math.abs(meter.fraction - 0.8) < 1e-9);
  meter.update({ ticks: 20 });
  assert.equal(meter.value, MAX_AIR, '20 tick di recupero saturano il contatore');
  meter.set(120);
  meter.update({ ticks: 20 });
  assert.equal(meter.value, 120 + 20 * AIR_RECOVER_PER_TICK);
  meter.set(500);
  assert.equal(meter.value, MAX_AIR, 'il contatore non supera il massimo');
  meter.set(-3);
  assert.equal(meter.value, 0);
  meter.set(Number.NaN);
  assert.equal(meter.value, 0, 'un valore non numerico viene ignorato');
});
