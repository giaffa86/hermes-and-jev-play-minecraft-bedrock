// Unit test for the M9 inventory orders (wiki/human-command.md): "getta
// <oggetto>" empties something out of the inventory, "cattura <oggetto>" picks a
// dropped item back up. Both are recognised deterministically here — the
// vocabulary is the same `ITEM_WORDS` the question path uses, so "getta i
// diamanti" is never mistaken for a mining target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectFulfilled, dropCountFromText, dropFulfilled, inventoryMatchingToken,
  isCollectOrder, isDropOrder, matchesItemToken, orderItem, tokenInventoryTotal,
} from '../controller-decisions.mjs';

test('orderItem legge l\'oggetto in tutte le lingue del catalogo', () => {
  assert.deepEqual(orderItem('@bot1 getta i diamanti'), { token: 'diamond', word: 'diamanti' });
  assert.equal(orderItem('@bot cattura spada').token, 'sword');
  assert.equal(orderItem('@bot raccogli il ferro').token, 'iron');
  assert.equal(orderItem('@bot butta via la terra').token, 'dirt');
  assert.equal(orderItem('@bot getta la spazzatura'), null, 'un oggetto fuori catalogo non è un ordine di inventario');
});

test('isDropOrder: verbo di gettare + oggetto del catalogo', () => {
  assert.equal(isDropOrder('@bot1 getta i diamanti'), true);
  assert.equal(isDropOrder('@bot buttali via'), false, 'senza il nome dell\'oggetto non è un ordine di inventario');
  assert.equal(isDropOrder('@bot getta la spada'), true);
  assert.equal(isDropOrder('@bot getta la spada di diamante').valueOf(), true);
  assert.equal(isDropOrder('@bot seguimi'), false);
});

test('isCollectOrder: cattura/raccogli <oggetto>, ma "raccogli 4 terra" resta una quota di raccolta', () => {
  assert.equal(isCollectOrder('@bot cattura i diamanti'), true);
  assert.equal(isCollectOrder('@bot cattura spada'), true);
  assert.equal(isCollectOrder('@bot raccogli la terra'), true);
  assert.equal(isCollectOrder('@bot pick up the diamond'), true);
  // Con un numero, "raccogli" torna al vecchio significato (andare a
  // raccoglierne quattro), che è un target del planner: non è un pickup.
  assert.equal(isCollectOrder('@bot raccogli 4 terra'), false);
  assert.equal(isCollectOrder('@bot prendi la terra'), false, '"prendi" resta il verbo del planner');
  assert.equal(isCollectOrder('@bot cattura la spazzatura'), false);
});

test('dropCountFromText legge la quota, e ignora le cifre dentro una parola', () => {
  assert.equal(dropCountFromText('@bot getta 5 diamanti'), 5);
  assert.equal(dropCountFromText('@bot getta 12 spade'), 12);
  assert.equal(dropCountFromText('@bot getta i diamanti'), null, 'nessun numero = tutto');
  assert.equal(dropCountFromText('@bot1 getta i diamanti'), null, 'le cifre del gamertag non sono una quota');
  assert.equal(dropCountFromText('@bot1 getta i diamanti'), null);
  assert.equal(dropCountFromText('@bot getta 0 diamanti'), null);
});

test('inventoryMatchingToken preferisce il nome esatto e non tocca gli attrezzi', () => {
  assert.deepEqual(inventoryMatchingToken({ diamond: 3, diamond_sword: 1, dirt: 5 }, 'diamond'), ['diamond']);
  assert.deepEqual(inventoryMatchingToken({ iron_ingot: 2, iron_sword: 1, raw_iron: 1 }, 'iron'), ['iron_ingot', 'raw_iron']);
  assert.deepEqual(inventoryMatchingToken({ oak_planks: 4, spruce_planks: 2 }, 'planks'), ['oak_planks', 'spruce_planks']);
  assert.deepEqual(inventoryMatchingToken({ iron_helmet: 1, iron_boots: 1, dirt: 1 }, 'armor'), ['iron_boots', 'iron_helmet']);
  assert.deepEqual(inventoryMatchingToken({ iron_helmet: 1, iron_boots: 1 }, 'helmet'), ['iron_helmet']);
  assert.deepEqual(inventoryMatchingToken({ stone: 2, cobblestone: 9 }, 'stone'), ['stone']);
  assert.deepEqual(inventoryMatchingToken({ dirt: 5 }, 'diamond'), [], 'un oggetto assente non è un ordine di gettare');
  assert.deepEqual(inventoryMatchingToken({ diamond: 0 }, 'diamond'), [], 'una pila a zero non è niente da buttare');
});

test('matchesItemToken: "armor" è un gruppo, il token normale una sottostringa', () => {
  assert.equal(matchesItemToken('iron_helmet', 'armor'), true);
  assert.equal(matchesItemToken('diamond_sword', 'armor'), false);
  assert.equal(matchesItemToken('diamond_sword', 'sword'), true);
  assert.equal(matchesItemToken('diamond', 'diamond'), true);
  assert.equal(matchesItemToken(null, 'diamond'), false);
  assert.equal(matchesItemToken('diamond', null), false);
});

test('dropFulfilled: senza quota l\'oggetto deve essere uscito del tutto', () => {
  const drop = { items: ['diamond'], before: { diamond: 5 }, count: null };
  assert.equal(dropFulfilled(drop, { inventory: { dirt: 1 } }), true);
  assert.equal(dropFulfilled(drop, { inventory: { diamond: 1 } }), false, 'una pila rimasta non chiude l\'ordine');
  assert.equal(dropFulfilled(drop, { inventory: { diamond: 5 } }), false);
});

test('dropFulfilled: con una quota conta i pezzi persi, non lo stato finale', () => {
  const drop = { items: ['diamond'], before: { diamond: 5 }, count: 3 };
  assert.equal(dropFulfilled(drop, { inventory: { diamond: 2 } }), true);
  assert.equal(dropFulfilled(drop, { inventory: { diamond: 3 } }), false, 'due buttati su tre non bastano');
  // Con più voci (es. "getta il ferro" = lingotti + grezzi) la quota è la somma.
  const iron = { items: ['iron_ingot', 'raw_iron'], before: { iron_ingot: 1, raw_iron: 1 }, count: 2 };
  assert.equal(dropFulfilled(iron, { inventory: {} }), true);
  assert.equal(dropFulfilled(iron, { inventory: { raw_iron: 1 } }), false);
});

test('dropFulfilled non chiude un ordine senza oggetti risolti', () => {
  assert.equal(dropFulfilled({ items: [] }, { inventory: {} }), false);
  assert.equal(dropFulfilled(undefined, { inventory: {} }), false);
});

test('collectFulfilled: basta un pezzo guadagnato dell\'oggetto nominato', () => {
  const collect = { token: 'diamond', beforeTotal: 1, items: ['diamond'] };
  assert.equal(collectFulfilled(collect, { inventory: { diamond: 2 } }), true);
  assert.equal(collectFulfilled(collect, { inventory: { diamond: 1 } }), false);
  assert.equal(collectFulfilled(collect, { inventory: { dirt: 9 } }), false);
  // Il piano è ancorato al token, non all'elenco dei drop visti: un item
  // atterrato dopo il piano conta comunque.
  assert.equal(collectFulfilled({ token: 'iron', beforeTotal: 0 }, { inventory: { raw_iron: 1 } }), true);
  assert.equal(collectFulfilled({ token: null }, { inventory: { diamond: 9 } }), false);
  assert.equal(collectFulfilled(undefined, { inventory: {} }), false);
});

test('tokenInventoryTotal somma tutte le voci dell\'oggetto', () => {
  assert.equal(tokenInventoryTotal({ diamond: 2, diamond_sword: 1, dirt: 5 }, 'diamond'), 3);
  assert.equal(tokenInventoryTotal({ iron_helmet: 1, iron_boots: 1 }, 'armor'), 2);
  assert.equal(tokenInventoryTotal({}, 'diamond'), 0);
});
