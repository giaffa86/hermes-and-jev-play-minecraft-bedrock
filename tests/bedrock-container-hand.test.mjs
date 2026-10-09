// La mano sbagliata è la prima causa di `container_open_timeout`: con un oggetto
// *usabile* in mano (uovo, palla di neve, perla, secchio, arco…) il click su un
// baule diventa «usa l'oggetto» e la finestra non si apre mai — senza nessun
// errore, solo il silenzio del timeout.
//
// Live 08-09/10/2026, spedizione diamanti sul mondo ripristinato: quaranta
// `container_open_timeout` su quaranta tentativi con `held: "egg"`, e due letture
// riuscite su due appena la mano ha tenuto qualcos'altro. Non era un caso: il
// bot raccoglie le uova deposte nel villaggio, quindi la pila in mano non si
// svuota da sola e ogni `read_container`/`take_*` della missione falliva.
//
// Questo test tiene due cose: l'elenco degli oggetti usabili (la classificazione)
// e l'ordine dentro `_openStorageWindow` — la mano si cambia *prima* del click,
// e per un oggetto usabile si cambia al primo tentativo, non al terzo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isUseItemName } from '../bedrock-adapter.mjs';

const source = readFileSync(new URL('../bedrock-adapter.mjs', import.meta.url), 'utf8');

test('un uovo in mano è un oggetto usabile, un piccone no', () => {
  assert.equal(isUseItemName('egg'), true, 'è l\'oggetto del campo: quaranta aperture fallite con `held: "egg"`');
  assert.equal(isUseItemName('snowball'), true);
  assert.equal(isUseItemName('ender_pearl'), true);
  assert.equal(isUseItemName('chicken_spawn_egg'), true, 'le uova di evocazione sono uova');
  assert.equal(isUseItemName('oak_boat'), true, 'una barca in mano è un «usa l\'oggetto»');
  assert.equal(isUseItemName('water_bucket'), true);
  assert.equal(isUseItemName('bow'), true);
  assert.equal(isUseItemName('flint_and_steel'), true);
  assert.equal(isUseItemName('iron_pickaxe'), false);
  assert.equal(isUseItemName('iron_sword'), false);
  assert.equal(isUseItemName('torch'), false);
  assert.equal(isUseItemName('shield'), false);
  assert.equal(isUseItemName('bread'), false, 'il cibo non è un click: si mangia tenendo premuto');
  assert.equal(isUseItemName(undefined), false, 'la mano vuota non è un oggetto usabile');
  assert.equal(isUseItemName(null), false);
});

test('la mano si cambia prima del click, e subito se tiene un oggetto usabile', () => {
  const from = source.indexOf('async _openStorageWindow (');
  const to = source.indexOf('_openContainerBlock = {', from);
  assert.ok(from > 0 && to > from, 'il corpo di `_openStorageWindow` non è stato trovato: la guardia non guarda nulla');
  const body = source.slice(from, to);
  const handAt = body.indexOf('isUseItemName(heldBefore)');
  const clickAt = body.indexOf('_queueAuthInput({ yaw, pitch, transaction: this._blockUseTransaction(target.position) })');
  assert.ok(handAt > 0, 'la scelta della mano non usa `isUseItemName`');
  assert.ok(clickAt > handAt, 'la mano deve essere scelta *prima* del click: dopo il click la transazione è già partita');
  assert.match(body, /if \(useItem \|\| \(attempt > 1 && !hand\?\.network_id\)\)/, 'un oggetto usabile si cambia al primo tentativo (la mano vuota resta il ripiego dal secondo)');
  assert.match(body, /usable >= 0 \? usable : slots\.findIndex/, 'prima uno slot con un oggetto non usabile, poi uno slot libero');
  assert.ok(source.includes('container_hand_selected'), 'il cambio di mano deve restare dichiarato nel log');
});
