// M11 — l'avviso in chat di una vena nuova: «appena vedi un diamante comunicami
// la posizione» (utente, 07/10/2026), poi «seguimi e comunicami se vedi dei
// diamanti durante il cammino». Deterministico: la vena la vede l'adapter, la
// frase esce dal catalogo, e una coordinata non la riformula nessun modello.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BedrockAdapter, oreAlertCores } from '../bedrock-adapter.mjs';

const vein = (name, x, y, z, extra = {}) => ({ name, position: { x, y, z }, distance: 8, value: 100, harvestable: false, ...extra });

function alertAdapter ({ seen = [], text = ore => `seen ${ore.name} at ${ore.position.x},${ore.position.y},${ore.position.z}` } = {}) {
  const logs = [];
  const adapter = new BedrockAdapter({ logger: { log () {}, warn () {} } });
  const sent = [];
  adapter.sendChat = message => { sent.push(message); return { ok: true, sent: message }; };
  adapter.oreAlertText = text;
  adapter.oreAlertSeen = new Set(seen);
  adapter._lastOreAlertAt = 0;
  adapter.logger = { log: (message) => logs.push(String(message)), warn () {} };
  return { adapter, sent, logs };
}

test('a new vein is announced once, with its position, and never twice', () => {
  const { adapter, sent } = alertAdapter();
  const first = vein('deepslate_diamond_ore', 61, -6, 199);
  assert.ok(adapter._alertNewOres([first], 1000), 'the first sighting speaks');
  assert.deepEqual(sent, ['seen deepslate_diamond_ore at 61,-6,199']);
  assert.deepEqual(adapter.lastOreAlert.position, { x: 61, y: -6, z: 199 }, 'the alert carries the place to dig to');
  assert.equal(adapter.lastOreAlert.name, 'deepslate_diamond_ore');

  // Il giro dopo: la stessa vena è già stata detta, e un avviso ripetuto sarebbe
  // rumore (il cooldown da solo non basta: le ri-scansioni sono ogni 5 s).
  assert.equal(adapter._alertNewOres([first], 20000), null, 'the same vein stays silent');
  assert.equal(sent.length, 1);
});

test('the blocks of one vein are a single announcement, a second vein waits its turn', () => {
  const { adapter, sent } = alertAdapter();
  // Una vena di diamanti è fatta di blocchi adiacenti: 5 blocchi a un blocco di
  // distanza sono *una* notizia, non cinque.
  const oneVein = [
    vein('diamond_ore', 52, 1, 193),
    vein('diamond_ore', 53, 1, 193),
    vein('diamond_ore', 52, 0, 193),
    vein('diamond_ore', 52, 1, 192),
    vein('diamond_ore', 53, 0, 193),
  ];
  const other = vein('deepslate_diamond_ore', 80, -20, 240);
  adapter._alertNewOres([...oneVein, other], 1000);
  assert.equal(sent.length, 1, 'one message for the vein');
  assert.equal(sent[0], 'seen diamond_ore at 52,1,193', 'the nearest block names the vein');
  assert.equal(adapter.oreAlertSeen.has('diamond@80,-20,240'), false, 'the far vein is not swallowed by the near one');

  // La vena lontana parla al giro dopo, quando il cooldown è passato.
  assert.equal(adapter._alertNewOres([...oneVein, other], 2000), null, 'inside the cooldown nothing is said');
  assert.ok(adapter._alertNewOres([...oneVein, other], 9000), 'after the cooldown the second vein speaks');
  assert.equal(sent.length, 2);
  assert.equal(sent[1], 'seen deepslate_diamond_ore at 80,-20,240');
});

test('only the configured ores are announced', () => {
  const { adapter, sent } = alertAdapter();
  // `ORE_ALERT` di default è `diamond`: il ferro si vede e si mina, ma non si
  // annuncia (altrimenti la chat sarebbe un censimento).
  adapter._alertNewOres([vein('iron_ore', 10, 40, 10)], 1000);
  adapter._alertNewOres([vein('coal_ore', 12, 40, 12)], 1000);
  assert.deepEqual(sent, []);

  adapter.oreAlertCores = oreAlertCores('diamond, emerald');
  adapter._alertNewOres([vein('deepslate_emerald_ore', 20, 5, 20)], 1000);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /deepslate_emerald_ore/);
});

test('off means silence, and a missing renderer means silence too', () => {
  const { adapter, sent } = alertAdapter();
  adapter.oreAlertCores = oreAlertCores('off');
  assert.equal(adapter._alertNewOres([vein('diamond_ore', 1, 1, 1)], 1000), null);
  assert.deepEqual(sent, []);
  assert.equal(adapter.lastOreAlert, null);

  const bare = alertAdapter();
  bare.adapter.oreAlertText = null; // nessun catalogo iniettato: l'adapter non inventa testo
  assert.equal(bare.adapter._alertNewOres([vein('diamond_ore', 1, 1, 1)], 1000), null);
  assert.deepEqual(bare.sent, []);
});

test('ORE_ALERT accepts a block name, an item-shaped name or a list', () => {
  assert.deepEqual([...oreAlertCores('diamond')], ['diamond']);
  assert.deepEqual([...oreAlertCores('diamond_ore')], ['diamond'], 'il nome del blocco e il nucleo sono la stessa cosa');
  assert.deepEqual([...oreAlertCores('deepslate_diamond_ore')], ['diamond']);
  assert.deepEqual([...oreAlertCores('diamond, emerald')].sort(), ['diamond', 'emerald']);
  assert.equal(oreAlertCores('').size, 0);
  assert.equal(oreAlertCores('off').size, 0);
});

test('a vein beyond the alert range is not announced', () => {
  const { adapter, sent } = alertAdapter();
  adapter._alertNewOres([vein('diamond_ore', 200, 40, 200, { distance: 289 })], 1000); // distanza ~289
  assert.deepEqual(sent, []);
});

test('the ore census calls the alert, so a sighting reaches the chat by itself', () => {
  const { adapter, sent } = alertAdapter();
  const blocks = [
    { name: 'diamond_ore', position: { x: 52, y: 1, z: 193 }, distance: 6.2 },
    { name: 'deepslate_diamond_ore', position: { x: 52, y: 0, z: 193 }, distance: 7.1 },
  ];
  adapter.position = { x: 54, y: 6, z: 194 };
  adapter.world = {
    findBlocks: (name) => (name === 'diamond_ore' || name === 'deepslate_diamond_ore' ? blocks.filter(b => b.name === name) : []),
    blockAt: position => blocks.find(b => b.position.x === position.x && b.position.y === position.y && b.position.z === position.z) ?? null,
  };
  adapter._bestInventoryTool = () => null;
  adapter._blockHarvestable = () => false;
  adapter.world.registry = {};

  const found = adapter._scanValuableOres();
  assert.ok(found.some(ore => ore.name === 'diamond_ore'), 'the census sees the vein');
  assert.equal(sent.length, 1, 'and the sighting is announced');
  assert.match(sent[0], /diamond_ore at 52,1,193/);

  // Una seconda scansione della stessa area resta muta (già detta).
  adapter._lastOreScanAt = 0;
  adapter._alertNewOres(adapter._scanValuableOres(), Date.now());
  assert.equal(sent.length, 1);
});
