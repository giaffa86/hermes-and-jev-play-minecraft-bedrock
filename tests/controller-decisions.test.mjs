import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCriteria, buildDecisionInstructions, capOptions, detectRepeatedAction, filterOptions, isEquipOrder, isStopOrder,
  optionPriority, parseDistance, progressFingerprint, rankOptions, summarizePlan, waitOnlyReason,
  withStickyFollow, DEFAULT_ANTI_LOOP_THRESHOLD, DEFAULT_MAX_OPTIONS,
} from '../controller-decisions.mjs';

const opt = (key, description = `${key} description`) => ({ key, description });

test('buildCriteria numbers options and embeds the key in the description', () => {
  const criteria = buildCriteria([opt('eat', 'Eat cooked_beef'), opt('wait')]);
  assert.deepEqual(criteria, {
    a0: '[eat] Eat cooked_beef',
    a1: '[wait] wait description',
  });
});

test('parseDistance reads the distance from option descriptions', () => {
  assert.equal(parseDistance('Attack the zombie (3.4 blocks away, health 20)'), 3.4);
  assert.equal(parseDistance('Walk onto the nearest dropped item (12 blocks away)'), 12);
  assert.equal(parseDistance('Mine stone at {"x":1,"y":2,"z":3}'), null);
  assert.equal(parseDistance(undefined), null);
});

test('optionPriority orders survival first, wait last and targets above generic mining', () => {
  const ctx = { targets: { dirt: 4 } };
  assert.ok(optionPriority(opt('flee'), ctx) < optionPriority(opt('collect_drop'), ctx));
  assert.ok(optionPriority(opt('attack_zombie'), ctx) < optionPriority(opt('collect_drop'), ctx));
  assert.ok(optionPriority(opt('collect_drop'), ctx) < optionPriority(opt('mine_dirt'), ctx));
  assert.ok(optionPriority(opt('mine_dirt'), ctx) < optionPriority(opt('mine_stone'), ctx));
  assert.ok(optionPriority(opt('craft_stick'), ctx) < optionPriority(opt('mine_stone'), ctx));
  assert.ok(optionPriority(opt('goto_waypoint'), ctx) < optionPriority(opt('mine_stone'), ctx));
  assert.ok(optionPriority(opt('mine_stone'), ctx) < optionPriority(opt('wait'), ctx));
});

test('optionPriority ranks follow_player just below drop pickup and above generic mining', () => {
  const ctx = { targets: {} };
  assert.ok(optionPriority(opt('collect_drop'), ctx) < optionPriority(opt('follow_player'), ctx));
  assert.ok(optionPriority(opt('follow_player'), ctx) < optionPriority(opt('mine_stone'), ctx));
  assert.ok(optionPriority(opt('follow_player'), ctx) < optionPriority(opt('wait'), ctx));
});

test('optionPriority recognizes targets by name, including partial matches', () => {
  assert.ok(optionPriority(opt('craft_stone_pickaxe'), { targets: { stone_pickaxe: 1 } }) <
            optionPriority(opt('craft_stick'), { targets: { stone_pickaxe: 1 } }));
  assert.ok(optionPriority(opt('mine_coal_ore'), { targets: { coal: 3 } }) <
            optionPriority(opt('mine_stone'), { targets: { coal: 3 } }));
});

test('rankOptions is stable and sorts mining by parsed distance inside a tier', () => {
  const options = [
    opt('mine_stone', 'Mine stone at far (20 blocks away)'),
    opt('mine_dirt', 'Mine dirt at near (2 blocks away)'),
    opt('mine_grass_block', 'Mine grass_block at mid (7 blocks away)'),
  ];
  assert.deepEqual(rankOptions(options).map(o => o.key), ['mine_dirt', 'mine_grass_block', 'mine_stone']);
  const tie = [opt('mine_a', 'no distance'), opt('mine_b', 'no distance')];
  assert.deepEqual(rankOptions(tie).map(o => o.key), ['mine_a', 'mine_b']);
});

test('capOptions keeps the most relevant options and preserves their original order', () => {
  const options = [
    opt('mine_stone'), opt('mine_dirt'), opt('craft_stick'), opt('flee'), opt('goto_waypoint'),
  ];
  const { options: capped, dropped } = capOptions(options, { max: 3 });
  assert.deepEqual(capped.map(o => o.key), ['craft_stick', 'flee', 'goto_waypoint']);
  assert.deepEqual(dropped.map(o => o.key), ['mine_stone', 'mine_dirt']);
  // Con i target, le azioni che li producono salgono di priorità.
  const targeted = capOptions(options, { max: 2, targets: { dirt: 4 } });
  assert.deepEqual(targeted.options.map(o => o.key), ['mine_dirt', 'flee']);
  assert.deepEqual(targeted.dropped.map(o => o.key), ['mine_stone', 'craft_stick', 'goto_waypoint']);
});

test('capOptions does nothing when under the cap or when disabled', () => {
  const options = [opt('mine_stone'), opt('wait')];
  assert.deepEqual(capOptions(options, { max: 12 }).options.map(o => o.key), ['mine_stone', 'wait']);
  assert.deepEqual(capOptions(options, { max: 0 }).options.map(o => o.key), ['mine_stone', 'wait']);
  assert.deepEqual(capOptions(options, { max: 0 }).dropped, []);
  assert.equal(DEFAULT_MAX_OPTIONS, 12);
});

test('progressFingerprint reacts to position, inventory and objective changes only', () => {
  const obs = { position: { x: 1.2, y: 64.9, z: -3.1 }, inventory: { dirt: 2, stick: 1 }, health: 20 };
  const plan = { objective: 'mine dirt' };
  const base = progressFingerprint(obs, plan);
  assert.equal(progressFingerprint({ ...obs }, { ...plan }), base);
  // Vita e drop non sono progresso.
  assert.equal(progressFingerprint({ ...obs, health: 5, drops: [{ id: 1 }] }, plan), base);
  assert.notEqual(progressFingerprint({ ...obs, position: { ...obs.position, x: 2.4 } }, plan), base);
  assert.notEqual(progressFingerprint({ ...obs, inventory: { dirt: 3 } }, plan), base);
  assert.notEqual(progressFingerprint(obs, { objective: 'craft' }), base);
});

test('detectRepeatedAction counts only the trailing stagnant streak', () => {
  const history = [
    { key: 'goto_waypoint', stagnant: true },
    { key: 'goto_waypoint', stagnant: true },
  ];
  assert.deepEqual(detectRepeatedAction(history, 'goto_waypoint'), { repeated: false, count: 2 });
  history.push({ key: 'goto_waypoint', stagnant: true });
  assert.deepEqual(detectRepeatedAction(history, 'goto_waypoint'), { repeated: true, count: 3 });
  // Un progresso interrompe la serie.
  history.push({ key: 'goto_waypoint', stagnant: false });
  assert.deepEqual(detectRepeatedAction(history, 'goto_waypoint'), { repeated: false, count: 0 });
  // Un'altra azione interrompe la serie.
  const other = [{ key: 'goto_waypoint', stagnant: true }, { key: 'mine_dirt', stagnant: true }];
  assert.deepEqual(detectRepeatedAction(other, 'goto_waypoint'), { repeated: false, count: 0 });
  assert.equal(DEFAULT_ANTI_LOOP_THRESHOLD, 3);
});

test('filterOptions hides wait when something else is available', () => {
  const { options, excluded } = filterOptions([opt('wait'), opt('mine_dirt')]);
  assert.deepEqual(options.map(o => o.key), ['mine_dirt']);
  assert.deepEqual(excluded, [{ key: 'wait', reason: 'wait_not_useful' }]);
  // wait è l'unica opzione: resta.
  const alone = filterOptions([opt('wait')]);
  assert.deepEqual(alone.options.map(o => o.key), ['wait']);
  assert.deepEqual(alone.excluded, []);
});

test('filterOptions excludes stagnant keys but never empties the set', () => {
  const history = Array.from({ length: 3 }, () => ({ key: 'goto_waypoint', stagnant: true }));
  const options = [opt('goto_waypoint'), opt('mine_stone'), opt('collect_drop')];
  const filtered = filterOptions(options, history);
  assert.deepEqual(filtered.options.map(o => o.key), ['mine_stone', 'collect_drop']);
  assert.deepEqual(filtered.excluded, [{ key: 'goto_waypoint', reason: 'stagnant_3' }]);
  // Tutte stagnanti: si tengono comunque, con nota esplicita.
  const all = filterOptions([opt('goto_waypoint')], history);
  assert.deepEqual(all.options.map(o => o.key), ['goto_waypoint']);
  assert.equal(all.note, 'all_stagnant');
});

test('filterOptions honors explicit exclusions and falls back instead of returning nothing', () => {
  const options = [opt('goto_waypoint'), opt('wait')];
  const failed = filterOptions(options, [], { excludeKeys: [{ key: 'goto_waypoint', reason: 'failed' }] });
  assert.deepEqual(failed.options.map(o => o.key), ['wait']);
  assert.deepEqual(failed.excluded, [{ key: 'goto_waypoint', reason: 'failed' }]);
  // Tutto escluso: si ripristinano le opzioni offerte dal harness (mai insieme vuoto).
  const only = filterOptions([opt('goto_waypoint')], [], { excludeKeys: [{ key: 'goto_waypoint', reason: 'failed' }] });
  assert.deepEqual(only.options.map(o => o.key), ['goto_waypoint']);
  assert.equal(only.fallback.reason, 'filters_left_empty_set');
});

// M15: il divieto di missione (MISSION_FORBID). Una regola nel testo del goal
// non e' un meccanismo; un'esclusione del passo vale un passo solo.
test('filterOptions toglie le chiavi vietate dalla missione', () => {
  const options = [opt('mount_donkey'), opt('mount_horse'), opt('goto_waypoint')];
  const filtered = filterOptions(options, [], { forbidKeys: ['mount_donkey', 'mount_horse'] });
  assert.deepEqual(filtered.options.map(o => o.key), ['goto_waypoint']);
  assert.deepEqual(filtered.excluded, [
    { key: 'mount_donkey', reason: 'mission_forbidden' },
    { key: 'mount_horse', reason: 'mission_forbidden' },
  ]);
  // Senza divieti le opzioni restano quelle di prima, nello stesso ordine.
  const plain = filterOptions(options, []);
  const none = filterOptions(options, [], { forbidKeys: [] });
  assert.deepEqual(none.options.map(o => o.key), plain.options.map(o => o.key));
  assert.deepEqual(none.excluded, plain.excluded);
});

test('il ripiego non resuscita una chiave vietata (e il divieto resta al passo dopo)', () => {
  // Una chiave non vietata esclusa dal passo torna dal ripiego: e' il contratto
  // di `filterOptions`. Una vietata no.
  const mixed = filterOptions([opt('mount_donkey'), opt('goto_waypoint')], [], {
    excludeKeys: [{ key: 'goto_waypoint', reason: 'failed' }], forbidKeys: ['mount_donkey'],
  });
  assert.deepEqual(mixed.options.map(o => o.key), ['goto_waypoint']);
  assert.equal(mixed.fallback.reason, 'filters_left_empty_set');
  // Passo nuovo: le esclusioni del passo precedente spariscono (R4), il divieto
  // no — e' un mandato della missione, non una scelta del momento.
  const options = [opt('mount_donkey'), opt('goto_waypoint'), opt('mine_dirt')];
  const step1 = filterOptions(options, [], { excludeKeys: [{ key: 'mount_donkey', reason: 'step_refused' }], forbidKeys: ['mount_donkey'] });
  assert.deepEqual(step1.options.map(o => o.key), ['goto_waypoint', 'mine_dirt']);
  const step2 = filterOptions(options, [{ key: 'mount_donkey', stagnant: true }], { forbidKeys: ['mount_donkey'] });
  assert.deepEqual(step2.options.map(o => o.key), ['goto_waypoint', 'mine_dirt']);
  assert.equal(step2.excluded.some(e => e.key === 'mount_donkey' && e.reason === 'mission_forbidden'), true);
});

test('un divieto che lascia zero azioni lecite non si aggira col ripiego', () => {
  const filtered = filterOptions([opt('mount_donkey'), opt('mount_horse')], [], { forbidKeys: ['mount_donkey', 'mount_horse'] });
  // Il decider non riceve mai l'insieme vuoto: il controller lo tratta come un
  // passo cieco, contato e tipizzato (`mission_forbidden_only`).
  assert.deepEqual(filtered.options, []);
  assert.equal(filtered.note, 'all_forbidden');
  assert.equal(filtered.fallback.reason, 'mission_forbidden_left_empty_set');
  // `wait` non e' un divieto: se il harness offre solo quello piu' le chiavi
  // vietate, resta l'attesa e non il vuoto.
  const withWait = filterOptions([opt('mount_donkey'), opt('wait')], [], { forbidKeys: ['mount_donkey'] });
  assert.deepEqual(withWait.options.map(o => o.key), ['wait']);
});

test('filterOptions caps relevance and reports what was dropped', () => {
  const options = [opt('mine_stone'), opt('mine_dirt'), opt('craft_stick'), opt('flee'), opt('goto_waypoint')];
  const filtered = filterOptions(options, [], { max: 3 });
  assert.deepEqual(filtered.options.map(o => o.key), ['craft_stick', 'flee', 'goto_waypoint']);
  assert.deepEqual(filtered.dropped.map(o => o.key), ['mine_stone', 'mine_dirt']);
});

test('filterOptions does not mutate its inputs', () => {
  const options = [opt('wait'), opt('mine_dirt')];
  const history = [{ key: 'mine_dirt', stagnant: true }];
  const snapshot = JSON.stringify({ options, history });
  filterOptions(options, history);
  assert.equal(JSON.stringify({ options, history }), snapshot);
});

test('waitOnlyReason explains why wait was the only option', () => {
  assert.equal(waitOnlyReason({ spawned: true, status: 'spawned', position: {} }), 'no_useful_options');
  assert.equal(waitOnlyReason({ spawned: false, status: 'connecting' }), 'not_connected');
  assert.equal(waitOnlyReason({ spawned: true, status: 'spawned', dead: true }), 'dead');
  assert.equal(waitOnlyReason({ spawned: true, status: 'spawned', sleeping: true }), 'sleeping');
  assert.equal(waitOnlyReason({ spawned: true, status: 'spawned' }), 'no_position');
});

test('summarizePlan renders objective, targets, waypoint and notes', () => {
  const text = summarizePlan({ objective: 'Craft a stone pickaxe', targets: { stone_pickaxe: 1 }, waypoint: { x: 93, z: 146 }, notes: 'mining done' });
  assert.match(text, /Objective: Craft a stone pickaxe/);
  assert.match(text, /Targets: \{"stone_pickaxe":1\}/);
  assert.match(text, /Waypoint: \{"x":93,"z":146\}/);
  assert.match(text, /Notes: mining done/);
  assert.equal(summarizePlan({}), 'No plan.');
});

test('buildDecisionInstructions states survival priorities and the no-progress rule', () => {
  const text = buildDecisionInstructions({ objective: 'mine dirt', targets: { dirt: 4 } });
  assert.match(text, /flee/);
  assert.match(text, /sleep/);
  assert.match(text, /eat/);
  assert.match(text, /attack only when health is high enough/i);
  assert.match(text, /death site/);
  assert.match(text, /Never repeat an action that just produced no progress/);
  assert.match(text, /wait only when it is the only option/i);
});

test('anti-loop scenario: a stagnant goto loop gets excluded and later retried', () => {
  // Simula il loop del controller: 3 goto senza progresso -> esclusione.
  const history = [];
  let options = [opt('goto_waypoint'), opt('mine_stone')];
  let excludedKeys = [];
  for (let step = 1; step <= 4; step++) {
    if (step > 1) {
      history.push({ key: 'goto_waypoint', stagnant: true });
      if (detectRepeatedAction(history, 'goto_waypoint').repeated) {
        excludedKeys = [{ key: 'goto_waypoint', reason: 'anti_loop_until_7' }];
      }
    }
    const filtered = filterOptions(options, history, { excludeKeys: excludedKeys });
    if (step <= 3) assert.deepEqual(filtered.options.map(o => o.key), ['goto_waypoint', 'mine_stone']);
    else {
      assert.deepEqual(filtered.options.map(o => o.key), ['mine_stone']);
      assert.deepEqual(filtered.excluded, [{ key: 'goto_waypoint', reason: 'anti_loop_until_7' }]);
    }
  }
  // Al rientro del cooldown, con un'altra azione nel mezzo, goto torna proponibile.
  history.push({ key: 'mine_stone', stagnant: false });
  const later = filterOptions([opt('goto_waypoint'), opt('mine_stone')], history);
  assert.deepEqual(later.options.map(o => o.key), ['goto_waypoint', 'mine_stone']);
});

test('withStickyFollow keeps an open follow on every plan of the goal', () => {
  // Un ordine "seguimi" e' un impegno del goal: il piano puo' cambiare
  // (replan, piano dello skill) ma il `follow` deve restare agganciato.
  const replanned = { objective: 'stand near the waypoint', targets: {}, waypoint: { x: 1, z: 2 } };
  assert.deepEqual(withStickyFollow(replanned, 'Ale'), {
    objective: 'stand near the waypoint', targets: {}, waypoint: { x: 1, z: 2 }, follow: 'Ale',
  });
  // Senza ordine aperto il piano non viene toccato (nemmeno la sua identita':
  // il fast-path deterministico confronta il piano, non delle copie).
  assert.equal(withStickyFollow(replanned, null), replanned);
  assert.equal(withStickyFollow(replanned, undefined), replanned);
  const already = { objective: 'Follow Ale', follow: 'Ale' };
  assert.equal(withStickyFollow(already, 'Ale'), already);
  // Un follow diverso (nuovo ordine) vince su quello vecchio.
  assert.equal(withStickyFollow(already, 'Bob').follow, 'Bob');
  assert.deepEqual(withStickyFollow(null, 'Bob'), { follow: 'Bob' });
});

test('isStopOrder recognizes stop orders and never a follow request', () => {
  // Il fallback deterministico di humanCommandPlan trasforma ogni ordine in
  // "segui chi ti ha scritto": "fermati" deve esserne escluso, altrimenti il
  // goal sticky non si chiude piu' (bug live del 04/10).
  for (const message of ['fermati', 'ok fermati', 'stop', 'adesso basta', 'aspettami qui', 'resta dove sei', 'stay there', 'wait for me', 'smettila']) {
    assert.equal(isStopOrder(message), true, `"${message}" is a stop order`);
  }
  for (const message of ['seguimi', 'vieni con me', 'mina 4 dirt', 'portami del cibo', 'aiutami con gli zombie', 'come here', '']) {
    assert.equal(isStopOrder(message), false, `"${message}" is not a stop order`);
  }
  assert.equal(isStopOrder(null), false);
  assert.equal(isStopOrder(undefined), false);
});

// Un ordine di equipaggiamento è deterministico (nessun planner, nessun
// modello): l'harness offre `equip_armor` solo se l'inventario ha pezzi, quindi
// il riconoscimento deve essere stretto — "mettiti a lavorare" resta un ordine
// normale, non un ordine di equipaggiamento.
test('isEquipOrder recognizes equip orders and only those', () => {
  for (const message of [
    "equipaggiati con l'elmetto",
    'equipaggiati con armatura in bronzo',
    'equipaggia tutto',
    "mettiti l'armatura in bronzo",
    'mettiti il casco',
    'indossa i gambali',
    'wear your helmet',
    'put on your boots',
    'mettiti la zucca',
    "mettiti lo scudo nell'altra mano",
  ]) {
    assert.equal(isEquipOrder(message), true, `"${message}" è un ordine di equipaggiamento`);
  }
  for (const message of ['mettiti a lavorare', 'mettiti in cammino', 'seguimi', 'mina 4 dirt', 'prendi la terra', '', 'quanti cuori hai?']) {
    assert.equal(isEquipOrder(message), false, `"${message}" non è un ordine di equipaggiamento`);
  }
  assert.equal(isEquipOrder(null), false);
  assert.equal(isEquipOrder(undefined), false);
});
