// R4 — il rifiuto tipizzato. Il vocabolario e' quello vero del harness: questi
// test usano le stringhe che `bedrock-adapter.mjs` restituisce davvero, non
// errori inventati, perche' la classificazione vale solo se regge sui rifiuti
// reali (`no reachable iron_ore found nearby`, `action_timeout`,
// `fell_tree_refused`, `missing_flint_and_steel`, `animal_gone`, …).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STEP_FAILURE_VERSION, FAILURE_KINDS, RETRYABLE_KINDS, SWITCH_KINDS, MAX_STEP_ATTEMPTS,
  classifyFailure, isRetryable, failureRecord, failureDisposition,
  activeStepId, siblingKeys, reviseSteps, refusalEvidence,
} from '../step-failure.mjs';
import { optionIntents } from '../survival/intents.mjs';

test('il vocabolario reale del harness cade nei tipi dichiarati', () => {
  const cases = [
    ['busy', 'busy', true],
    // Famiglia `<qualcosa>_timeout`: il harness ha toccato il proprio tetto.
    ['action_timeout', 'timeout', true],
    ['container_open_timeout', 'timeout', true],
    ['mining_timeout', 'timeout', true],
    ['smelt_timeout', 'timeout', true],
    ['trade_result_timeout', 'timeout', true],
    ['escort_timeout', 'timeout', true],
    ['combat_timeout', 'timeout', true],
    ['raw_break_timeout', 'timeout', true],
    ['bridge_timeout', 'timeout', true],
    ['block_confirmation_timeout', 'timeout', true],
    // Client/mondo non pronti: ritentabili.
    ['not_connected', 'transient', true],
    ['world_not_loaded', 'transient', true],
    ['not_ready', 'transient', true],
    ['gap_unknown', 'transient', true],
    // Il bersaglio si e' spostato: non e' un guasto, si guarda di nuovo.
    ['animal_gone', 'moved', true],
    ['sheep_gone', 'moved', true],
    ['trader_gone', 'moved', true],
    ['vehicle_gone', 'moved', true],
    // La ricerca di un umano perso (`tests/controller-follow-lost.test.mjs`):
    // l'umano si e' allontanato, non e' un guasto — la via deterministica del
    // recupero decide, e un replan qui sarebbe rumore.
    ['player_not_found', 'moved', true],
    // Approccio/bersaglio non disponibile: un altro approccio puo' funzionare.
    ['no reachable iron_ore found nearby', 'blocked', false],
    ['no reachable diamond_ore found nearby', 'blocked', false],
    ['portal_unreachable', 'blocked', false],
    ['piglin_unreachable', 'blocked', false],
    ['no_safe_cell', 'blocked', false],
    ['not_diggable_chest', 'blocked', false],
    ['protected_chest', 'blocked', false],
    ['unsafe_block_lava', 'blocked', false],
    ['block_still_present', 'blocked', false],
    // Il blocco che il client credeva di cliccare non c'e' o non e' quello: un
    // approccio nuovo puo' funzionare, e comunque non e' un guasto da ritentare
    // allo stesso modo (live 08/10/2026: bauli non aperti per 70 minuti).
    ['block_unknown', 'blocked', false],
    ['block_mismatch', 'blocked', false],
    // Live 08/10/2026, tentativo 16: il bot chiuso dentro il vano di una porta.
    // Il cammino non e' rotto, e' l'approccio che non passa: un'altra chiave puo'.
    ['stuck_in_doorway', 'blocked', false],
    // Regola del harness che dice no: il piano deve cambiare.
    ['fell_tree_refused', 'refused', false],
    // Manca qualcosa al passo: il piano deve aggiungere il passo che lo procura.
    ['missing_flint_and_steel', 'prerequisite', false],
    ['missing_bucket', 'prerequisite', false],
    ['no_food', 'prerequisite', false],
    ['nothing_to_drop', 'prerequisite', false],
    ['item_not_in_container', 'prerequisite', false],
  ];
  for (const [error, kind, retryable] of cases) {
    const out = classifyFailure(error);
    assert.equal(out.kind, kind, `${error} -> ${out.kind}, atteso ${kind}`);
    assert.equal(out.retryable, retryable, `${error} retryable`);
  }
  // Il vocabolario e' chiuso: nessun tipo inventato dai test.
  assert.deepEqual([...new Set(cases.map(c => c[1]))].sort(), ['blocked', 'busy', 'moved', 'prerequisite', 'refused', 'timeout', 'transient']);
});

test('un errore fuori vocabolario e vuoto e terminale, mai indovinato ritentabile', () => {
  for (const error of ['qualcosa_di_nuovo', '', null, undefined, { message: 'boom' }]) {
    const out = classifyFailure(error);
    assert.equal(out.kind, 'unknown', JSON.stringify(error));
    assert.equal(out.retryable, false, JSON.stringify(error));
    assert.equal(isRetryable(out.kind), false);
    assert.equal(failureDisposition({ ...out, error: 'x', attempts: 1 }).action, 'replan');
  }
  assert.equal(FAILURE_KINDS.includes('unknown'), true);
  assert.equal(STEP_FAILURE_VERSION, 1);
  assert.deepEqual([...RETRYABLE_KINDS].sort(), ['busy', 'moved', 'timeout', 'transient']);
  assert.deepEqual([...SWITCH_KINDS], ['blocked']);
});

test('il rifiuto e tipizzato con la sua evidenza', () => {
  const evidence = refusalEvidence({
    observation: { position: { x: 12, y: 64, z: -3 }, dimension: 'overworld' },
    plan: { targets: { iron_ore: 3 } },
    result: { ok: false, error: 'no reachable iron_ore found nearby', ms: 812, remaining: 2, hint: 'buried vein' },
  });
  const record = failureRecord({
    step: 7, stepId: 'mine-iron', key: 'mine_iron_ore',
    error: 'no reachable iron_ore found nearby', evidence, attempts: 1, at: 1234,
  });
  assert.equal(record.step, 7);
  assert.equal(record.stepId, 'mine-iron');
  assert.equal(record.key, 'mine_iron_ore');
  assert.equal(record.error, 'no reachable iron_ore found nearby');
  assert.equal(record.kind, 'blocked');
  assert.equal(record.retryable, false);
  assert.match(record.hint, /another one may be/);
  assert.equal(record.attempts, 1);
  assert.equal(record.at, 1234);
  // L'evidenza e' quello che il controller sapeva piu' quello che il harness ha
  // detto oltre a ok/error: posizione, target del piano, campi extra.
  assert.deepEqual(record.evidence.position, { x: 12, y: 64, z: -3 });
  assert.equal(record.evidence.dimension, 'overworld');
  assert.deepEqual(record.evidence.targets, { iron_ore: 3 });
  assert.equal(record.evidence.ms, 812);
  assert.equal(record.evidence.remaining, 2);
  assert.equal(record.evidence.hint, 'buried vein');
  assert.equal('ok' in record.evidence, false);
  assert.equal('error' in record.evidence, false);
});

test("l'evidenza non e un dump: i campi grossi si scartano", () => {
  const evidence = refusalEvidence({
    observation: { position: { x: 0, y: 0, z: 0 } },
    result: { ok: false, error: 'busy', blob: 'x'.repeat(400), small: 'ok' },
  });
  assert.equal('blob' in evidence, false);
  assert.equal(evidence.small, 'ok');
});

test('un rifiuto ritentabile si ritenta, e quando ha esaurito i tentativi fallisce il passo', () => {
  const record = failureRecord({ step: 1, key: 'sleep', error: 'action_timeout', attempts: 1 });
  const first = failureDisposition(record, { attempts: 1 });
  assert.equal(first.action, 'retry');
  assert.equal(first.reason, 'timeout_retry');
  assert.equal(first.kind, 'timeout');
  const second = failureDisposition(record, { attempts: MAX_STEP_ATTEMPTS });
  assert.equal(second.action, 'replan');
  assert.equal(second.reason, 'timeout_exhausted');
});

test('un approccio bloccato cambia approccio, e dopo i tentativi ripianifica', () => {
  const record = failureRecord({ step: 4, stepId: 's1', key: 'mine_iron_ore', error: 'no reachable iron_ore found nearby' });
  const first = failureDisposition(record, { attempts: 1 });
  assert.equal(first.action, 'switch');
  assert.equal(first.reason, 'blocked_alternative');
  const second = failureDisposition(record, { attempts: 2 });
  assert.equal(second.action, 'replan');
  assert.equal(second.reason, 'blocked_exhausted');
});

test('un rifiuto terminale fallisce il passo e il piano', () => {
  for (const [error, reason] of [
    ['fell_tree_refused', 'refused_terminal'],
    ['missing_flint_and_steel', 'prerequisite_terminal'],
    ['qualcosa_di_nuovo', 'unknown_terminal'],
  ]) {
    const record = failureRecord({ step: 2, key: 'k', error });
    const disposition = failureDisposition(record, { attempts: 1 });
    assert.equal(disposition.action, 'replan', error);
    assert.equal(disposition.reason, reason, error);
  }
});

test('lo step attivo e quello che il piano dichiara, non sempre il primo', () => {
  const plan = { skill: 'mine_iron', steps: [{ id: 'a', skill: 'wood' }, { id: 'b', skill: 'mine_iron' }] };
  assert.equal(activeStepId(plan), 'b');
  assert.equal(activeStepId({ steps: [{ id: 'solo' }] }), 'solo');
  assert.equal(activeStepId({ skill: 'x', steps: [] }), null);
  assert.equal(activeStepId(null), null);
});

test("l'alternativa sono le chiavi che servono lo stesso intento", () => {
  const offered = ['mine_iron_ore', 'mine_deepslate_iron_ore', 'mine_diamond_ore', 'sleep', 'follow_player', 'qualcosa_di_ignoto'];
  assert.deepEqual(
    siblingKeys('mine_iron_ore', offered, optionIntents),
    ['mine_deepslate_iron_ore', 'mine_diamond_ore'],
  );
  // `travel` non e' `mine`: inseguire l'umano non e' un'alternativa a scavare.
  assert.equal(siblingKeys('mine_iron_ore', offered, optionIntents).includes('follow_player'), false);
  // Mai se stessa, e senza intento non si indovina.
  assert.equal(siblingKeys('mine_iron_ore', offered, optionIntents).includes('mine_iron_ore'), false);
  assert.deepEqual(siblingKeys('qualcosa_di_ignoto', offered, optionIntents), []);
  assert.deepEqual(siblingKeys('mine_iron_ore', offered, () => ['unknown']), []);
});

test('lo step rifiutato porta la sua revisione dentro steps[]', () => {
  const plan = {
    skill: 'mine_iron',
    steps: [
      { id: 'a', skill: 'wood', targets: { wood: 2 }, verify: ['inventory'] },
      { id: 'b', skill: 'mine_iron', targets: { iron_ore: 3 } },
    ],
  };
  const record = failureRecord({
    step: 5, stepId: 'b', key: 'mine_iron_ore', error: 'no reachable iron_ore found nearby', attempts: 1, at: 999,
  });
  const revised = reviseSteps(plan, record, { alternatives: ['mine_deepslate_iron_ore'] });
  assert.notEqual(revised, plan, 'il piano e nuovo');
  assert.deepEqual(revised.steps[0], plan.steps[0], 'il passo che non ha fallito non cambia');
  assert.deepEqual(plan.steps[1], { id: 'b', skill: 'mine_iron', targets: { iron_ore: 3 } }, 'il piano di partenza non viene mutato');
  assert.equal(revised.steps[1].refused.error, 'no reachable iron_ore found nearby');
  assert.equal(revised.steps[1].refused.kind, 'blocked');
  assert.equal(revised.steps[1].refused.retryable, false);
  assert.deepEqual(revised.steps[1].refused.alternatives, ['mine_deepslate_iron_ore']);
  assert.equal(revised.steps[1].refusalCount, 1);
  assert.equal(revised.steps[1].revisions.length, 1);
  assert.equal(revised.steps[1].revisions[0].error, 'no reachable iron_ore found nearby');
  // Un secondo rifiuto conta e non sovrascrive la storia.
  const again = reviseSteps(revised, failureRecord({ step: 8, stepId: 'b', key: 'mine_deepslate_iron_ore', error: 'block_still_present' }));
  assert.equal(again.steps[1].refusalCount, 2);
  assert.equal(again.steps[1].revisions.length, 2);
  assert.equal(again.steps[1].refused.error, 'block_still_present');
  assert.equal(again.steps[0].refusalCount, undefined);
});

test('la storia delle revisioni e limitata, e senza step non si inventa nulla', () => {
  let plan = { skill: 'x', steps: [{ id: 's', skill: 'x' }] };
  for (let i = 0; i < 6; i += 1) {
    plan = reviseSteps(plan, failureRecord({ step: i, stepId: 's', key: 'k', error: 'action_timeout' }));
  }
  assert.equal(plan.steps[0].refusalCount, 6);
  assert.equal(plan.steps[0].revisions.length, 4, 'solo le ultime quattro');
  assert.equal(plan.steps[0].revisions.at(-1).step, 5);
  // Un piano senza steps non viene toccato: nessun passo da revisionare.
  const bare = { objective: 'x' };
  assert.equal(reviseSteps(bare, failureRecord({ key: 'k', error: 'busy' })), bare);
  assert.equal(reviseSteps(plan, null), plan);
});
