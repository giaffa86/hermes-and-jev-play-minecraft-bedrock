// Told facts — the memory layer.
//
// A fact *told* by a human is not a fact *observed* by the bot: it keeps its
// provenance (`source: 'told'`, `toldBy`, `toldAt`), it survives as long as the
// human meant it to (a named place has no TTL), and a claim about a container's
// contents is *partial* — it never pretends to be an inventory nor erases one.
//
// The tests below are the properties the feature was requested with:
// persistence across a restart, partial claims, ambiguity (never "the nearest"),
// correction with history, invalidation instead of deletion, a differentiated
// TTL, and navigation by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorldMemory, MEMORY_STATUS, TOLD_SOURCE } from '../world-memory.mjs';

const quiet = { warn () {} };
const BACKENDS = ['json', 'sqlite'];
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const T0 = 1_700_000_000_000;
const potatoField = { x: 120, y: 64, z: -230 };
const mineEntrance = { x: 30, y: 32, z: 40 };
const chest = { x: 10, y: 64, z: 10 };

const withMemory = (backend, fn) => {
  const dir = mkdtempSync(join(tmpdir(), `wm-told-${backend}-`));
  try {
    const wm = createWorldMemory({ dir, backend, logger: quiet });
    return fn(wm, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

for (const backend of BACKENDS) {
  test(`[${backend}] a named place is a permanent landmark with the teller's provenance`, () => withMemory(backend, (wm) => {
    const record = wm.rememberToldPlace({
      name: 'campo di patate',
      position: potatoField,
      dimension: 'overworld',
      toldBy: 'Ale',
      toldAt: T0,
    });
    assert.equal(record.kind, 'landmark');
    assert.equal(record.label, 'campo di patate');
    assert.equal(record.source, TOLD_SOURCE);
    assert.equal(record.toldBy, 'Ale');
    assert.equal(record.toldAt, T0);
    assert.equal(record.permanent, true, 'un luogo dettato non ha TTL');
    assert.ok(record.tags.includes('told'));
    assert.deepEqual(record.position, potatoField);
    assert.deepEqual(wm.toldFor(record).history, []);

    // «Dov'è il campo di patate?» — il nome umano è la chiave di ricerca.
    const found = wm.placesForName('campo di patate', { exact: true });
    assert.equal(found.length, 1);
    assert.equal(found[0].id, record.id);
    // Un nome parziale non è un match *esatto*: serve a non correggere un luogo
    // con una parola che lo contiene ("campo" ≠ "campo di patate").
    assert.equal(wm.placesForName('campo', { exact: true }).length, 0);
    assert.equal(wm.placesForName('campo').some((p) => p.id === record.id), true);

    // Un luogo dettato è un posto da raggiungere, non un nodo-concetto.
    const landmarks = wm.findLandmarks({ includeInvalid: false });
    assert.equal(landmarks.some((l) => l.id === record.id), true);
    assert.equal(landmarks.every((l) => l.category !== 'conceptual'), true);
  }));

  test(`[${backend}] a told place and its contents claim survive a restart`, () => withMemory(backend, (wm, dir) => {
    const place = wm.rememberToldPlace({ name: 'ingresso principale della miniera', position: mineEntrance, toldBy: 'Ale', toldAt: T0 });
    wm.claimToldContents({ position: chest, dimension: 'overworld', item: 'iron_ingot', count: 64, label: 'baule di casa', type: 'chest', toldBy: 'Ale', toldAt: T0 });
    wm.close();

    const again = createWorldMemory({ dir, backend, logger: quiet });
    const restored = again.getRecord(place.id);
    assert.equal(restored.label, 'ingresso principale della miniera');
    assert.equal(restored.source, TOLD_SOURCE);
    assert.equal(restored.toldBy, 'Ale', 'chi lo ha detto sopravvive al riavvio');
    assert.equal(restored.permanent, true);
    assert.deepEqual(restored.position, mineEntrance);

    const container = again.getRecord(again.containerId(chest));
    assert.equal(container.label, 'baule di casa');
    assert.equal(container.contentsKnown, false, 'un claim non è un inventario');
    const claims = again.claimsFor(container.id, { item: 'iron', now: T0 + MIN });
    assert.equal(claims.length, 1);
    assert.equal(claims[0].count, 64);
    assert.equal(claims[0].toldBy, 'Ale');
    assert.equal(claims[0].verdict, 'unverified');
    assert.equal(again.resolvePlace({ name: 'ingresso principale della miniera' }).place.id, place.id, 'navigazione per nome dopo il riavvio');
    again.close();
  }));

  test(`[${backend}] only told places are exempt from the time TTL`, () => withMemory(backend, (wm) => {
    const told = wm.rememberToldPlace({ name: 'campo di patate', position: potatoField, toldBy: 'Ale', toldAt: T0 });
    const seen = wm.rememberLandmark({ type: 'village', label: 'villaggio', position: { x: 1, y: 64, z: 1 }, toldAt: null });
    wm.repo.upsert({ ...wm.getRecord(seen.id), lastSeenAt: T0 });

    wm.refreshStatuses(T0 + 7 * HOUR);
    assert.equal(wm.getRecord(told.id).status, MEMORY_STATUS.KNOWN, '«l\'ingresso della miniera» non scade perché nessuno lo ri-visita');
    assert.equal(wm.getRecord(seen.id).status, MEMORY_STATUS.STALE, 'un luogo solo osservato sì');

    // Il contenitore dettato resta invece un contenitore: la sua posizione
    // invecchia come quella di ogni altro baule (solo il *contenuto* ha una
    // semantica diversa, ed è un claim verificabile).
    wm.claimToldContents({ position: chest, item: 'iron_ingot', count: 64, toldBy: 'Ale', toldAt: T0 });
    const container = wm.getRecord(wm.containerId(chest));
    assert.equal(container.permanent, false);
    assert.equal(wm._describeContainer(container.id, T0 + 7 * HOUR).status, MEMORY_STATUS.STALE);
  }));

  test(`[${backend}] a claim never erases an observed inventory (and vice versa)`, () => withMemory(backend, (wm) => {
    // Il bot ha *letto* il baule: questo è un inventario osservato.
    wm.rememberContainer({ position: chest, contents: { coal: 3 }, observedAt: T0 });
    // Poi l'umano dice che c'è del ferro: è un claim parziale, non una lettura.
    wm.claimToldContents({ position: chest, item: 'iron_ingot', count: 64, label: 'baule di casa', toldBy: 'Ale', toldAt: T0 + MIN });

    const view = wm._describeContainer(wm.containerId(chest), T0 + 2 * MIN);
    assert.deepEqual(view.contents, { coal: 3 }, 'l\'inventario letto resta quello letto');
    assert.equal(view.contentsKnown, true);
    assert.equal(view.inspectedAt, T0);
    assert.equal(view.label, 'baule di casa', 'il nome dato dall\'umano resta, senza toccare il contenuto');

    // «Dove posso trovare ferro?» — il claim è offerto, dichiarato non verificato.
    const iron = wm.whereToFind('iron_ingot', { now: T0 + 2 * MIN });
    assert.equal(iron.length, 1);
    assert.equal(iron[0].source, 'told');
    assert.equal(iron[0].claim, 'unverified');
    assert.equal(iron[0].count, 64);
    // «E il carbone?» — la misura osservata è separata e più autorevole.
    const coal = wm.whereToFind('coal', { now: T0 + 2 * MIN });
    assert.equal(coal.length, 1);
    assert.equal(coal[0].source, 'observed');
    assert.equal(coal[0].count, 3);
  }));

  test(`[${backend}] the reading decides: a claim is confirmed or contradicted, never assumed`, () => withMemory(backend, (wm) => {
    wm.claimToldContents({ position: chest, item: 'iron_ingot', count: 64, toldBy: 'Ale', toldAt: T0 });
    const id = wm.containerId(chest);
    assert.equal(wm.claimsFor(id, { item: 'iron_ingot', now: T0 + MIN })[0].verdict, 'unverified');

    // Il bot apre il baule e ci trova il ferro: il claim è confermato.
    wm.rememberContainer({ position: chest, contents: { iron_ingot: 64 }, observedAt: T0 + 2 * MIN });
    const confirmed = wm.claimsFor(id, { item: 'iron_ingot', now: T0 + 3 * MIN })[0];
    assert.equal(confirmed.verdict, 'confirmed');
    assert.equal(confirmed.verifiedAt, T0 + 2 * MIN);
    assert.equal(confirmed.verifiedCount, 64);

    // …e poi lo riapre: non c'è più. La lettura smentisce il claim.
    wm.rememberContainer({ position: chest, contents: { coal: 1 }, observedAt: T0 + 4 * MIN });
    const contradicted = wm.claimsFor(id, { item: 'iron_ingot', now: T0 + 5 * MIN })[0];
    assert.equal(contradicted.verdict, 'contradicted');
    // Un claim smentito non si offre come destinazione.
    assert.equal(wm.whereToFind('iron_ingot', { now: T0 + 5 * MIN }).length, 0);
  }));

  test(`[${backend}] a claim older than the tell window is flagged stale, the place is not`, () => withMemory(backend, (wm) => {
    wm.claimToldContents({ position: chest, item: 'iron_ingot', count: 64, toldBy: 'Ale', toldAt: T0 });
    const claim = wm.claimsFor(wm.containerId(chest), { item: 'iron_ingot', now: T0 + 8 * 24 * HOUR })[0];
    assert.equal(claim.stale, true, 'la dichiarazione su un contenuto invecchia');
    assert.equal(wm.claimsFor(wm.containerId(chest), { item: 'iron_ingot', now: T0 + MIN })[0].stale, false);
  }));

  test(`[${backend}] two places with the same name are never resolved by distance`, () => withMemory(backend, (wm) => {
    wm.rememberLandmark({ id: 'field_north', type: 'landmark', label: 'campo', position: { x: 0, y: 64, z: 0 }, source: TOLD_SOURCE, permanent: true, toldBy: 'Ale', toldAt: T0 });
    wm.rememberLandmark({ id: 'field_south', type: 'landmark', label: 'campo', position: { x: 0, y: 64, z: 900 }, source: TOLD_SOURCE, permanent: true, toldBy: 'Ale', toldAt: T0 + MIN });

    const resolved = wm.resolvePlace({ name: 'campo' });
    assert.equal(resolved.action, 'ambiguous');
    assert.equal(resolved.place, null, 'non si sceglie: lo scioglimento spetta all\'umano');
    assert.deepEqual(resolved.candidates.map((c) => c.id).sort(), ['field_north', 'field_south']);

    // E non si scrive niente finché l'ambiguità non è sciolta.
    const told = wm.tellPlace({ name: 'campo', position: { x: 5, y: 64, z: 5 }, toldBy: 'Ale', toldAt: T0 + 2 * MIN });
    assert.equal(told.action, 'ambiguous');
    assert.equal(told.place, null);
    assert.deepEqual(wm.getRecord('field_north').position, { x: 0, y: 64, z: 0 });
    assert.deepEqual(wm.getRecord('field_south').position, { x: 0, y: 64, z: 900 });

    // La disambiguazione per id invece è diretta.
    const byId = wm.resolvePlace({ id: 'field_south' });
    assert.equal(byId.action, 'found');
    assert.deepEqual(byId.place.position, { x: 0, y: 64, z: 900 });
  }));

  test(`[${backend}] the same name at a new position corrects the place and keeps its history`, () => withMemory(backend, (wm) => {
    const first = wm.tellPlace({ name: 'ingresso principale della miniera', position: mineEntrance, toldBy: 'Ale', toldAt: T0 });
    assert.equal(first.action, 'created');

    const moved = { x: 31, y: 33, z: 41 };
    const second = wm.tellPlace({ name: 'ingresso principale della miniera', position: moved, toldBy: 'Ale', toldAt: T0 + HOUR });
    assert.equal(second.action, 'corrected', 'stesso nome, posizione diversa: è una correzione, non un doppione');
    assert.deepEqual(second.candidates, [], 'un esito deciso non lascia candidati da scegliere');
    assert.equal(second.place.id, first.place.id, 'l\'identità non cambia');
    assert.deepEqual(second.place.position, moved);
    assert.deepEqual(second.previous.position, mineEntrance);
    assert.equal(second.place.history.length, 1);
    assert.deepEqual(second.place.history[0].position, mineEntrance);
    assert.equal(second.place.history[0].to, T0 + HOUR);
    assert.equal(second.place.source, TOLD_SOURCE);
    assert.equal(second.place.permanent, true);
    assert.equal(second.place.label, 'ingresso principale della miniera', 'il nome resta quello');
    assert.equal(wm.toldPlaces().length, 1, 'un posto, non due');

    // Una correzione che non trova niente non inventa un luogo.
    const unknown = wm.tellPlace({ name: 'deposito segreto', position: moved, requireExisting: true, toldBy: 'Ale', toldAt: T0 + 2 * HOUR });
    assert.equal(unknown.action, 'unknown');
    assert.equal(unknown.place, null);
    assert.equal(wm.resolvePlace({ name: 'deposito segreto' }).action, 'unknown');
  }));

  test(`[${backend}] correcting a place the bot found does not turn it into a told fact`, () => withMemory(backend, (wm) => {
    const found = wm.rememberLandmark({ type: 'village', label: 'villaggio', position: { x: 100, y: 64, z: 100 }, source: 'discovered' });
    const fixed = wm.correctToldPlace(found.id, { position: { x: 104, y: 64, z: 100 }, toldBy: 'Ale', toldAt: T0 });
    assert.equal(fixed.id, found.id);
    assert.equal(fixed.source, 'discovered', 'la provenienza originale non si riscrive');
    assert.equal(fixed.permanent, false, 'un\'osservazione corretta non diventa permanente');
    assert.equal(fixed.toldBy, 'Ale', 'la voce di chi ha corretto resta nella storia del posto');
    assert.equal(fixed.history.length, 1);
    assert.deepEqual(fixed.position, { x: 104, y: 64, z: 100 });
  }));

  test(`[${backend}] forgetting invalidates: the place leaves search, answers and navigation but stays in history`, () => withMemory(backend, (wm) => {
    const place = wm.rememberToldPlace({ name: 'vecchio deposito', position: chest, toldBy: 'Ale', toldAt: T0 });
    assert.equal(wm.resolvePlace({ name: 'vecchio deposito' }).action, 'found');

    wm.forgetPlace(place.id, { actor: 'Ale', at: T0 + HOUR, reason: 'non c\'è più' });
    const record = wm.getRecord(place.id);
    assert.equal(record.status, MEMORY_STATUS.INVALID, 'invalidato, non cancellato');
    assert.equal(record.invalidatedBy, 'Ale');
    assert.equal(record.invalidatedAt, T0 + HOUR);
    assert.equal(wm.getRecord(place.id).label, 'vecchio deposito', 'il ricordo resta leggibile');

    assert.equal(wm.resolvePlace({ name: 'vecchio deposito' }).action, 'unknown', 'fuori dalla navigazione');
    assert.equal(wm.placesForName('vecchio deposito').length, 0, 'fuori dalla ricerca');
    assert.equal(wm.toldPlaces().length, 0, 'fuori dall\'elenco dei luoghi dettati');
    assert.equal(wm.placesForName('vecchio deposito', { includeInvalid: true }).length, 1, 'la storia resta ispezionabile');
    assert.equal(wm.toldPlaces({ includeInvalid: true }).length, 1);
  }));

  test(`[${backend}] a named place guides the action: the name resolves to a destination`, () => withMemory(backend, (wm) => {
    wm.rememberToldPlace({ name: 'campo di patate', position: potatoField, toldBy: 'Ale', toldAt: T0 });
    // «vai al campo di patate» — nessuna coordinata nel comando: la destinazione
    // si risolve dal nome, ed è quella che l'umano ha dettato.
    const resolved = wm.resolvePlace({ name: 'campo di patate' });
    assert.equal(resolved.action, 'found');
    assert.deepEqual(resolved.place.position, potatoField);
    assert.equal(resolved.place.dimension, 'overworld');
    // Un nome che la memoria non ha non si indovina.
    assert.equal(wm.resolvePlace({ name: 'castello di sabbia' }).action, 'unknown');
  }));
}

// Ridire lo stesso fatto non è una correzione: senza questa regola ogni ripetizione
// — il caso più comune, perché l'umano non sa di averla già detta — lascerebbe una
// riga di storia per un fatto identico.
for (const backend of BACKENDS) {
  test(`[${backend}] repeating the same fact leaves the history alone`, () => withMemory(backend, (wm) => {
    const first = wm.tellPlace({ name: 'campo di patate', position: potatoField, dimension: 'overworld', toldBy: 'Ale', toldAt: T0 });
    assert.equal(first.action, 'created');

    const again = wm.tellPlace({ name: 'campo di patate', position: potatoField, dimension: 'overworld', toldBy: 'Ale', toldAt: T0 + HOUR });
    assert.equal(again.action, 'unchanged', 'la stessa posizione non è una correzione');
    assert.equal(again.place.id, first.place.id);
    assert.equal(again.previous, null, 'non c\'è una posizione precedente da annunciare');
    assert.equal((again.place.history ?? []).length, 0, 'la storia resta vuota');
    assert.equal(wm.toldPlaces().length, 1, 'sempre un posto, non due');

    // Stessa posizione ma un nome nuovo: lì la frase sta dicendo «si chiama così»,
    // quindi è una correzione vera e la storia la registra.
    const renamed = wm.tellPlace({ name: 'campo di patate', label: "l'orto grande", position: potatoField, dimension: 'overworld', toldBy: 'Ale', toldAt: T0 + 2 * HOUR });
    assert.equal(renamed.action, 'corrected');
    assert.equal(renamed.place.label, "l'orto grande");
    assert.equal(renamed.place.history.length, 1);
  }));
}
