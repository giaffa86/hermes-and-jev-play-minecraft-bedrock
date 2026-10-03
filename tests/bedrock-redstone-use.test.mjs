// Redstone (R2 di docs/wiki/redstone.md): azionare un input con verifica dello
// stato e dell'effetto a valle, sensing continuo sulla cache (update_block senza
// nuove scansioni), diagnosi `sense_redstone`, opzioni e criteri.
// Mondo finto: nessun socket, nessuna attesa reale.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const props = (values) => ({ getProperties: () => values });
const key = (p) => `${p.x},${p.y},${p.z}`;

// Mondo finto con il censimento *vero* (findBlocks sui blocchi della mappa, con
// il conteggio delle chiamate) e un modello del server: il click su una leva ne
// inverte lo stato e, se la cella è in `link`, accende/spegne la lampada
// collegata. `inert` modella un click che non produce nulla di osservabile.
function useAdapter ({ cells = {}, loaded = 4, feet = { x: 0.5, y: 71, z: 0.5 }, link = [], inert = false } = {}) {
  const adapter = new BedrockAdapter({ logger: { log () {} } });
  adapter.spawned = true;
  adapter.status = 'spawned';
  adapter.dead = false;
  adapter.client = {};
  adapter._feet = { ...feet };
  adapter.position = { x: feet.x, y: feet.y + 1.62, z: feet.z };
  adapter.nearbyBlocks = {};
  adapter.inventorySlots = [];
  adapter.selectedHotbar = 0;
  adapter.plan = null;
  const blocks = new Map(Object.entries(cells));
  const calls = [];
  adapter.world.loaded = new Map(Array.from({ length: loaded }, (_, i) => [`${i},0`, {}]));
  adapter.world.blockAt = ({ x, y, z }) => blocks.get(`${x},${y},${z}`) ?? null;
  adapter.world.runtimeIdAt = () => 1;
  adapter.world.findBlocks = (names, position, radius = 32, count = 256) => {
    calls.push({ names, radius, count });
    if (adapter.world.loaded?.size === 0) return [];
    const wanted = new Set(Array.isArray(names) ? names : [names]);
    const out = [];
    for (const [cellKey, block] of blocks) {
      if (!wanted.has(block?.name)) continue;
      const [x, y, z] = cellKey.split(',').map(Number);
      const distance = Math.hypot(x - position.x, y - position.y, z - position.z);
      if (distance > radius) continue;
      out.push({ ...block, position: { x, y, z }, distance });
      if (out.length >= count) break;
    }
    return out;
  };
  adapter.world = adapter.world;
  adapter._yawTo = () => 0;
  adapter._lookAt = () => ({ yaw: 0, pitch: 0 });
  const events = { input: [], logs: [] };
  adapter.log = (type, data) => events.logs.push({ type, data });
  adapter._queueAuthInput = async (frame) => {
    events.input.push(frame);
    if (inert) return;
    const pos = frame?.transaction?.data?.block_position;
    if (!pos) return;
    const block = blocks.get(key(pos));
    const p = block?.getProperties?.();
    if (p?.open_bit != null) blocks.set(key(pos), { ...block, ...props({ ...p, open_bit: !p.open_bit }) });
    if (p?.button_pressed_bit != null) blocks.set(key(pos), { ...block, ...props({ ...p, button_pressed_bit: !p.button_pressed_bit }) });
    const on = blocks.get(key(pos))?.getProperties?.().open_bit === true
      || blocks.get(key(pos))?.getProperties?.().button_pressed_bit === true;
    for (const [from, to] of link) {
      if (from !== key(pos)) continue;
      const lamp = blocks.get(to);
      if (!lamp) continue;
      blocks.set(to, { name: on ? 'lit_redstone_lamp' : 'redstone_lamp', ...props({}) });
    }
  };
  return { adapter, blocks, calls, events };
}

test('use_redstone aziona la leva, legge l\'effetto a valle e la riporta a riposo', async () => {
  const { adapter, blocks, events } = useAdapter({
    cells: {
      '2,71,0': { name: 'lever', position: { x: 2, y: 71, z: 0 }, ...props({ open_bit: false, lever_direction: 'north' }) },
      '3,71,0': { name: 'redstone_lamp', position: { x: 3, y: 71, z: 0 }, ...props({}) },
    },
    link: [['2,71,0', '3,71,0']],
  });
  const result = await adapter._useRedstone();
  assert.equal(result.ok, true);
  assert.equal(result.name, 'lever');
  assert.deepEqual(result.position, { x: 2, y: 71, z: 0 });
  assert.equal(result.before, false);
  assert.equal(result.after, true);
  assert.equal(result.active, true, 'la lampada si è accesa');
  assert.deepEqual(result.effects.map(e => e.name), ['lit_redstone_lamp']);
  assert.equal(result.restored, true);
  // Due click: accendi, poi riporta a riposo (nessun clock lasciato attivo).
  assert.equal(events.input.filter(f => f.transaction?.data?.action_type === 'click_block').length, 2);
  assert.equal(blocks.get('2,71,0').getProperties().open_bit, false, 'la leva torna chiusa');
  assert.equal(blocks.get('3,71,0').name, 'redstone_lamp', 'la lampada torna spenta');
  const logged = events.logs.find(l => l.type === 'use_redstone');
  assert.deepEqual(logged.data, {
    name: 'lever', position: { x: 2, y: 71, z: 0 }, before: false, after: true,
    effects: ['lit_redstone_lamp'], restored: true,
  });
});

test('use_redstone con restore:false lascia l\'input acceso', async () => {
  const { adapter, blocks, events } = useAdapter({
    cells: { '2,71,0': { name: 'lever', position: { x: 2, y: 71, z: 0 }, ...props({ open_bit: false }) } },
  });
  const result = await adapter._useRedstone({ restore: false });
  assert.equal(result.ok, true);
  assert.equal(result.restored, null, 'non c\'è nulla da riportare a riposo');
  assert.equal(blocks.get('2,71,0').getProperties().open_bit, true);
  assert.equal(events.input.length, 1);
});

test('use_redstone non aziona un input fuori dal componente raggiungibile', async () => {
  const { adapter, events } = useAdapter({
    cells: { '2,71,0': { name: 'lever', position: { x: 2, y: 71, z: 0 }, ...props({ open_bit: false }) } },
  });
  adapter._reachabilityUsable = () => true;
  adapter.approachReachable = () => false;
  // `_pickRedstoneInput` scarta già gli input non a portata (l'opzione non viene
  // offerta): la guardia si esercita su una cella chiesta esplicitamente.
  assert.equal(adapter._pickRedstoneInput(), null);
  const result = await adapter._useRedstone({ position: { x: 2, y: 71, z: 0 } });
  assert.deepEqual(result, { ok: false, error: 'input_unreachable', name: 'lever', position: { x: 2, y: 71, z: 0 }, distance: 1.6 });
  assert.equal(events.input.length, 0, 'nessun pacchetto per un bersaglio irraggiungibile');
});

test('use_redstone distingue "niente input" da "non è un input" e da uno stato illeggibile', async () => {
  const empty = useAdapter({ cells: { '3,71,0': { name: 'redstone_lamp', position: { x: 3, y: 71, z: 0 }, ...props({}) } } });
  assert.deepEqual(await empty.adapter._useRedstone(), { ok: false, error: 'no_redstone_input', position: null });

  const lamp = useAdapter({ cells: { '3,71,0': { name: 'redstone_lamp', position: { x: 3, y: 71, z: 0 }, ...props({}) } } });
  const notInput = await lamp.adapter._useRedstone({ position: { x: 3, y: 71, z: 0 } });
  assert.equal(notInput.ok, false);
  assert.equal(notInput.error, 'not_an_input');
  assert.equal(notInput.name, 'redstone_lamp');

  // Leva senza proprietà leggibili: non si clicca (il cambio non sarebbe verificabile).
  const opaque = useAdapter({ cells: { '2,71,0': { name: 'lever', position: { x: 2, y: 71, z: 0 } } } });
  const unreadable = await opaque.adapter._useRedstone();
  assert.equal(unreadable.error, 'redstone_state_unreadable');
  assert.equal(opaque.events.input.length, 0);
});

test('use_redstone segnala un click senza effetto e un mondo non caricato', async () => {
  const inert = useAdapter({
    cells: { '2,71,0': { name: 'lever', position: { x: 2, y: 71, z: 0 }, ...props({ open_bit: false }) } },
    inert: true,
  });
  const stuck = await inert.adapter._useRedstone({ timeoutMs: 120 });
  assert.equal(stuck.ok, false);
  assert.equal(stuck.error, 'redstone_not_toggled');
  assert.equal(stuck.state, false);
  assert.equal(stuck.wanted, true);
  assert.equal(inert.events.input.length, 1, 'il click è stato provato una volta sola');

  const unloaded = useAdapter({
    cells: { '2,71,0': { name: 'lever', position: { x: 2, y: 71, z: 0 }, ...props({ open_bit: false }) } },
    loaded: 0,
  });
  assert.deepEqual(await unloaded.adapter._useRedstone(), { ok: false, error: 'redstone_unknown' });
});

test('un update_block aggiorna la cache in place senza rifare la scansione', () => {
  const { adapter, blocks, calls } = useAdapter({
    cells: {
      '2,71,0': { name: 'lever', position: { x: 2, y: 71, z: 0 }, ...props({ open_bit: false }) },
      '3,71,0': { name: 'redstone_lamp', position: { x: 3, y: 71, z: 0 }, ...props({}) },
    },
  });
  const before = adapter._redstoneView();
  assert.equal(before.maxPower, 0);
  assert.equal(before.active, false);
  assert.equal(calls.length, 1);

  // Il server manda update_block: leva azionata e lampada accesa.
  blocks.set('2,71,0', { name: 'lever', position: { x: 2, y: 71, z: 0 }, ...props({ open_bit: true }) });
  blocks.set('3,71,0', { name: 'lit_redstone_lamp', position: { x: 3, y: 71, z: 0 }, ...props({}) });
  adapter._noteRedstoneUpdate({ x: 2, y: 71, z: 0 });
  const leverChange = adapter._redstoneView().lastChange;
  assert.equal(leverChange.name, 'lever');
  assert.equal(leverChange.previous, 0, 'la leva era spenta nella cache');
  assert.equal(leverChange.power, 15);
  adapter._noteRedstoneUpdate({ x: 3, y: 71, z: 0 });

  const after = adapter._redstoneView();
  assert.equal(calls.length, 1, 'nessuna nuova findBlocks: la cache è stata aggiornata in place');
  assert.equal(after.maxPower, 15);
  assert.equal(after.active, true);
  assert.deepEqual(after.activeOutputs.map(o => o.name), ['lit_redstone_lamp']);
  assert.equal(after.components.length, 2, 'leva e lampada restano gli unici componenti');
  assert.deepEqual(after.lastChange, {
    position: { x: 3, y: 71, z: 0 }, name: 'lit_redstone_lamp',
    // La lampada spenta non espone alcuno stato di potenza: `null` (ignoto), non 0.
    previous: null, power: 15, powerKnown: true, at: after.lastChange.at,
  });
});

test('un update_block non redstone non tocca la cache', () => {
  const { adapter, calls } = useAdapter({
    cells: {
      '2,71,0': { name: 'lever', position: { x: 2, y: 71, z: 0 }, ...props({ open_bit: false }) },
      '5,71,0': { name: 'stone', position: { x: 5, y: 71, z: 0 } },
    },
  });
  const before = adapter._redstoneView();
  adapter._noteRedstoneUpdate({ x: 5, y: 71, z: 0 });
  const after = adapter._redstoneView();
  assert.equal(after.lastChange, null, 'nessun cambio redstone registrato');
  assert.equal(after.components.length, before.components.length);
  assert.equal(calls.length, 1);
});

test('_pickRedstoneInput prende la leva a portata, non una lampada', () => {
  const { adapter } = useAdapter({
    cells: {
      '6,71,0': { name: 'lever', position: { x: 6, y: 71, z: 0 }, ...props({ open_bit: false }) },
      '2,71,0': { name: 'wooden_button', position: { x: 2, y: 71, z: 0 }, ...props({ button_pressed_bit: false }) },
      '3,71,0': { name: 'redstone_lamp', position: { x: 3, y: 71, z: 0 }, ...props({}) },
    },
  });
  assert.deepEqual(adapter._pickRedstoneInput(), { ...adapter._pickRedstoneInput() });
  assert.equal(adapter._pickRedstoneInput().name, 'wooden_button', 'il più vicino');

  const lampsOnly = useAdapter({ cells: { '3,71,0': { name: 'redstone_lamp', position: { x: 3, y: 71, z: 0 }, ...props({}) } } });
  assert.equal(lampsOnly.adapter._pickRedstoneInput(), null);
});

test('/options offre use_redstone solo con un input a portata, sense_redstone con qualunque componente', () => {
  const wired = useAdapter({
    cells: {
      '2,71,0': { name: 'lever', position: { x: 2, y: 71, z: 0 }, ...props({ open_bit: false }) },
      '3,71,0': { name: 'redstone_lamp', position: { x: 3, y: 71, z: 0 }, ...props({}) },
    },
  });
  const keys = wired.adapter.options().map(o => o.key);
  assert.equal(keys.includes('use_redstone'), true);
  assert.equal(keys.includes('sense_redstone'), true);
  const useOption = wired.adapter.options().find(o => o.key === 'use_redstone');
  assert.match(useOption.description, /Toggle the lever at \{"x":2,"y":71,"z":0\}/);

  // Solo un output: si legge (sense) ma non si aziona (nessun input).
  const outputOnly = useAdapter({ cells: { '3,71,0': { name: 'redstone_lamp', position: { x: 3, y: 71, z: 0 }, ...props({}) } } });
  const outKeys = outputOnly.adapter.options().map(o => o.key);
  assert.equal(outKeys.includes('use_redstone'), false);
  assert.equal(outKeys.includes('sense_redstone'), true);

  // Mondo pulito: nessuna opzione redstone.
  const clean = useAdapter({ cells: { '5,71,0': { name: 'stone', position: { x: 5, y: 71, z: 0 } } } });
  const cleanKeys = clean.adapter.options().map(o => o.key);
  assert.equal(cleanKeys.includes('use_redstone'), false);
  assert.equal(cleanKeys.includes('sense_redstone'), false, 'un censimento vuoto non merita un turno');
});

test('executeAction instrada use_redstone e sense_redstone', async () => {
  const { adapter, blocks } = useAdapter({
    cells: {
      '2,71,0': { name: 'lever', position: { x: 2, y: 71, z: 0 }, ...props({ open_bit: false }) },
      '3,71,0': { name: 'redstone_lamp', position: { x: 3, y: 71, z: 0 }, ...props({}) },
    },
    link: [['2,71,0', '3,71,0']],
  });
  const used = await adapter.executeAction('use_redstone');
  assert.equal(used.ok, true);
  assert.equal(used.name, 'lever');

  const sensed = await adapter.executeAction('sense_redstone');
  assert.equal(sensed.ok, true);
  assert.equal(sensed.maxPower, 0, 'dopo il ripristino non c\'è segnale');
  assert.equal(sensed.active, false);
  assert.deepEqual(sensed.activeOutputs, []);
  assert.equal(blocks.get('2,71,0').getProperties().open_bit, false);

  const unloaded = useAdapter({ cells: {}, loaded: 0 });
  const unknown = await unloaded.adapter.executeAction('sense_redstone');
  assert.deepEqual(unknown, { ok: false, error: 'redstone_unknown' });
});
