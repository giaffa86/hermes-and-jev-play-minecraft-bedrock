// Meteo e sonno diurno nell'adapter Bedrock.
//
// Vanilla: si dorme quando la sky light è ≤ 11 — di notte, oppure *a qualunque
// ora* durante un temporale (la sola pioggia allarga la finestra notturna ma
// non la apre di giorno). Messaggio BDS: "You can only sleep at night or during
// thunderstorms". Fonte: https://minecraft.wiki/w/Bed
//
// Il server annuncia il meteo con i level_event 3001 start_rain, 3002
// start_thunder, 3003 stop_rain, 3004 stop_thunder. Il bot li traduce in
// `_weather` e da lì in `_isSleepTime()` (notte OR temporale).

import test from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

function dayAdapter ({ dimension = 'overworld', beds = [{ x: 0, y: 63, z: 2 }] } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.logs = [];
  adapter.onLog = entry => adapter.logs.push(entry);
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.dimension = dimension;
  adapter.position = { x: 0, y: 64.62, z: 0 };
  adapter._feet = { x: 0, y: 63, z: 0 };
  adapter.nearbyBlocks = {};
  adapter.inventory = {};
  adapter.standingOn = 'stone';
  adapter.entities = new Map();
  adapter.world.loaded = new Map([['0,0', {}]]);
  adapter._recordTime(6000); // pieno giorno
  adapter.world.blockAt = ({ x, y, z }) => {
    if (beds.some(b => b.x === x && b.y === y && b.z === z)) return { name: 'bed', boundingBox: 'empty', shapes: [[0, 0, 0, 1, 0.5625, 1]], position: { x, y, z }, getProperties: () => ({ occupied_bit: false, head_piece_bit: false }) };
    return y === 62 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  };
  adapter.world.findBlocks = (name) => (name === 'bed'
    ? beds.map((position, index) => ({ name: 'bed', position, distance: 2 + index, getProperties: () => ({ occupied_bit: false, head_piece_bit: false }) }))
    : []);
  adapter._bedCache = null;
  return adapter;
}

test('a thunderstorm is tracked from both level_event names and numeric ids', () => {
  const adapter = dayAdapter();
  assert.deepEqual({ ...adapter._weather, at: 0 }, { rain: false, thunder: false, at: 0 });

  adapter._onLevelEvent({ event: 'start_rain' });
  assert.equal(adapter._weather.rain, true);
  assert.equal(adapter._weather.thunder, false, 'la pioggia da sola non è un temporale');

  adapter._onLevelEvent({ event: 'start_thunder' });
  assert.equal(adapter._weather.rain, true, 'un temporale implica la pioggia');
  assert.equal(adapter._weather.thunder, true);

  adapter._onLevelEvent({ event: 'stop_thunder' });
  assert.equal(adapter._weather.rain, true, 'dopo il temporale può restare la pioggia');
  assert.equal(adapter._weather.thunder, false);

  adapter._onLevelEvent({ event_id: 3002 });
  assert.equal(adapter._weather.thunder, true, 'i pacchetti generici portano solo l\'id numerico');

  adapter._onLevelEvent({ event_id: 3003 });
  assert.equal(adapter._weather.rain, false, 'la fine della pioggia chiude anche il temporale');
  assert.equal(adapter._weather.thunder, false);
  assert.ok(adapter.logs.some(entry => entry.type === 'weather_change'), 'ogni cambiamento finisce nel log');
});

test('an unrelated level_event does not touch the weather', () => {
  const adapter = dayAdapter();
  adapter._onLevelEvent({ event_id: 3003 });
  assert.equal(adapter.logs.length, 0, 'un level_event già a zero non logga nulla');
  adapter._onLevelEvent({ event_id: 9800 }); // players_sleeping
  assert.equal(adapter._weather.rain, false);
  assert.equal(adapter._weather.thunder, false);
  assert.equal(adapter.logs.at(-1).type, 'sleep_level_event');
});

test('_timeInfo exposes rain and thunder next to the clock', () => {
  const adapter = dayAdapter();
  assert.deepEqual(adapter._timeInfo().phase, 'day');
  assert.equal(adapter._timeInfo().rain, false);
  assert.equal(adapter._timeInfo().thunder, false);
  adapter._onLevelEvent({ event: 'start_thunder' });
  assert.equal(adapter._timeInfo().night, false, 'il temporale non cambia l\'ora');
  assert.equal(adapter._timeInfo().thunder, true);
  assert.equal(adapter._timeInfo().rain, true);
});

test('a daytime thunderstorm makes sleep a valid time and offers the bed', () => {
  const adapter = dayAdapter();
  assert.equal(adapter._isSleepTime(), false);
  adapter._onLevelEvent({ event: 'start_thunder' });
  assert.equal(adapter._isNight(), false, 'è pieno giorno');
  assert.equal(adapter._isSleepTime(), true);

  const sleep = adapter.options().find(option => option.key === 'sleep');
  assert.ok(sleep, 'di giorno, ma col temporale, il letto va offerto');
  assert.match(sleep.description, /thunderstorm/);

  adapter._onLevelEvent({ event: 'stop_thunder' });
  adapter._onLevelEvent({ event: 'stop_rain' });
  assert.equal(adapter._isSleepTime(), false);
  assert.equal(adapter.options().some(option => option.key === 'sleep'), false);
});

test('_sleepInBed accepts the daytime thunderstorm but still refuses plain daylight', async () => {
  const clear = dayAdapter();
  const refused = await clear._sleepInBed();
  assert.equal(refused.error, 'not_night');
  assert.equal(refused.ok, false);

  const storm = dayAdapter();
  storm._onLevelEvent({ event: 'start_thunder' });
  let attempts = 0;
  storm._trySleepInBed = async bed => { attempts++; return { ok: true, skipped: 'night', bed: bed.position }; };
  const ok = await storm._sleepInBed({ confirmMs: 10 });
  assert.equal(ok.ok, true, 'il gate non è più solo la notte');
  assert.equal(attempts, 1);
});

test('the nether still refuses a thunderstorm: the bed would explode', async () => {
  const adapter = dayAdapter({ dimension: 'nether' });
  adapter._onLevelEvent({ event: 'start_thunder' });
  assert.equal(adapter._isSleepTime(), true);
  assert.equal(adapter.options().some(option => option.key === 'sleep'), false, 'nel Nether l\'opzione non va offerta');
  const result = await adapter._sleepInBed();
  assert.equal(result.error, 'beds_explode_here');
  assert.equal(result.dimension, 'nether');
});
