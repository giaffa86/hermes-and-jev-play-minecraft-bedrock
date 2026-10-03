// Endgame (N7 di docs/wiki/nether.md): telai del portale dell'End, piano degli
// occhi, lettura del lancio, triangolazione della stronghold e verdetto sul
// drago. Modulo puro, nessun server.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  END_PORTAL_FRAME, END_PORTAL, EYE_OF_ENDER, EYE_SIGNAL_ENTITY,
  ENDER_EYE_FRAME_TOTAL, STRONGHOLD_RADIUS, EYE_READING_MIN_SPAN, EYE_PARALLEL_DEG,
  EYE_READING_MAX_AGE_MS, POWDER_PER_ROD,
  isEyeSignalType, frameHasEye, frameStatus, eyesNeeded, eyeCraftPlan, eyeReading,
  readingAge, triangulateStronghold, endGate, bossVerdict, endSummary,
} from '../bedrock-end.mjs';

const frame = (x, z, eye = null) => ({ position: { x, y: 64, z }, hasEye: eye });

test('frameHasEye reads the end_portal_eye_bit of a Bedrock frame', () => {
  assert.equal(frameHasEye({ getProperties: () => ({ end_portal_eye_bit: { type: 'byte', value: 1 } }) }), true);
  assert.equal(frameHasEye({ _properties: { end_portal_eye_bit: 0 } }), false);
  assert.equal(frameHasEye({ properties: { has_eye: '1' } }), true);
  assert.equal(frameHasEye({ properties: { has_eye: false } }), false);
  // Uno stato che non si legge non è un telaio vuoto.
  assert.equal(frameHasEye({}), null);
  assert.equal(frameHasEye(null), null);
  assert.equal(frameHasEye({ properties: { end_portal_eye_bit: 'nonsense' } }), null);
});

test('frameStatus counts filled, empty and unreadable frames, and picks the nearest', () => {
  const from = { x: 0, y: 64, z: 0 };
  const status = frameStatus({
    frames: [frame(10, 0, true), frame(20, 0, false), frame(30, 0, null), frame(40, 0, true)],
    from,
  });
  assert.equal(status.total, 4);
  assert.equal(status.filled, 2);
  assert.equal(status.empty, 1);
  assert.equal(status.unknown, 1);
  assert.equal(status.missing, 1);
  assert.equal(status.complete, false);
  assert.deepEqual(status.nearest.position, { x: 10, y: 64, z: 0 });
  assert.equal(status.nearest.distance, 10);
  assert.deepEqual(status.rows.map(r => r.distance), [10, 20, 30, 40]);
});

test('a frame with only unreadable states is never "complete"', () => {
  const status = frameStatus({ frames: [frame(1, 1, null), frame(2, 1, null)] });
  assert.equal(status.missing, 0);
  assert.equal(status.unknown, 2);
  assert.equal(status.complete, false);
});

test('frameStatus accepts blocks and reads them itself', () => {
  const status = frameStatus({
    frames: [
      { position: { x: 1, y: 64, z: 1 }, getProperties: () => ({ end_portal_eye_bit: 1 }) },
      { position: { x: 2, y: 64, z: 1 }, getProperties: () => ({ end_portal_eye_bit: 0 }) },
    ],
  });
  assert.equal(status.filled, 1);
  assert.equal(status.empty, 1);
  assert.equal(status.complete, false);
  assert.deepEqual(frameStatus({ frames: [ { position: { x: 1, y: 64, z: 1 }, getProperties: () => ({ end_portal_eye_bit: 1 }) } ] }).complete, true);
});

test('eyesNeeded counts the missing eyes out of twelve', () => {
  assert.equal(eyesNeeded({ filled: 0 }), ENDER_EYE_FRAME_TOTAL);
  assert.equal(eyesNeeded({ filled: 7 }), 5);
  assert.equal(eyesNeeded({ filled: 12 }), 0);
  assert.equal(eyesNeeded({ filled: 13 }), 0);
});

test('eyeCraftPlan says what is missing and what a rod can turn into', () => {
  const empty = eyeCraftPlan({});
  assert.equal(empty.craftable, 0);
  assert.equal(empty.missingPearls, 12);
  assert.equal(empty.missingPowder, 12);
  assert.equal(empty.rodsNeeded, 6);
  assert.equal(empty.done, false);

  // 3 bacchette → 6 polveri; 6 perle → si crafta fino alle perle.
  const half = eyeCraftPlan({ rods: 3, pearls: 6 });
  assert.equal(half.powderFromRods, 6);
  assert.equal(half.powderShort, 12);
  assert.equal(half.missingPowder, 6);
  assert.equal(half.missingPearls, 6);
  assert.equal(half.craftable, 0);

  const ready = eyeCraftPlan({ powder: 12, pearls: 12 });
  assert.equal(ready.craftable, 12);
  assert.equal(ready.done, true);
  assert.equal(ready.missingPowder, 0);
  assert.equal(ready.missingPearls, 0);
  assert.equal(ready.rodsNeeded, 0);

  // Non serve più di `wanted`: il piano non gonfia la richiesta.
  assert.equal(eyeCraftPlan({ powder: 30, pearls: 30, wanted: 3 }).craftable, 3);
  assert.equal(POWDER_PER_ROD, 2);
});

test('eyeReading turns the flight sample into a direction and a Bedrock yaw', () => {
  // Verso +z: yaw 0.
  const north = eyeReading({ origin: { x: 0, y: 64, z: 0 }, sample: { x: 0, y: 65, z: 10 }, at: 1000 });
  assert.equal(north.yaw, 0);
  assert.deepEqual(north.direction, { x: 0, z: 1 });
  assert.equal(readingAge(north, 1500), 500);
  // Verso -x: yaw 90 (convenzione del client).
  const east = eyeReading({ origin: { x: 0, y: 64, z: 0 }, sample: { x: -10, y: 65, z: 0 } });
  assert.equal(east.yaw, 90);
  // Un occhio che si rompe subito non indica niente.
  assert.equal(eyeReading({ origin: { x: 0, y: 64, z: 0 }, sample: { x: 0.1, y: 64, z: 0.1 } }), null);
  assert.equal(eyeReading({ origin: null, sample: { x: 1, y: 1, z: 1 } }), null);
  assert.equal(readingAge({ at: null }, 10), null);
});

test('triangulateStronghold intersects two rays and refuses what it cannot know', () => {
  assert.equal(triangulateStronghold({ first: eyeReading({ origin: { x: 0, y: 64, z: 0 }, sample: { x: 0, y: 64, z: 10 } }) }).error, 'missing_readings');

  const first = eyeReading({ origin: { x: 0, y: 64, z: 0 }, sample: { x: 0.4, y: 64, z: 40 } });
  const second = eyeReading({ origin: { x: 40, y: 64, z: 0 }, sample: { x: 20.4, y: 64, z: 40 } });
  const hit = triangulateStronghold({ first, second });
  assert.equal(hit.ok, true);
  // I due raggi si incontrano avanti a entrambi i lanci: il numero che conta è
  // che la stima esista e che l'angolo fra i raggi non sia degenere.
  assert.ok(hit.distance > 0);
  assert.ok(hit.angle > EYE_PARALLEL_DEG);

  // Due lanci troppo vicini: la direzione la stimiamo dai primi metri, quindi
  // l'incrocio sarebbe dominato dall'errore.
  const close = eyeReading({ origin: { x: 2, y: 64, z: 0 }, sample: { x: 2.4, y: 64, z: 40 } });
  const tooClose = triangulateStronghold({ first, second: close });
  assert.equal(tooClose.ok, false);
  assert.equal(tooClose.error, 'readings_too_close');
  assert.ok(tooClose.span < EYE_READING_MIN_SPAN);

  // Raggi paralleli: nessuna informazione sull'intersezione.
  const parallel = eyeReading({ origin: { x: 40, y: 64, z: 3 }, sample: { x: 40.4, y: 64, z: 43 } });
  const rays = triangulateStronghold({ first, second: parallel });
  assert.equal(rays.ok, false);
  assert.equal(rays.error, 'parallel_rays');

  // Raggi che si incontrano *dietro* ai lanci: letture incoerenti.
  const behind = eyeReading({ origin: { x: 40, y: 64, z: 0 }, sample: { x: 60.4, y: 64, z: 40 } });
  assert.equal(triangulateStronghold({ first, second: behind }).error, 'no_intersection');

  // Una lettura vecchia non descrive più dove sta andando l'occhio.
  const stale = triangulateStronghold({ first: { ...first, at: 0 }, second, now: EYE_READING_MAX_AGE_MS + 1 });
  assert.equal(stale.error, 'stale_reading');
  assert.equal(triangulateStronghold({ first: { origin: { x: 0, y: 0, z: 0 } }, second, now: 1 }).error, 'invalid_reading');
});

test('triangulateStronghold points at the eye direction, not at the throw origin', () => {
  // Due lanci che indicano la stessa meta: l'incrocio è la meta, non l'origine.
  const sample = (origin, target, step = 50) => {
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const len = Math.hypot(dx, dz);
    return { x: origin.x + dx / len * step, y: origin.y, z: origin.z + dz / len * step };
  };
  const target = { x: 200, z: 300 };
  const fromA = { x: 0, y: 64, z: 0 };
  const fromB = { x: 100, y: 64, z: 0 };
  const first = eyeReading({ origin: fromA, sample: sample(fromA, target) });
  const second = eyeReading({ origin: fromB, sample: sample(fromB, target) });
  const hit = triangulateStronghold({ first, second });
  assert.equal(hit.ok, true);
  assert.equal(Math.round(hit.position.x), target.x);
  assert.equal(Math.round(hit.position.z), target.z);
  assert.equal(Math.round(hit.distance), Math.round(Math.hypot(target.x - fromA.x, target.z - fromA.z)));
  assert.deepEqual(hit.from, { x: 0, z: 0 });
});

test('endGate is ready only when the frame is complete and reports the dimension', () => {
  const open = frameStatus({ frames: [frame(1, 1, false), frame(2, 1, false)] });
  assert.deepEqual(endGate({ frames: open, dimension: 'overworld' }), { inEnd: false, ready: false, missing: 2, total: 2 });
  const closed = frameStatus({ frames: [frame(1, 1, true), frame(2, 1, true)] });
  assert.deepEqual(endGate({ frames: closed, dimension: 'the_end' }), { inEnd: true, ready: true, missing: 0, total: 2 });
  assert.equal(endGate({}).ready, false);
});

test('bossVerdict needs the whole bar cycle of a real server signal', () => {
  assert.deepEqual(bossVerdict({}), { defeated: false, reason: 'no_boss_bar', shownAt: null, hiddenAt: null });
  assert.equal(bossVerdict({ shown: true }).reason, 'boss_bar_visible');
  assert.equal(bossVerdict({ shown: true, hidden: true, shownAt: 20, hiddenAt: 10 }).reason, 'hidden_before_shown');
  const done = bossVerdict({ shown: true, hidden: true, shownAt: 10, hiddenAt: 20 });
  assert.equal(done.defeated, true);
  assert.equal(done.reason, 'bar_shown_then_hidden');
  // Senza timestamp non si può dire che il ciclo sia avvenuto nell'ordine giusto:
  // qui è il server a garantirlo, e il verdetto resta affermativo.
  assert.equal(bossVerdict({ shown: true, hidden: true }).defeated, true);
});

test('endSummary is a bounded projection for /observe', () => {
  const summary = endSummary({
    frames: frameStatus({ frames: [frame(1, 1, true), frame(2, 1, false)] }),
    craft: eyeCraftPlan({ powder: 1, pearls: 2 }),
    readings: 2,
    stronghold: triangulateStronghold({
      first: eyeReading({ origin: { x: 0, y: 64, z: 0 }, sample: { x: 0, y: 64, z: 40 } }),
      second: eyeReading({ origin: { x: 40, y: 64, z: 0 }, sample: { x: 20, y: 64, z: 40 } }),
    }),
    boss: bossVerdict({ shown: true }),
  });
  assert.deepEqual(summary.frames, { total: 2, filled: 1, missing: 1, unknown: 0 });
  assert.equal(summary.eyes.craftable, 1);
  assert.equal(summary.readings, 2);
  assert.equal(typeof summary.stronghold.distance, 'number');
  assert.equal(summary.boss.reason, 'boss_bar_visible');
  assert.deepEqual(endSummary({ stronghold: { ok: false, error: 'parallel_rays' } }).stronghold, { error: 'parallel_rays' });
});

test('the module names the blocks and the entity the server actually uses', () => {
  assert.equal(END_PORTAL_FRAME, 'end_portal_frame');
  assert.equal(END_PORTAL, 'end_portal');
  assert.equal(EYE_OF_ENDER, 'ender_eye');
  assert.equal(EYE_SIGNAL_ENTITY, 'eye_of_ender_signal');
  assert.equal(isEyeSignalType('eye_of_ender_signal'), true);
  assert.equal(isEyeSignalType('minecraft:eye_of_ender_signal'), true);
  assert.equal(isEyeSignalType('ender_pearl'), false);
  assert.equal(STRONGHOLD_RADIUS, 24);
});
