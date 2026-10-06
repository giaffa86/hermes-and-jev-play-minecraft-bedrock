// Deep Dark / stealth (W0 di docs/raw/DEEP_DARK_ROADMAP.md): vibrazioni sculk,
// shrieker, livello di allarme e verdetto sullo sneak misurato. Modulo puro,
// nessun server. La regola che questi test difendono è che *non sapere* non è
// mai uguale a "silenzioso": uno stato che il registry non espone resta `null`.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VIBRATION_RADIUS, SHRIEK_SUMMON_LEVEL, SHRIEK_WINDOW_MS,
  SCULK_FAMILY, SCULK_SENSORS, SCULK_SHRIEKERS,
  SNEAK_SPEED_FACTOR, SNEAK_SPEED_CEILING_MPS,
  vibrationProfile, isSculkFamily, isSculkSensor, sensorPhase, shriekerState,
  pointSegmentDistance, vibrationRisk, shriekerVerdict, wardenWarning,
  classifySneakSpeed, summarizeSculk,
} from '../bedrock-vibration.mjs';

test('each action declares whether it vibrates, and an unknown action stays unknown', () => {
  assert.equal(vibrationProfile('step').vibrates, true);
  assert.equal(vibrationProfile('break_block').vibrates, true);
  assert.equal(vibrationProfile('place_block').vibrates, true);
  assert.equal(vibrationProfile('sneak').vibrates, false);
  assert.equal(vibrationProfile('idle').vibrates, false);
  assert.equal(vibrationProfile('pickup_item').vibrates, false);
  // Un'azione non censita non è dichiarata silenziosa per sbaglio.
  assert.deepEqual(vibrationProfile('teleport'), { action: 'teleport', vibrates: null });
  assert.deepEqual(vibrationProfile(null), { action: null, vibrates: null });
});

test('sculk family and sensors are named by the same vocabulary as the census', () => {
  assert.ok(SCULK_FAMILY.includes('sculk'));
  assert.ok(SCULK_FAMILY.includes('sculk_vein'));
  assert.ok(SCULK_FAMILY.includes('sculk_catalyst'));
  assert.equal(isSculkFamily('sculk_sensor'), true);
  assert.equal(isSculkFamily('calibrated_sculk_sensor'), true);
  assert.equal(isSculkFamily('deepslate'), false);
  assert.equal(isSculkSensor('sculk_sensor'), true);
  assert.equal(isSculkSensor('calibrated_sculk_sensor'), true);
  assert.equal(isSculkSensor('sculk_shrieker'), false);
  assert.deepEqual(SCULK_SHRIEKERS, ['sculk_shrieker']);
  assert.deepEqual(SCULK_SENSORS, ['sculk_sensor', 'calibrated_sculk_sensor']);
  assert.equal(VIBRATION_RADIUS, 8);
});

test('a sensor phase of 0/1/2 is read, and a missing property stays unknown', () => {
  assert.deepEqual(sensorPhase({ sculk_sensor_phase: 1 }), { phase: 1, active: true });
  assert.deepEqual(sensorPhase({ sculk_sensor_phase: 0 }), { phase: 0, active: false });
  assert.deepEqual(sensorPhase({ sculk_sensor_phase: 2 }), { phase: 2, active: false });
  // Un registry incompleto non deve far sembrare "spento" un sensore.
  assert.deepEqual(sensorPhase({}), { phase: null, active: null });
  assert.deepEqual(sensorPhase(null), { phase: null, active: null });
  assert.deepEqual(sensorPhase({ sculk_sensor_phase: 'nonsense' }), { phase: null, active: null });
});

test('shrieker state exposes can_summon: a player-placed shrieker is inert', () => {
  assert.deepEqual(shriekerState({ active: 1, can_summon: 1 }), { canSummon: true, active: true });
  assert.deepEqual(shriekerState({ active: 0, can_summon: 0 }), { canSummon: false, active: false });
  assert.deepEqual(shriekerState({ active: 1, can_summon: 0 }), { canSummon: false, active: true });
  assert.deepEqual(shriekerState({}), { canSummon: null, active: null });
  assert.deepEqual(shriekerState(null), { canSummon: null, active: null });
});

test('vibration risk counts the sensors inside the sphere and picks the nearest', () => {
  const sensors = [
    { position: { x: 8, y: 0, z: 0 }, name: 'sculk_sensor' },
    { position: { x: 0, y: 4, z: 4 }, name: 'calibrated_sculk_sensor' },
    { position: { x: 20, y: 0, z: 0 }, name: 'sculk_sensor' },
  ];
  const risk = vibrationRisk({ x: 0, y: 0, z: 0 }, sensors);
  assert.equal(risk.count, 2, 'un sensore a 8.0 blocchi sente, uno a 20 no');
  assert.equal(risk.radius, 8);
  assert.deepEqual(risk.nearest.position, { x: 0, y: 4, z: 4 }, 'il più vicino è quello a ~5,66 blocchi');
  assert.equal(risk.sensors.length, 2);
  // Punto ignoto: nessun verdetto, mai un `count: 0` rassicurante.
  assert.equal(vibrationRisk(null, sensors).count, null);
});

test('a sensor just outside the radius is silent, one on the boundary is not', () => {
  const at = x => [{ position: { x, y: 0, z: 0 } }];
  assert.equal(vibrationRisk({ x: 0, y: 0, z: 0 }, at(VIBRATION_RADIUS)).count, 1);
  assert.equal(vibrationRisk({ x: 0, y: 0, z: 0 }, at(VIBRATION_RADIUS + 0.5)).count, 0);
});

test('point-segment distance keeps a whole walking leg in the count', () => {
  // Un tragitto lungo z: il punto conta anche a metà strada, non solo agli estremi.
  const d = pointSegmentDistance({ x: 2, y: 0, z: 5 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 });
  assert.equal(d, 2);
  // Lontano oltre l'estremo vale la distanza dall'estremo (clamp).
  assert.equal(pointSegmentDistance({ x: 0, y: 0, z: 14 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 10 }), 4);
  assert.equal(pointSegmentDistance(null, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }), null);
});

test('standing on a shrieker is blocked even when crouched', () => {
  const shriekers = [{ position: { x: 5, y: 64, z: 5 }, name: 'sculk_shrieker' }];
  const blocked = shriekerVerdict({ x: 5, y: 65, z: 5 }, shriekers);
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.reason, 'standing_on_shrieker');
  assert.deepEqual(shriekerVerdict({ x: 5, y: 66, z: 5 }, shriekers), { blocked: false, shrieker: null, reason: null });
  assert.equal(shriekerVerdict(null, shriekers).blocked, null);
});

test('the warden warning level is clear, warning, then summoned at the threshold', () => {
  assert.deepEqual(wardenWarning(0), { level: 0, threshold: SHRIEK_SUMMON_LEVEL, verdict: 'clear', maySummon: false });
  assert.equal(wardenWarning(1).verdict, 'warning');
  assert.equal(wardenWarning(SHRIEK_SUMMON_LEVEL - 1).maySummon, false);
  const summoned = wardenWarning(SHRIEK_SUMMON_LEVEL);
  assert.equal(summoned.verdict, 'summoned');
  assert.equal(summoned.maySummon, true);
  // Soglia esplicita: la finestra degli shriek è un parametro, non una costante locale.
  assert.equal(wardenWarning(4, { threshold: 5 }).verdict, 'warning');
  assert.equal(wardenWarning(null).verdict, null);
  assert.equal(SHRIEK_WINDOW_MS, 600000);
});

test('the sneak verdict comes from the measured speed, never from the declared flag', () => {
  // 1.3 m/s per 10 s: passo accovacciato.
  const slow = classifySneakSpeed({ distanceM: 13, seconds: 10 });
  assert.equal(slow.ok, true);
  assert.equal(slow.error, null);
  assert.equal(slow.mps, 1.3);
  // 4.317 m/s: il server ha mosso il bot a velocità di cammino anche se il
  // client dichiarava `sneaking` — l'azione deve fallire, non fingere.
  const fast = classifySneakSpeed({ distanceM: 43.17, seconds: 10 });
  assert.equal(fast.ok, false);
  assert.equal(fast.error, 'not_sneaking');
  assert.ok(fast.mps > SNEAK_SPEED_CEILING_MPS);
  // Nessuna misura: nessun verdetto (né successo né fallimento inventati).
  assert.equal(classifySneakSpeed({}).error, 'no_measurement');
  assert.equal(classifySneakSpeed({ distanceM: 5, seconds: 0 }).ok, null);
  assert.equal(classifySneakSpeed({ distanceM: 0, seconds: 10 }).error, 'no_measurement', 'nessun passo reale: nessun verdetto');
  assert.ok(SNEAK_SPEED_FACTOR < 1);
});

test('the census summary counts inert and active shriekers separately', () => {
  const summary = summarizeSculk({
    sensors: [{ position: { x: 3, y: 64, z: 0 }, distance: 3 }, { position: { x: 30, y: 64, z: 0 }, distance: 30 }],
    shriekers: [
      { position: { x: 4, y: 64, z: 4 }, canSummon: true, active: false },
      { position: { x: 5, y: 64, z: 5 }, canSummon: true, active: true },
      { position: { x: 6, y: 64, z: 6 }, canSummon: false, active: false },
    ],
    blocks: [{ name: 'sculk' }, { name: 'sculk_vein' }],
    point: { x: 0, y: 64, z: 0 },
  });
  assert.equal(summary.sensors, 2);
  assert.equal(summary.shriekers, 3);
  assert.equal(summary.shriekersCanSummon, 2);
  assert.equal(summary.shriekersActive, 1);
  assert.equal(summary.sculkBlocks, 2);
  assert.equal(summary.nearestSensor.distance, 3);
  assert.equal(summary.vibrationRisk.count, 1, 'solo il sensore a 3 blocchi è nel raggio');
  // Senza punto non si calcola un rischio: `null`, non zero.
  assert.equal(summarizeSculk({ sensors: [], shriekers: [], blocks: [] }).vibrationRisk, null);
});
