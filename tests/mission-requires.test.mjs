// M14 — i requisiti di missione: «minato», non «trovato in un baule».
//
// La regressione che questi test difendono e' precisa: la spedizione diamanti
// dell'08-09/10/2026 e' stata chiusa tre volte in nove passi da un `take_diamond`
// dal doppio baule del villaggio, perche' il goal chiudeva sull'inventario e il
// harness offriva la chiave di prelievo per un target che stava in uno scrigno.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {
  parseMissionRequirements, requirementTakeKeys, isProducingKey, producedGrowth,
  depositedStacks, missionRequirementsState, missionRequirementsMet, renderRequirements, addCounts,
  PRODUCING_KEY_PREFIXES, parseForbiddenKeys,
} from '../mission-requires.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('un requisito assente non cambia niente', () => {
  for (const value of [undefined, null, '', '  ', 'off', 'none']) {
    assert.deepEqual(parseMissionRequirements(value), {});
  }
  assert.deepEqual(requirementTakeKeys({}), []);
  assert.equal(missionRequirementsMet({mined: {}, deposited: {}}, {mustMine: {}, mustDeposit: {}}), true);
});

test('MUST_MINE accetta item, item:n e liste', () => {
  assert.deepEqual(parseMissionRequirements('diamond'), {diamond: 1});
  assert.deepEqual(parseMissionRequirements('diamond:2'), {diamond: 2});
  assert.deepEqual(parseMissionRequirements('diamond:2, iron_ingot'), {diamond: 2, iron_ingot: 1});
  assert.deepEqual(parseMissionRequirements(' diamond:2 , , '), {diamond: 2});
  assert.deepEqual(parseMissionRequirements('DIAMOND:2'), {diamond: 2});
  assert.deepEqual(parseMissionRequirements('diamond:1,diamond:1'), {diamond: 2});
});

test('un requisito malformato e\u2019 un errore, non un silenzio', () => {
  for (const bad of ['diamond:0', 'diamond:-1', 'diamond:x', 'diamond:1.5', 'diamond:2:3', '!!', 'diamond ore']) {
    assert.throws(() => parseMissionRequirements(bad), /must_mine_invalid/, `dovrebbe rifiutare ${bad}`);
  }
});

test('la chiave di prelievo dell\u2019oggetto da minare si ricava dal requisito', () => {
  assert.deepEqual(requirementTakeKeys({diamond: 2}), ['take_diamond']);
  assert.deepEqual(requirementTakeKeys({diamond: 2, iron_ingot: 1}), ['take_diamond', 'take_iron_ingot']);
});

test('solo le chiavi che scavano o raccolgono possono produrre l\u2019oggetto', () => {
  for (const prefix of PRODUCING_KEY_PREFIXES) assert.equal(isProducingKey(`${prefix}x`), true);
  assert.equal(isProducingKey('take_diamond'), false);
  assert.equal(isProducingKey('deposit_diamond'), false);
  assert.equal(isProducingKey('goto_waypoint'), false);
  assert.equal(isProducingKey(undefined), false);
});

test('il credito e\u2019 la crescita dell\u2019inventario, non la chiave', () => {
  const before = {diamond: 0, cobblestone: 75, iron_pickaxe: 2};
  const after = {diamond: 2, cobblestone: 79, iron_pickaxe: 1};
  assert.deepEqual(producedGrowth(before, after, {diamond: 2}), {diamond: 2});
  // Niente crescita (drop perso in lava, o furto): nessun credito.
  assert.deepEqual(producedGrowth(before, before, {diamond: 2}), {});
  assert.deepEqual(producedGrowth({diamond: 4}, {diamond: 3}, {diamond: 2}), {});
  // Un oggetto non richiesto non entra nel conto.
  assert.deepEqual(producedGrowth(before, after, {gold_ingot: 1}), {});
});

test('un deposito si legge dal risultato, nelle sue due forme', () => {
  assert.deepEqual(depositedStacks({ok: true, item: 'diamond', count: 44}), [{item: 'diamond', count: 44}]);
  assert.deepEqual(depositedStacks({ok: true, items: [{item: 'diamond', count: 41}, {item: 'potato', count: 56}]}),
    [{item: 'diamond', count: 41}, {item: 'potato', count: 56}]);
  assert.deepEqual(depositedStacks({ok: true, count: 3}), []);
  assert.deepEqual(depositedStacks({ok: true, item: 'diamond'}), []);
  assert.deepEqual(depositedStacks({ok: true, items: [{item: 'diamond', count: 0}]}), []);
  assert.deepEqual(depositedStacks(null), []);
});

test('il goal non chiude finche\u2019 il requisito non e\u2019 soddisfatto', () => {
  const requirements = {mustMine: {diamond: 2}, mustDeposit: {diamond: 2}};
  // 44 diamanti *presi* da uno scrigno non sono un diamante minato: e' il caso
  // che ha chiuso la spedizione tre volte.
  assert.equal(missionRequirementsMet({mined: {}, deposited: {}}, requirements), false);
  assert.equal(missionRequirementsMet({mined: {diamond: 1}, deposited: {}}, requirements), false);
  assert.equal(missionRequirementsMet({mined: {diamond: 2}, deposited: {}}, requirements), false);
  assert.equal(missionRequirementsMet({mined: {diamond: 2}, deposited: {diamond: 1}}, requirements), false);
  assert.equal(missionRequirementsMet({mined: {diamond: 2}, deposited: {diamond: 2}}, requirements), true);
});

test('un requisito di solo minaggio non chiede il deposito', () => {
  assert.equal(missionRequirementsMet({mined: {diamond: 1}, deposited: {}}, {mustMine: {diamond: 1}}), true);
  assert.equal(missionRequirementsMet({mined: {}, deposited: {diamond: 1}}, {mustDeposit: {diamond: 1}}), true);
});

test('lo stato e la riga di ledger sono leggibili', () => {
  const state = missionRequirementsState({mined: {diamond: 1}, deposited: {}}, {mustMine: {diamond: 2}, mustDeposit: {diamond: 2}});
  assert.deepEqual(state, [{item: 'diamond', wantMined: 2, haveMined: 1, wantDeposited: 2, haveDeposited: 0, met: false}]);
  assert.equal(renderRequirements(state), 'diamond mined 1/2 deposited 0/2');
  assert.deepEqual(addCounts({diamond: 1}, {diamond: 2, gold_ingot: 1}), {diamond: 3, gold_ingot: 1});
});

test('il controller annoda il requisito: opzioni, credito e chiusura', () => {
  const source = readFileSync(join(ROOT, 'controller.mjs'), 'utf8');
  // Senza questa esclusione il modello puo' ancora prendere l'oggetto dal baule.
  assert.match(source, /requirementTakeKeys\(MUST_MINE\)\) excludeKeys\.push\(\{key, reason: 'must_mine'\}\)/);
  // Senza il credito il contatore resta a zero e il goal non chiude mai.
  assert.match(source, /if \(MISSION_REQUIREMENTS_ON\) await creditMissionResult\(step, key, result\);/);
  // Senza questa condizione il goal chiude sull'inventario (il furto).
  assert.match(source, /const mission = orderFloor \? true : missionRequirementsMet\(requirementProgress, MISSION_REQUIREMENTS\);/);
  assert.match(source, /return targets && at && mission;/);
});

// M15 — le chiavi vietate dalla missione: la regola scritta nel goal non e' un
// meccanismo. Il 09/10/2026 il decider ha speso sei `mount_donkey`/`mount_horse`
// (`vehicle_unreachable`) prima di toccare il primo baule.
test('le chiavi vietate dalla missione si leggono, si deduplicano e si validano', () => {
  assert.deepEqual(parseForbiddenKeys('mount_donkey,mount_horse,throw_egg'), ['mount_donkey', 'mount_horse', 'throw_egg']);
  assert.deepEqual(parseForbiddenKeys(' mount_donkey , mount_donkey ,throw_egg '), ['mount_donkey', 'throw_egg']);
  for (const value of [undefined, null, '', '   ', 'off', 'none']) assert.deepEqual(parseForbiddenKeys(value), []);
  // Un token malformato non si ignora in silenzio: sarebbe un divieto che non
  // vieta niente.
  assert.throws(() => parseForbiddenKeys('mount_donkey,mount horse'), /mission_forbid_invalid/);
  assert.throws(() => parseForbiddenKeys('Mount_Donkey'), /mission_forbid_invalid/);
});

test('il controller annoda il divieto: opzioni, annuncio e passo senza azioni lecite', () => {
  const source = readFileSync(join(ROOT, 'controller.mjs'), 'utf8');
  assert.match(source, /const MISSION_FORBID = parseForbiddenKeys\(process\.env\.MISSION_FORBID\);/);
  // Senza il canale `forbidKeys` il divieto sarebbe solo un'esclusione del passo
  // e il ripiego di `filterOptions` lo riporterebbe in tavola.
  assert.match(source, /forbidKeys: MISSION_FORBID\}/);
  assert.match(source, /log\('mission_forbidden', \{keys: MISSION_FORBID, maxSteps: MISSION_FORBID_MAX_STEPS\}\)/);
  // Il vuoto non arriva mai al decider.
  assert.match(source, /if \(filtered\.options\.length === 0\) \{/);
  assert.match(source, /failureReason = 'mission_forbidden_only';/);
  assert.match(source, /log\('options_all_forbidden', \{step, consecutive: forbiddenSteps/);
});
