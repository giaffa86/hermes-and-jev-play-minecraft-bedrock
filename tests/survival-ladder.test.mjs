import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseNeedAction } from '../survival/resolver.mjs';
import { NEED_INTENTS, DROWNING_AIR, deriveNeeds } from '../survival/needs.mjs';
import { optionIntents } from '../survival/intents.mjs';

// La scala di sopravvivenza: i bisogni del governor («mi sto annegando», «sono
// ferito», «ho fame») diventano l'azione che il harness ha davvero offerto.
// Nessuna opzione si chiama `heal` o `obtain_food`: il ponte sono gli intenti
// (`eat`, `smelt`, `flee`, `surface`), e l'ordine è quello della reazione umana,
// non quello del modello.

const opt = (key) => ({ key, description: key });

test('in emergenza la cura viene prima della fuga: e la regola a decidere cosa e ammesso', () => {
  const governor = {
    mode: 'emergency',
    needs: ['survive', 'heal'],
    allowedIntents: ['heal', 'eat', 'escape', 'shelter'],
  };
  const choice = chooseNeedAction({ governor, options: [opt('go_home'), opt('eat')] });
  assert.equal(choice.key, 'eat', 'a cuori bassi si mangia prima di tornare a casa');
  assert.equal(choice.intent, 'heal', 'mangiare e anche curare');
  assert.equal(choice.need, 'survive', 'il bisogno resta quello dichiarato per primo');
});

test('con un creeper addosso la regola mette la fuga davanti alla cura', () => {
  const governor = {
    mode: 'emergency',
    needs: ['survive', 'heal'],
    allowedIntents: ['escape', 'heal', 'eat', 'shelter'],
  };
  const choice = chooseNeedAction({ governor, options: [opt('eat'), opt('flee')] });
  assert.equal(choice.key, 'flee', 'prima si esce dall esplosione, poi si mangia');
  assert.equal(choice.intent, 'escape');
});

test('affamato senza cibo mangiabile la scala raccoglie quello che trova', () => {
  const governor = {
    mode: 'emergency',
    needs: ['survive', 'heal', 'obtain_food'],
    allowedIntents: ['heal', 'eat', 'escape', 'shelter', 'collect', 'smelt'],
  };
  const choice = chooseNeedAction({ governor, options: [opt('harvest_carrots'), opt('mine_oak_log')] });
  assert.equal(choice.key, 'harvest_carrots', 'le carote si mangiano crude: sono la salvezza');
  assert.equal(choice.intent, 'collect');
  assert.equal(choice.need, 'obtain_food');
});

test('senza cibo mangiabile la scala arriva a procurarselo (cuocerlo o raccoglierlo)', () => {
  const governor = {
    mode: 'emergency',
    needs: ['survive', 'heal', 'obtain_food'],
    allowedIntents: ['heal', 'eat', 'escape', 'shelter', 'smelt', 'collect'],
  };
  const choice = chooseNeedAction({ governor, options: [opt('smelt_potato'), opt('harvest_carrots')] });
  assert.equal(choice.key, 'smelt_potato', 'una patata cruda si cuoce: non si mangia cosi com e');
});

test('in emergenza vince l intento piu urgente ammesso dal governor', () => {
  const governor = {
    mode: 'emergency',
    needs: ['survive', 'escape', 'heal'],
    allowedIntents: ['heal', 'eat', 'escape', 'shelter'],
  };
  const choice = chooseNeedAction({ governor, options: [opt('go_home'), opt('flee'), opt('mine_dirt')] });
  assert.equal(choice.key, 'flee', 'scappare batte tornare a casa, che ha lo stesso intento escape');
  assert.equal(choice.intent, 'escape');
  assert.equal(choice.source, 'emergency_ladder');
});

test('il respiro passa davanti a cura e fame', () => {
  const governor = { mode: 'emergency', needs: ['surface', 'heal', 'eat'], allowedIntents: ['surface', 'heal', 'eat'] };
  const choice = chooseNeedAction({ governor, options: [opt('eat'), opt('surface'), opt('equip_armor')] });
  assert.equal(choice.key, 'surface');
  assert.equal(choice.intent, 'surface');
});

test('senza emergenza la scala segue i bisogni, non il modello', () => {
  const governor = { mode: 'caution', needs: ['eat', 'continue_progression'], allowedIntents: null };
  const choice = chooseNeedAction({ governor, options: [opt('mine_dirt'), opt('eat')] });
  assert.equal(choice.key, 'eat');
  assert.equal(choice.need, 'eat');
  assert.equal(choice.source, 'need_ladder');
});

test('procurarsi cibo: prima si cucina quello che c e, poi si raccoglie', () => {
  const governor = { mode: 'caution', needs: ['obtain_food'], allowedIntents: null };
  const choice = chooseNeedAction({ governor, options: [opt('harvest_carrots'), opt('smelt_potato')] });
  assert.equal(choice.key, 'smelt_potato');
  assert.equal(choice.intent, 'smelt');
  assert.ok(NEED_INTENTS.obtain_food.includes('collect'), 'la raccolta resta nel vocabolario del cibo');
});

test('wait non e mai una scelta di sopravvivenza', () => {
  assert.equal(chooseNeedAction({ governor: { mode: 'emergency', needs: ['survive'], allowedIntents: ['wait'] }, options: [opt('wait')] }), null);
  assert.equal(
    chooseNeedAction({ governor: { mode: 'caution', needs: ['continue_progression'], allowedIntents: null }, options: [opt('wait'), opt('mine_dirt')] }),
    null,
    'la progressione non passa dalla scala: la sceglie il piano',
  );
});

test('raccogliere una coltura conta come raccolto, non come azione sconosciuta', () => {
  assert.deepEqual(optionIntents('harvest_carrots'), ['collect', 'mine']);
  assert.deepEqual(optionIntents('harvest_potatoes'), ['collect', 'mine']);
  assert.deepEqual(optionIntents('harvest_honeycomb'), ['collect'], 'la mappatura esplicita resta prioritaria');
});

test('la soglia di annegamento e 60 tick (3 secondi), non l ultimo respiro', () => {
  assert.equal(DROWNING_AIR, 60);
  assert.ok(deriveNeeds({ health: 20, food: 20, fluids: { headInWater: true, waterBreathing: false, air: 60 } }, { level: 'none' }).includes('surface'));
  assert.ok(!deriveNeeds({ health: 20, food: 20, fluids: { headInWater: true, waterBreathing: false, air: 61 } }, { level: 'none' }).includes('surface'));
});
