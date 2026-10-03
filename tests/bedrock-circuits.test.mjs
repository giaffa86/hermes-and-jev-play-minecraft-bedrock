// Redstone (R3 di docs/wiki/redstone.md): costruzione di un circuito
// dichiarativo — piano, sito libero, piazzamento in ordine, ritardo dei
// repeater, trigger, verifica delle proprietà e ripristino del trigger.
// Mondo finto: nessun socket, nessun pathfinder, nessuna attesa reale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const key = (p) => `${p.x},${p.y},${p.z}`;
const YAW = { south: 0, west: 90, north: 180, east: 270 };

// Il fixture modella il server in tre punti: il piazzamento (consuma
// l'inventario e scrive il blocco, con la direzione che il server decide), il
// ritardo dei repeater (proprietà) e il trigger (leva che inverte `open_bit` e
// comanda le celle in `link`). Il catalogo è quello vero, letto da circuits/.
function circuitAdapter ({
  cells = {}, inventory = {}, feet = { x: 0.5, y: 71, z: 0.5 }, facing = 'south',
  link = [], floor = true, refuse = null, serverFacing = () => 'south', linkDelayMs = 0, traceUpdates = true,
  recipeData = null, tableNearby = false,
} = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.dead = false;
  adapter.client = {};
  adapter._feet = { ...feet };
  adapter.position = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  adapter._lastYaw = YAW[facing] ?? 0;
  adapter.inventory = { ...inventory };
  adapter.nearbyBlocks = {};
  adapter.inventorySlots = [];
  adapter.selectedHotbar = 0;
  adapter.plan = null;

  const blocks = new Map();
  const put = (position, name, properties = {}) => blocks.set(key(position), { name, position: { ...position }, getProperties: () => properties });
  if (floor) {
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 8; z++) put({ x, y: feet.y - 1, z }, 'stone');
    }
  }
  for (const [cellKey, value] of Object.entries(cells)) {
    const [x, y, z] = cellKey.split(',').map(Number);
    put({ x, y, z }, value.name, value.properties ?? {});
  }

  const events = { placed: [], logs: [], delays: [], triggers: [], mined: [] };
  adapter.world.loaded = new Map([['0,0', {}]]);
  adapter.world.blockAt = ({ x, y, z }) => blocks.get(`${x},${y},${z}`) ?? null;
  adapter.world.runtimeIdAt = () => 1;
  adapter.world.findBlocks = (name) => (tableNearby && name === 'crafting_table' ? [{ name: 'crafting_table' }] : []);
  // Ricette finte nel formato del crafting_data del server: `recipeData` è
  // {item: {width, height, input}}, cioè esattamente ciò che serve al craft.
  if (recipeData) {
    const byOutput = new Map();
    const bodies = [];
    let networkId = 1;
    for (const [item, recipe] of Object.entries(recipeData)) {
      const entry = { network_id: networkId++ };
      byOutput.set(item, [entry]);
      bodies.push({ network_id: entry.network_id, ...recipe });
    }
    adapter.recipes = byOutput;
    adapter.craftingData = { shaped_recipes: bodies, shapeless_recipes: [] };
  }
  adapter._yawTo = () => 0;
  adapter._lookAt = () => ({ yaw: 0, pitch: 0 });
  adapter.log = (type, data) => events.logs.push({ type, data });
  // La reachability resta fuori: il fixture non ha un pathfinder e il builder
  // non deve muoversi per piazzare celle che ha già a un passo dal bot.
  adapter._reachabilityUsable = () => false;
  adapter._placeAtCell = async (item, block, target, support, face, clickPos, opts) => {
    events.placed.push({ item, block, target: { ...target }, support: { ...support }, face, yaw: opts?.yaw ?? null });
    if (refuse && refuse(block, target)) return { ok: false, error: 'place_not_confirmed', block, position: target };
    if ((adapter.inventory[item] ?? 0) < 1) return { ok: false, error: 'missing_item' };
    adapter.inventory[item] -= 1;
    const facingProp = serverFacing(block, target);
    put(target, block, facingProp ? { facing_direction: facingProp } : {});
    // Il registro dei blocchi posseduti è un effetto del metodo vero: lo stub
    // deve riprodurlo, altrimenti teardown e rollback non hanno nulla da cui
    // partire.
    adapter._placedBlocks.set(key(target), { block, item, at: Date.now(), source: 'place', circuit: null });
    return { ok: true, block, position: target };
  };
  adapter._mineBlock = async (block) => {
    events.mined.push({ name: block?.name ?? null, position: { ...block?.position } });
    blocks.delete(key(block.position));
    return { ok: true, block: block.name, position: block.position };
  };
  adapter._setRepeaterDelay = async (wanted, { position } = {}) => {
    events.delays.push({ position: { ...position }, wanted });
    const cell = blocks.get(key(position));
    if (cell) {
      const next = { ...cell.getProperties?.(), repeater_delay: wanted };
      put(position, cell.name, next);
    }
    return { ok: true, position, delay: wanted };
  };
  adapter._useRedstone = async ({ position, restore = true } = {}) => {
    events.triggers.push({ position: { ...position }, restore });
    const cell = blocks.get(key(position));
    const before = cell?.getProperties?.().open_bit === true;
    const after = !before;
    if (cell) put(position, cell.name, { ...cell.getProperties?.(), open_bit: after });
    const effects = [];
    for (const [from, to] of link) {
      if (from !== key(position)) continue;
      const target = blocks.get(to);
      if (!target) continue;
      if (target.name === 'fence_gate') put(target.position, 'fence_gate', { ...target.getProperties?.(), open_bit: after });
      else put(target.position, after ? 'lit_redstone_lamp' : 'redstone_lamp', {});
      effects.push(blocks.get(to).name);
      // Il server riporta il cambio dell'output: `linkDelayMs` modella il tempo
      // di propagazione, che è quello che R4 deve misurare.
      if (traceUpdates) adapter._noteRedstoneUpdate(target.position, Date.now() + linkDelayMs);
    }
    return { ok: true, name: 'lever', position, before, after, effects, restored: restore ? false : null };
  };
  return { adapter, blocks, events };
}

const LAMP_SWITCH = { redstone_lamp: 1, lever: 1 };
const DELAY_LINE = { cobblestone: 1, lever: 1, repeater: 3, redstone_lamp: 1 };

test('build_circuit_lamp_switch costruisce, aziona, verifica e ripristina il trigger', async () => {
  const { adapter, blocks, events } = circuitAdapter({
    inventory: { ...LAMP_SWITCH },
    link: [['0,72,1', '0,71,1']],
  });
  const result = await adapter.executeAction('build_circuit_lamp_switch');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.id, 'lamp_switch');
  assert.deepEqual(result.origin, { x: 0, y: 71, z: 1 });
  assert.equal(result.facing, 'south');
  assert.equal(result.steps, 2);
  assert.deepEqual(result.placed.map(p => [p.label, p.cell]), [
    ['lamp', { x: 0, y: 71, z: 1 }],
    ['lever', { x: 0, y: 72, z: 1 }],
  ]);
  assert.deepEqual(events.placed.map(p => p.item), ['redstone_lamp', 'lever']);
  assert.deepEqual(events.placed[0].support, { x: 0, y: 70, z: 1 }, 'la lampada poggia sul terreno');
  assert.deepEqual(events.placed[1].support, { x: 0, y: 71, z: 1 }, 'la leva poggia sulla lampada appena piazzata');
  // La verifica si fa con il trigger acceso: due toggle (on, poi ripristino).
  assert.equal(events.triggers.length, 2);
  assert.deepEqual(events.triggers.map(t => t.position), [{ x: 0, y: 72, z: 1 }, { x: 0, y: 72, z: 1 }]);
  assert.equal(result.trigger.before, false);
  assert.equal(result.trigger.after, true);
  assert.equal(result.trigger.restored, false, 'la leva è tornata a riposo');
  assert.equal(result.success.ok, true);
  assert.deepEqual(result.success.checks.map(c => c.ok), [true, true]);
  assert.equal(blocks.get('0,71,1').name, 'redstone_lamp', 'niente clock lasciato acceso');
  assert.equal(blocks.get('0,72,1').getProperties().open_bit, false);
  assert.deepEqual(adapter.inventory, { redstone_lamp: 0, lever: 0 });
  assert.equal(adapter._circuitLast.ok, true);
  assert.ok(events.logs.some(l => l.type === 'circuit_built'));
});

test('un circuito sconosciuto o dichiarato non costruibile fallisce subito e in modo tipizzato', async () => {
  const { adapter, events } = circuitAdapter({ inventory: { ...LAMP_SWITCH } });
  const unknown = await adapter.executeAction('build_circuit_mega_lamp');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown_circuit');
  assert.equal(unknown.known.length, 8);
  assert.ok(unknown.known.includes('lamp_switch'));

  const declared = await adapter.executeAction('build_circuit_auto_harvest');
  assert.equal(declared.error, 'circuit_not_buildable');
  assert.match(declared.reason, /M1 fluid milestone/);
  assert.equal(events.placed.length, 0, 'un blueprint non costruibile non tocca il mondo');
});

test('senza materiali o con il sito occupato il cantiere non inizia', async () => {
  const poor = circuitAdapter({ inventory: { lever: 4 } });
  const missing = await poor.adapter.executeAction('build_circuit_lamp_switch');
  assert.equal(missing.error, 'missing_materials');
  assert.deepEqual(missing.missing, [{ item: 'redstone_lamp', need: 1, have: 0 }]);
  assert.equal(poor.events.placed.length, 0);

  const occupied = circuitAdapter({ inventory: { ...LAMP_SWITCH }, cells: { '0,71,1': { name: 'oak_planks' } } });
  const blocked = await occupied.adapter.executeAction('build_circuit_lamp_switch');
  assert.equal(blocked.error, 'circuit_site_blocked');
  assert.deepEqual(blocked.blocked.map(b => b.reason), ['occupied']);
  assert.equal(occupied.events.placed.length, 0);

  // Un baule è un supporto che il piazzamento non può cliccare (lo aprirebbe).
  const usable = circuitAdapter({ inventory: { ...LAMP_SWITCH }, floor: false, cells: { '0,70,1': { name: 'chest' }, '0,70,2': { name: 'stone' } } });
  const refused = await usable.adapter.executeAction('build_circuit_lamp_switch');
  assert.equal(refused.error, 'circuit_site_blocked');
  assert.deepEqual(refused.blocked.map(b => `${b.reason}:${b.name}`), ['usable_block:chest']);
});

test('un piazzamento che il server non conferma interrompe il cantiere e lo dice', async () => {
  const { adapter, events } = circuitAdapter({
    inventory: { ...LAMP_SWITCH },
    refuse: (block) => block === 'lever',
  });
  const result = await adapter.executeAction('build_circuit_lamp_switch');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'circuit_incomplete');
  assert.equal(result.placed.length, 1);
  assert.deepEqual(result.failed.map(f => [f.label, f.error]), [['lever', 'place_not_confirmed']]);
  assert.equal(result.trigger, null);
  assert.equal(result.success, null);
  assert.equal(events.triggers.length, 0, 'senza tutti i pezzi non si aziona nulla');
  assert.ok(events.logs.some(l => l.type === 'circuit_incomplete'));
  // R4: il cantiere a metà non resta in piedi.
  assert.equal(result.rollback.removed, 1, 'la lampada già piazzata viene tolta');
  assert.equal(events.mined.length, 1);
  assert.equal(adapter._ownedCircuitCells().length, 0, 'il registro resta pulito');
});

test('una direzione imposta dal server sbagliata è un errore tipizzato, non un circuito storto', async () => {
  const wrong = circuitAdapter({
    inventory: { ...DELAY_LINE },
    serverFacing: (block) => (block === 'unpowered_repeater' ? 'north' : null),
  });
  const result = await wrong.adapter.executeAction('build_circuit_delay_line');
  assert.equal(result.error, 'circuit_incomplete');
  assert.deepEqual(result.failed.map(f => [f.label, f.error, f.facing]), [['repeater_1', 'orientation_not_confirmed', 'north']]);
  assert.equal(result.placed.length, 2, 'base e leva sono già a posto');
  assert.equal(wrong.events.triggers.length, 0);
  assert.ok(wrong.events.logs.some(l => l.type === 'circuit_orientation_failed'));
});

test('build_circuit_delay_line imposta i ritardi, misura il ritardo reale e verifica la lampada accesa', async () => {
  const { adapter, blocks, events } = circuitAdapter({
    inventory: { ...DELAY_LINE },
    link: [['0,72,1', '0,71,5']],
    linkDelayMs: 300,
  });
  const result = await adapter.executeAction('build_circuit_delay_line');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.steps, 6);
  assert.deepEqual(events.delays.map(d => [d.position.z, d.wanted]), [[2, 0], [3, 1], [4, 2]]);
  assert.deepEqual(result.post.map(p => p.ok), [true, true, true]);
  assert.equal(result.expectedDelayTicks, 6);
  assert.deepEqual(result.success.checks.map(c => c.ok), [true, true]);
  assert.equal(result.trigger.restored, false);
  assert.equal(blocks.get('0,71,5').name, 'redstone_lamp', 'la lampada è tornata spenta con la leva');
  assert.equal(events.placed.length, 6);
  // R4: il ritardo è misurato sugli aggiornamenti del server, non dedotto.
  assert.equal(result.delay.expectedMs, 300);
  assert.equal(result.delay.measuredMs, 300);
  assert.equal(result.delay.measuredTicks, 6);
  assert.equal(result.delay.ok, true);
});

test('un ritardo diverso da quello dichiarato è un errore, non un successo', async () => {
  const { adapter } = circuitAdapter({
    inventory: { ...DELAY_LINE },
    link: [['0,72,1', '0,71,5']],
    linkDelayMs: 900,
  });
  const result = await adapter.executeAction('build_circuit_delay_line');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'circuit_delay_mismatch');
  assert.equal(result.delay.measuredMs, 900);
  assert.equal(result.delay.expectedMs, 300);
  assert.equal(result.delay.ok, false);
  assert.equal(result.success.checks.every(c => c.ok), true, 'i blocchi sono giusti: è il tempo a non tornare');
});

test('un circuito che chiede la misura ma non produce aggiornamenti resta non misurato', async () => {
  const { adapter } = circuitAdapter({
    inventory: { ...DELAY_LINE },
    link: [['0,72,1', '0,71,5']],
    traceUpdates: false,
  });
  const result = await adapter.executeAction('build_circuit_delay_line');
  assert.equal(result.ok, false);
  assert.equal(result.error, 'circuit_delay_unmeasured');
  assert.equal(result.delay.required, true);
  assert.equal(result.delay.measuredMs, null);
  assert.equal(result.delay.ok, null);
});

test('teardown_circuit rimuove solo i blocchi piazzati dal bot', async () => {
  const { adapter, blocks, events } = circuitAdapter({
    inventory: { ...LAMP_SWITCH },
    link: [['0,72,1', '0,71,1']],
    cells: { '5,71,5': { name: 'stone' } },
  });
  const built = await adapter.executeAction('build_circuit_lamp_switch');
  assert.equal(built.ok, true);
  assert.equal(adapter._ownedCircuitCells().length, 2);
  // Un blocco che il bot non ha piazzato non è suo: non entra nel registro.
  assert.equal(adapter.options().map(o => o.key).includes('teardown_circuit'), true);

  const torn = await adapter.executeAction('teardown_circuit');
  assert.equal(torn.ok, true, JSON.stringify(torn));
  assert.equal(torn.removed.length, 2);
  assert.equal(torn.remaining, 0);
  assert.deepEqual(events.mined.map(m => m.name).sort(), ['lever', 'redstone_lamp']);
  assert.equal(blocks.get('5,71,5').name, 'stone', 'il terreno e il resto del mondo non si toccano');
  assert.equal(adapter.options().map(o => o.key).includes('teardown_circuit'), false, 'senza blocchi posseduti non si offre');
});

test('teardown_circuit non tocca un blocco che qualcun altro ha cambiato', async () => {
  const { adapter, blocks, events } = circuitAdapter({ inventory: { ...LAMP_SWITCH }, link: [['0,72,1', '0,71,1']] });
  await adapter.executeAction('build_circuit_lamp_switch');
  // Un altro giocatore sostituisce la lampada: il registro non è più la verità.
  blocks.set('0,71,1', { name: 'obsidian', position: { x: 0, y: 71, z: 1 }, getProperties: () => ({}) });
  const torn = await adapter.executeAction('teardown_circuit');
  assert.equal(torn.ok, true);
  assert.deepEqual(torn.skipped.map(s => [s.cell.y + ',' + s.cell.z, s.reason, s.found]), [['71,1', 'changed', 'obsidian']]);
  assert.equal(events.mined.length, 1, 'si rimuove solo ciò che è ancora quello che il bot ha piazzato');
  assert.equal(blocks.get('0,71,1').name, 'obsidian');
});

test('teardown di un circuito mai costruito è tipizzato e non fa nulla', async () => {
  const { adapter, events } = circuitAdapter({});
  const none = await adapter.executeAction('teardown_circuit');
  assert.equal(none.ok, false);
  assert.equal(none.error, 'nothing_to_tear_down');
  const id = await adapter.executeAction('teardown_circuit_lamp_switch');
  assert.equal(id.ok, false);
  assert.equal(id.error, 'no_circuit_built');
  assert.equal(events.mined.length, 0);
});

test('auto_lamp senza trigger si costruisce ma non si dichiara verificato', async () => {
  const { adapter, events } = circuitAdapter({ inventory: { cobblestone: 1, daylight_detector: 1, redstone_lamp: 1 } });
  const result = await adapter.executeAction('build_circuit_auto_lamp');
  assert.equal(result.ok, true);
  assert.equal(result.trigger, null);
  assert.equal(result.success, null, 'la luce dipende dall\'ora: nessun check inventato');
  assert.match(result.verifyNote, /time of day/);
  assert.equal(events.triggers.length, 0);
  assert.deepEqual(adapter._circuitsView().buildable, ['auto_door', 'auto_lamp', 'delay_line', 'lamp_switch']);
  assert.equal(adapter._circuitsView().invalid, null);
});

test('le opzioni offrono solo i circuiti che si possono davvero costruire', () => {
  const ready = circuitAdapter({ inventory: { ...LAMP_SWITCH, ...DELAY_LINE } });
  const keys = ready.adapter.options().map(o => o.key);
  assert.equal(keys.includes('build_circuit_lamp_switch'), true);
  assert.equal(keys.includes('build_circuit_delay_line'), true);
  assert.equal(keys.includes('build_circuit_auto_lamp'), false, 'senza materiali non si offre');
  assert.equal(keys.includes('build_circuit_auto_harvest'), false, 'dichiarato non costruibile');
  const option = ready.adapter.options().find(o => o.key === 'build_circuit_lamp_switch');
  assert.match(option.description, /needs 1 redstone_lamp, 1 lever/);

  const occupied = circuitAdapter({ inventory: { ...LAMP_SWITCH }, cells: { '0,71,1': { name: 'stone' } } });
  assert.equal(occupied.adapter.options().map(o => o.key).includes('build_circuit_lamp_switch'), false);
});

test('R5: un circuito senza materiali offre il craft del materiale mancante, non il cantiere', () => {
  const ingredient = name => ({ type: 'valid', descriptor_type: 'name', name });
  const lever = { width: 2, height: 1, input: [ingredient('stick'), ingredient('cobblestone')] };
  // Il cancello è 2x3: la ricetta chiede il tavolo da lavoro.
  const gate = { width: 2, height: 3, input: [ingredient('stick'), ingredient('oak_planks'), ingredient('stick'), ingredient('oak_planks'), ingredient('stick'), ingredient('stick')] };

  // Senza tavolo vicino, il cancello non è fabbricabile: resta solo la leva.
  const near = circuitAdapter({ inventory: { stick: 5, cobblestone: 1, oak_planks: 4 }, recipeData: { lever, fence_gate: gate } });
  const keys = near.adapter.options().map(o => o.key);
  assert.equal(keys.includes('build_circuit_auto_door'), false, 'senza materiali il cantiere non si offre');
  assert.equal(keys.includes('craft_lever'), true, 'la leva è fabbricabile con bastone + ciottolo');
  assert.equal(keys.includes('craft_fence_gate'), false, 'una ricetta 3x3 senza tavolo non si offre');
  const leverOption = near.adapter.options().find(o => o.key === 'craft_lever');
  assert.match(leverOption.description, /for the auto_door circuit/);
  assert.match(leverOption.description, /missing 1 lever/);
  // L'ingrediente mancante: senza ciottoli nulla è fabbricabile e non si offre niente.
  const bare = circuitAdapter({ inventory: { stick: 5, oak_planks: 4 }, recipeData: { lever, fence_gate: gate } });
  assert.deepEqual(bare.adapter.options().filter(o => o.key.startsWith('craft_lever')), []);

  // Con il tavolo il cancello diventa fabbricabile: la prima cosa mancante
  // nell'ordine dei `requires` è la leva, e il cancello è il passo successivo.
  const withTable = circuitAdapter({ inventory: { stick: 5, cobblestone: 1, oak_planks: 4 }, recipeData: { lever, fence_gate: gate }, tableNearby: true });
  const tableKeys = withTable.adapter.options().map(o => o.key);
  assert.equal(['craft_lever', 'craft_fence_gate'].some(k => tableKeys.includes(k)), true);
  assert.equal(circuitAdapter({ inventory: { stick: 5, cobblestone: 1, oak_planks: 4 }, recipeData: { lever, fence_gate: gate }, tableNearby: true }).adapter._craftableNow('fence_gate'), true);
  assert.equal(near.adapter._craftableNow('fence_gate'), false);

  // Materiali completi: si offre il cantiere e non i craft.
  const ready = circuitAdapter({ inventory: { stone: 1, lever: 1, fence_gate: 1 }, recipeData: { lever, fence_gate: gate } });
  const readyKeys = ready.adapter.options().map(o => o.key);
  assert.equal(readyKeys.includes('build_circuit_auto_door'), true);
  assert.equal(readyKeys.includes('craft_lever'), false);
  assert.equal(readyKeys.includes('craft_fence_gate'), false);
});

test('_facingFromYaw legge la direzione del cantiere dallo sguardo', () => {
  const { adapter } = circuitAdapter({});
  for (const [facing, yaw] of Object.entries(YAW)) {
    adapter._lastYaw = yaw;
    assert.equal(adapter._facingFromYaw(), facing);
  }
  adapter._lastYaw = 350;
  assert.equal(adapter._facingFromYaw(), 'south', 'lo yaw si normalizza');
  adapter._lastYaw = undefined;
  assert.equal(adapter._facingFromYaw(), 'south');
});

// --- R6: limiti e sicurezza -------------------------------------------------

test('R6: _placeAtCell rifiuta un blocco vietato prima di toccare l\'inventario', async () => {
  const { adapter, blocks, events } = circuitAdapter({ inventory: { tnt: 1 } });
  const real = BedrockAdapter.prototype._placeAtCell;
  const res = await real.call(adapter, 'tnt', 'tnt', { x: 0, y: 71, z: 1 }, { x: 0, y: 70, z: 1 }, 1);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'forbidden_block');
  assert.equal(res.block, 'tnt');
  assert.deepEqual(res.position, { x: 0, y: 71, z: 1 });
  assert.equal(events.placed.length, 0, 'nessun piazzamento');
  assert.equal(blocks.has('0,71,1'), false, 'nessun blocco scritto nel mondo');
  assert.equal(events.logs.filter(l => l.type === 'forbidden_place').length, 1);
  // Anche il nome normalizzato dal server non aggira la regola.
  const cmd = await real.call(adapter, 'command_block', 'minecraft:chain_command_block', { x: 0, y: 71, z: 1 }, { x: 0, y: 70, z: 1 }, 1);
  assert.equal(cmd.error, 'forbidden_block');
});

test('R6: build_circuit rifiuta un piano che passa per le celle del bot', async () => {
  const { adapter, events } = circuitAdapter({ inventory: { ...LAMP_SWITCH } });
  // Il piano normale parte davanti ai piedi, quindi il bot non è mai "in mezzo":
  // la guardia si prova con un piano costruito ad arte sulle celle occupate.
  adapter._circuitPlan = () => ({
    ok: true, id: 'lamp_switch', facing: 'south', origin: { x: 0, y: 71, z: 0 }, anchor: { x: 0, y: 71, z: 0 },
    steps: [{ index: 0, label: 'lamp', item: 'redstone_lamp', block: 'redstone_lamp', cell: { x: 0, y: 71, z: 0 }, support: { x: 0, y: 70, z: 0 }, face: 1, facing: null, clickPos: { x: 0.5, y: 1, z: 0.5 } }],
    need: { redstone_lamp: 1 }, missing: [], trigger: null, success: [], post: [], measure: null, buildable: true, blocked: [],
  });
  const res = await adapter._buildCircuit('lamp_switch', { facing: 'south' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'circuit_unsafe_for_bot');
  assert.deepEqual(res.unsafe, [{ label: 'lamp', cell: { x: 0, y: 71, z: 0 }, reason: 'bot_in_the_way' }]);
  assert.equal(events.placed.length, 0, 'non si muove e non piazza nulla');
});

test('R6: lo stesso input non si aziona due volte in pochi ms (niente clock a mano)', async () => {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  const blocks = new Map();
  const clicks = [];
  adapter._redstoneCensus = () => ({ ready: true, components: [{ position: { x: 0, y: 71, z: 1 }, name: 'lever', distance: 1 }] });
  adapter.world.blockAt = ({ x, y, z }) => blocks.get(`${x},${y},${z}`) ?? null;
  blocks.set('0,71,1', { name: 'lever', position: { x: 0, y: 71, z: 1 }, getProperties: () => ({ open_bit: false }) });
  adapter._reachabilityUsable = () => false;
  adapter._redstoneView = () => ({ ready: true, components: [], inputs: [], outputs: [], active: [] });
  adapter._noteRedstoneUpdate = () => {};
  adapter._clickRedstoneInput = async (position, on) => {
    clicks.push({ position: { ...position }, on });
    blocks.set('0,71,1', { name: 'lever', position: { x: 0, y: 71, z: 1 }, getProperties: () => ({ open_bit: on }) });
    return { ok: true };
  };
  const real = BedrockAdapter.prototype._useRedstone;
  adapter._lastRedstoneToggleAt = new Map();

  const first = await real.call(adapter, { position: { x: 0, y: 71, z: 1 } });
  assert.equal(first.ok, true);
  const second = await real.call(adapter, { position: { x: 0, y: 71, z: 1 } });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'redstone_toggle_too_soon');
  assert.ok(second.waitMs > 0 && second.waitMs <= 500, `waitMs ragionevole (${second.waitMs})`);
  assert.equal(clicks.length, 2, 'il secondo comando non è partito');

  // Il cantiere è esente: trigger e ripristino sono due click voluti e contigui.
  const unguarded = await real.call(adapter, { position: { x: 0, y: 71, z: 1 }, restore: false, guard: false });
  assert.equal(unguarded.ok, true);
  const off = await real.call(adapter, { position: { x: 0, y: 71, z: 1 }, restore: false, guard: false });
  assert.equal(off.ok, true);
  assert.equal(clicks.length, 4);
});

test('R6: /observe.circuits pubblica i limiti di sicurezza', () => {
  const { adapter } = circuitAdapter({});
  const view = adapter._circuitsView();
  assert.deepEqual(view.limits, { maxSteps: 48, maxComponents: 24, minClockTicks: 8, toggleMinIntervalMs: 500 });
  assert.equal(adapter.observe().circuits.limits.maxComponents, 24);
});
