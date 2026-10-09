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
import { BedrockAdapter, isUseItemName } from '../bedrock-adapter.mjs';

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

// Live 09-10/10/2026 (`diamond-20261010-1`): dopo un `place` rifiutato con
// status 50 l'inventario rimandava `inventory_content` ogni ~700 ms ma nessuna
// finestra si apriva più — non il baule, non l'inventario, non dopo un
// reconnect, non dopo un riavvio del processo harness. Ogni tentativo costava i
// suoi 3 s e la missione non usciva più dalla base. Il contatore delle aperture
// fallite di fila nomina la sessione bloccata invece di far sembrare sbagliato
// ogni singolo contenitore.
test('tre finestre che non si aprono nominano la sessione bloccata, non il baule', async () => {
  const logs = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: entry => logs.push(entry) });
  adapter._containerWaiters = [];

  await assert.rejects(() => adapter._waitForContainerOpen(() => true, 5), /container_open_timeout/);
  await assert.rejects(() => adapter._waitForContainerOpen(() => true, 5), /container_open_timeout/);
  await assert.rejects(() => adapter._waitForContainerOpen(() => true, 5), (error) => {
    assert.equal(error.message, 'container_ui_locked');
    assert.equal(error.details.failures, 3);
    assert.match(error.details.hint, /riavviare il server Bedrock/);
    return true;
  });

  const locked = logs.filter(l => l.type === 'container_locked_suspected');
  assert.equal(locked.length, 1, 'una sola riga: la diagnosi non si ripete a ogni tentativo');
  assert.equal(locked[0].failures, 3);
});

test('una finestra che si apre azzera la serie dei fallimenti', async () => {
  const logs = [];
  const adapter = new BedrockAdapter({ logger: { log () {} }, onLog: entry => logs.push(entry) });
  adapter._containerWaiters = [];

  await assert.rejects(() => adapter._waitForContainerOpen(() => true, 5), /container_open_timeout/);
  await assert.rejects(() => adapter._waitForContainerOpen(() => true, 5), /container_open_timeout/);
  adapter._noteContainerOpened();
  assert.equal(adapter._containerOpenFailures, 0);
  assert.equal(adapter._containerOpenFailureSince, null, 'anche l\'istante del primo fallimento si dimentica');
  await assert.rejects(() => adapter._waitForContainerOpen(() => true, 5), /container_open_timeout/);
  assert.equal(logs.filter(l => l.type === 'container_locked_suspected').length, 0, 'due fallimenti non sono un blocco');
});

test('la soglia del blocco è dichiarata una volta sola e il gestore la azzera', () => {
  assert.match(source, /const CONTAINER_OPEN_LOCK_FAILURES = \+\(process\.env\.CONTAINER_OPEN_LOCK_FAILURES \|\| 3\)/);
  assert.match(source, /this\.log\('container_open'[^\n]*\n\s*this\._noteContainerOpened\(\);/,
    'l\'apertura riuscita azzera la serie: il gestore di container_open');
});
