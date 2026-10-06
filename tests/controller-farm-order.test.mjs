// Ordine di fattoria (V3): "raccogli le carote, rimpianta e metti il raccolto
// nel baule" e' una catena bounded e deterministica, non un pickup da terra e
// non una chiamata al planner. Questi test coprono il classificatore, la scelta
// del passo contro `/options`, la chiusura sul delta di stato e la politica di
// deposito dell'adapter (la riserva di cibo non trattiene il raccolto che
// l'umano ha chiesto di mettere via).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  farmOrderFromText, farmStep, farmSnapshot, farmFulfilled, farmOutcome,
  DEFAULT_FARM_MAX_HARVES, tokenInventoryTotal,
} from '../controller-decisions.mjs';
import { cropBlockForItem, seedForCrop, farmOptionKeys } from '../bedrock-survival.mjs';
import { BedrockAdapter } from '../bedrock-adapter.mjs';

const CARROTS = { crop: 'carrot', block: 'carrots', seed: 'carrot', word: 'carote', replant: true, store: 'known', field: null };

// La fixture minima riusa i metodi reali dell'adapter (`_isKeptItem`,
// `_depositableItems`) senza costruire un mondo: qui interessa la politica.
const adapterPolicy = (inventory, plan = null) => {
  const adapter = Object.create(BedrockAdapter.prototype);
  adapter.inventory = inventory;
  adapter.plan = plan;
  return adapter;
};

test('farmOrderFromText riconosce una coltura mietuta e la distingue da un pickup', () => {
  assert.deepEqual(farmOrderFromText('raccogli le carote'), CARROTS);
  assert.deepEqual(farmOrderFromText('@bot raccogli le carote dal campo, rimpianta e metti il raccolto nel baule più vicino'), {
    crop: 'carrot', block: 'carrots', seed: 'carrot', word: 'carote', replant: true, store: 'nearest', field: null,
  });
  assert.deepEqual(farmOrderFromText('mieti il grano e rimpiantalo'), {
    crop: 'wheat', block: 'wheat', seed: 'wheat_seeds', word: 'grano', replant: true, store: 'known', field: null,
  });
  assert.deepEqual(farmOrderFromText('raccogli le patate'), {
    crop: 'potato', block: 'potatoes', seed: 'potato', word: 'patate', replant: true, store: 'known', field: null,
  });
  assert.equal(farmOrderFromText('raccogli le barbabietole senza metterle nel baule').store, null);
  assert.equal(farmOrderFromText('raccogli le carote senza rimpiantare').replant, false);
});

test('farmOrderFromText lascia al planner cio\' che non e\' una coltura nominata', () => {
  // La quota esplicita resta al planner (l'ordine fissa un numero, non un campo).
  assert.equal(farmOrderFromText('raccogli 4 carote'), null);
  // "cattura" e' sempre un pickup da terra, non un lavoro di fattoria.
  assert.equal(farmOrderFromText('cattura le carote'), null);
  // Un oggetto che non e' una coltura non passa dal classificatore.
  assert.equal(farmOrderFromText('raccogli il piccone'), null);
  assert.equal(farmOrderFromText('raccogli la terra'), null);
  assert.equal(farmOrderFromText('vieni qui'), null);
});

test('cropBlockForItem e farmOptionKeys coprono seme e blocco (il grano ha due nomi)', () => {
  assert.equal(cropBlockForItem('carrot'), 'carrots');
  assert.equal(cropBlockForItem('potatoes'), 'potatoes');
  assert.equal(cropBlockForItem('wheat'), 'wheat');
  assert.equal(cropBlockForItem('apple'), null);
  assert.equal(seedForCrop('wheat'), 'wheat_seeds');
  assert.deepEqual(farmOptionKeys({ crop: 'carrot', store: 'known' }), [
    'harvest_carrots', 'plant_carrot', 'deposit_carrot', 'collect_drop', 'dump_inventory',
  ]);
  assert.deepEqual(farmOptionKeys({ crop: 'carrot', store: null }), [
    'harvest_carrots', 'plant_carrot', 'deposit_carrot', 'collect_drop',
  ]);
});

test('farmStep miete la coltura anche con il raccolto in zaino (il campo, non il pickup)', () => {
  // Il caso che prima finiva in `no_drop`: carote in zaino, nessun drop a terra,
  // l'harness offre `harvest_carrots` perche' li' davanti c'e' un campo maturo.
  const plan = { ...CARROTS, before: { inventory: { carrot: 3 }, contained: 0, at: 0 } };
  const obs = { inventory: { carrot: 3 }, drops: [], containers: [], storage: { known: [] } };
  const step = farmStep(plan, obs, ['harvest_carrots', 'plant_carrot', 'dump_inventory']);
  assert.deepEqual(step, { key: 'harvest_carrots', phase: 'harvest' });
});

test('farmStep raccoglie prima i drop visibili, e solo quelli della coltura', () => {
  const plan = { ...CARROTS, before: { inventory: {}, contained: 0, at: 0 } };
  const obs = { inventory: {}, drops: [{ item: 'wheat', count: 2 }, { item: 'carrot', count: 1 }], containers: [], storage: { known: [] } };
  assert.deepEqual(farmStep(plan, obs, ['collect_drop', 'harvest_carrots']), { key: 'collect_drop', phase: 'collect' });
  // Nessun drop di carote: quello di grano non conta.
  assert.deepEqual(farmStep(plan, { ...obs, drops: [{ item: 'wheat', count: 2 }] }, ['collect_drop', 'harvest_carrots']), { key: 'harvest_carrots', phase: 'harvest' });
});

test('farmStep semina solo quando l\'ultima mietitura non ha ripiantato', () => {
  const plan = { ...CARROTS, before: { inventory: {}, contained: 0, at: 0 } };
  const obs = { inventory: {}, drops: [], containers: [], storage: { known: [] } };
  const options = ['plant_carrot', 'dump_inventory'];
  // Senza prova di una mietitura andata a vuoto non si semina il villaggio.
  assert.equal(farmStep(plan, obs, options, { progress: { harvests: 0, needsPlant: false } }), null);
  assert.deepEqual(farmStep(plan, obs, options, { progress: { harvests: 1, needsPlant: true } }), { key: 'plant_carrot', phase: 'plant' });
  // Con `replant: false` la semina non e' mai un passo dell'ordine.
  assert.equal(farmStep({ ...plan, replant: false }, obs, options, { progress: { harvests: 1, needsPlant: true } }), null);
});

test('farmStep mietitura bounded e deposito solo del raccolto guadagnato', () => {
  const plan = { ...CARROTS, before: { inventory: { carrot: 3 }, contained: 0, at: 0 } };
  const options = ['harvest_carrots', 'deposit_carrot', 'dump_inventory'];
  const done = { harvests: DEFAULT_FARM_MAX_HARVES };
  // Tetto di mietiture: oltre il tetto il passo sparisce (nessun ciclo infinito).
  assert.equal(farmStep(plan, { inventory: { carrot: 3 }, drops: [] }, ['harvest_carrots'], { progress: done }), null);
  // Il deposito usa il delta, non il conteggio assoluto: 3 carote (quelle che
  // c'erano prima) non si mettono via.
  assert.equal(farmStep(plan, { inventory: { carrot: 3 }, drops: [] }, options, { progress: done }), null);
  // 6 carote (3 preesistenti + 3 raccolte) si depositano; 'known' preferisce lo
  // scrigno che gia' contiene il raccolto, 'nearest' il deposito generico.
  const gained = { inventory: { carrot: 6 }, drops: [] };
  assert.deepEqual(farmStep(plan, gained, options, { progress: done }), { key: 'deposit_carrot', phase: 'store' });
  assert.deepEqual(farmStep({ ...plan, store: 'nearest' }, gained, options, { progress: done }), { key: 'dump_inventory', phase: 'store' });
  // Finche' l'harness offre la mietitura la mietitura viene prima del deposito:
  // il campo non si lascia a meta' per andare a scaricare.
  assert.deepEqual(farmStep(plan, gained, options, { progress: { harvests: 2 } }), { key: 'harvest_carrots', phase: 'harvest' });
  // Niente da offrire: la catena finisce (nessuna key inventata).
  assert.equal(farmStep(plan, gained, [], { progress: done }), null);
});

test('farmSnapshot e farmFulfilled misurano il delta, non il testo dell\'ordine', () => {
  const plan = { ...CARROTS, before: farmSnapshot({ inventory: { carrot: 2 }, containers: [{ position: { x: 1, y: 64, z: 1 }, contents: { carrot: 10 } }], storage: { known: [] } }, 'carrot') };
  assert.deepEqual(plan.before.inventory, { carrot: 2 });
  assert.equal(plan.before.contained, 10);
  // Il bot ha raccolto e messo via: lo scrigno e' cresciuto, e in zaino non
  // resta piu' del seme che c'era prima.
  const stored = { inventory: { carrot: 2 }, containers: [{ position: { x: 1, y: 64, z: 1 }, contents: { carrot: 13 } }], storage: { known: [] } };
  assert.equal(farmFulfilled(plan, stored), true);
  assert.deepEqual(farmOutcome(plan, stored), { crop: 'carrot', held: 2, stored: 3, gained: 3 });
  // Lo scrigno non e' cambiato: l'ordine non e' chiuso anche se in chat e' stato
  // detto "fatto" o se l'obiettivo del piano lo dichiara.
  assert.equal(farmFulfilled(plan, { ...stored, containers: [{ position: { x: 1, y: 64, z: 1 }, contents: { carrot: 10 } }] }), false);
});

test('il contenuto di un baule non si conta due volte (cache e registro)', () => {
  const plan = { ...CARROTS, before: { inventory: {}, contained: 0, at: 0 } };
  const row = { position: { x: 4, y: 64, z: 4 }, contents: { carrot: 5 } };
  const obs = {
    inventory: { carrot: 0 },
    containers: [row],
    storage: { known: [{ position: { ...row.position }, contains: { carrot: 5 } }] },
  };
  assert.equal(farmFulfilled(plan, obs), true);
  assert.equal(farmOutcome(plan, obs).stored, 5);
});

test('la riserva di cibo non trattiene il raccolto di un ordine di fattoria', () => {
  // Senza ordine: 5 carote sono cibo, la riserva (16) le tiene in zaino.
  const idle = adapterPolicy({ carrot: 5, dirt: 40 });
  assert.equal(idle._isKeptItem('carrot'), true);
  assert.deepEqual(idle._depositableItems(), [{ item: 'dirt', count: 40 }]);
  // Con l'ordine di fattoria sulla carota la stessa scorta e' il raccolto da
  // mettere via: l'opzione offerta e l'azione che la esegue devono concordare.
  const ordered = adapterPolicy({ carrot: 5, dirt: 40 }, { farm: { crop: 'carrot' } });
  assert.deepEqual(ordered._depositableItems(), [{ item: 'dirt', count: 40 }, { item: 'carrot', count: 5 }]);
  assert.deepEqual(ordered._depositableItems({ exempt: [] }), [{ item: 'dirt', count: 40 }]);
  // Un ordine su un'altra coltura non libera le carote.
  const other = adapterPolicy({ carrot: 5 }, { farm: { crop: 'potato' } });
  assert.deepEqual(other._depositableItems(), []);
  assert.equal(tokenInventoryTotal({ carrot: 5 }, 'carrot'), 5);
});
