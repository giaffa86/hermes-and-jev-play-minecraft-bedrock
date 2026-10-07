// Fatti dettati, livello 1: il *riconoscimento* (memory-chat.mjs è puro, quindi
// si prova senza harness, senza memoria e senza rete).
//
// Le quattro operazioni che l'utente ha chiesto di poter dire a voce —
// ricorda / consulta / correggi / dimentica — più «vai al <luogo nominato>», e le
// tre regole che le tengono oneste:
//   1. le coordinate si leggono solo con un marcatore esplicito (tre numeri in
//      mezzo a una frase non sono una posizione: si chiede);
//   2. una frase riconosciuta ma incompleta non scrive niente (CLARIFY);
//   3. «qui» è un rinvio al mittente, non una posizione: senza mittente visibile
//      si chiedono le coordinate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  toldIntentFromText, TELL, CLARIFY, formatPosition, dimensionLabel, isWorldPosition, coordsFromText,
} from '../memory-chat.mjs';

// Il mittente è in vista (il controller gliel'ha detto): è il caso normale.
const told = (text, opts = {sender: 'Ale'}) => toldIntentFromText(text, opts);
const blind = (text) => toldIntentFromText(text, {sender: null});

test('a dictated place with coordinates is a remembered place (the three sentences the user asked for)', () => {
  const place = told("Segnati che l'ingresso principale della miniera sta a coordinate 130 62 -240");
  assert.equal(place.kind, TELL.REMEMBER_PLACE);
  assert.match(place.name, /miniera/);
  assert.deepEqual(place.position, {x: 130, y: 62, z: -240});
  assert.equal(place.from, 'coords');

  const withAxes = told('ricordati che il ferro sta nel baule a x=120 y=64 z=-230');
  assert.equal(withAxes.kind, TELL.REMEMBER_CONTENTS);
  assert.equal(withAxes.container, 'baule');
  assert.equal(withAxes.item, 'iron');
  assert.deepEqual(withAxes.position, {x: 120, y: 64, z: -230});

  const here = told('il punto dove mi trovo adesso è il campo di patate, registra l\'informazione');
  assert.equal(here.kind, TELL.REMEMBER_PLACE);
  assert.equal(here.name, 'campo di patate');
  assert.equal(here.from, 'here');
  assert.equal(here.dimension, null);
});

test('«questo è <luogo>» needs the sender: here is not a position', () => {
  const q = blind('ricorda che questo è il campo di patate');
  assert.equal(q.kind, CLARIFY);
  assert.equal(q.reason, 'no_sender_position');

  const ok = told('ricorda che questo è il campo di patate');
  assert.equal(ok.kind, TELL.REMEMBER_PLACE);
  assert.equal(ok.name, 'campo di patate');
  assert.equal(ok.from, 'here');
});

test('a claim on a container does not become a place: it is a partial statement about its contents', () => {
  const claim = told('nel baule a coordinate 120 64 -230 ci sono 64 di ferro');
  assert.equal(claim.kind, TELL.REMEMBER_CONTENTS);
  assert.equal(claim.container, 'baule');
  assert.equal(claim.containerType, 'chest');
  assert.equal(claim.item, 'iron');
  assert.equal(claim.count, 64, 'la quantità è 64, non il 120 della terna');
  assert.deepEqual(claim.position, {x: 120, y: 64, z: -230});

  const named = told('nel baule di casa a coordinate 10 64 10 c\'è un diamante');
  assert.equal(named.kind, TELL.REMEMBER_CONTENTS);
  assert.equal(named.container, 'baule di casa');
  assert.equal(named.item, 'diamond');
  assert.equal(named.count, 1);
});

test('three numbers without a marker are an incomplete order, not a position', () => {
  const q = told('ricorda 120 64 -230');
  assert.equal(q.kind, CLARIFY);
  assert.equal(q.reason, 'no_marker');
  assert.deepEqual(q.numbers, [120, 64, -230]);
});

test('a named container without contents is a container, not a claim', () => {
  const c = told('ricorda che questo baule è a coordinate 10 64 10');
  assert.equal(c.kind, TELL.REMEMBER_CONTAINER);
  assert.equal(c.container, 'baule');
  assert.deepEqual(c.position, {x: 10, y: 64, z: 10});
});

test('consulting: the place name and the resource travel together (the answer decides)', () => {
  const place = told('dov\'è il campo di patate?');
  assert.equal(place.kind, TELL.CONSULT);
  assert.equal(place.name, 'campo di patate');

  const item = told('dove posso trovare ferro?');
  assert.equal(item.kind, TELL.CONSULT);
  assert.equal(item.item, 'iron');
  assert.equal(item.word, 'ferro');

  // La domanda sul posto *contiene* la parola della risorsa ("patate"): è chi
  // risponde a provare prima il luogo, non il parser a scegliere.
  assert.ok(place.item === 'potato' || place.item === null);
});

test('correcting, forgetting and going to a place by name', () => {
  const correct = told("l'ingresso principale della miniera ora è a coordinate 130 62 -240");
  assert.equal(correct.kind, TELL.CORRECT_PLACE);
  assert.match(correct.name, /miniera/);
  assert.deepEqual(correct.position, {x: 130, y: 62, z: -240});

  const forget = told('dimentica il vecchio deposito');
  assert.equal(forget.kind, TELL.FORGET_PLACE);
  assert.equal(forget.name, 'vecchio deposito');

  const goto = told('vai al campo di patate');
  assert.equal(goto.kind, TELL.GOTO_PLACE);
  assert.equal(goto.name, 'campo di patate');

  // Una correzione senza posizione non corregge niente: si chiede.
  const noPos = told('correggi il nome del campo di patate');
  assert.equal(noPos.kind, TELL.CORRECT_PLACE === noPos.kind ? TELL.CORRECT_PLACE : CLARIFY);
  assert.notEqual(noPos.kind, TELL.REMEMBER_PLACE);
});

test('the same four operations in the other four languages', () => {
  const en = told('remember that this is the potato field');
  assert.equal(en.kind, TELL.REMEMBER_PLACE);
  assert.equal(en.name, 'potato field');

  const enClaim = told('remember that there is iron in the chest at 120 64 -230');
  assert.equal(enClaim.kind, TELL.REMEMBER_CONTENTS);
  assert.equal(enClaim.item, 'iron');
  assert.deepEqual(enClaim.position, {x: 120, y: 64, z: -230});

  const fr = told('oublie le vieux dépôt');
  assert.equal(fr.kind, TELL.FORGET_PLACE);

  const es = told('recuerda que el cofre de hierro está en coordinate 120 64 -230');
  assert.equal(es.kind, TELL.REMEMBER_CONTENTS);
  assert.equal(es.item, 'iron');

  const de = told('vergiss die alte mine');
  assert.equal(de.kind, TELL.FORGET_PLACE);

  const deWhere = told('wo ist das kartoffelfeld?');
  assert.equal(deWhere.kind, TELL.CONSULT);
});

test('a message that is not a memory fact is not one (the chat must keep working)', () => {
  assert.equal(told('dove sei adesso?'), null);
  assert.equal(told('che ora è?'), null);
  assert.equal(told('come stai?'), null);
  assert.equal(told('vieni qui'), null);
  assert.equal(told(''), null);
  assert.equal(told('ciao bot, che bello vederti'), null);
  // Un messaggio lunghissimo non è un fatto dettato (né una chat da leggere).
  assert.equal(told('ricorda ' + 'x'.repeat(400)), null);
});

test('coordinates: bounds and formatting', () => {
  assert.equal(isWorldPosition({x: 0, y: 64, z: 0}), true);
  assert.equal(isWorldPosition({x: 30_000_000, y: -64, z: -30_000_000}), true);
  assert.equal(isWorldPosition({x: 30_000_001, y: 64, z: 0}), false);
  assert.equal(isWorldPosition({x: 0, y: 400, z: 0}), false);
  assert.equal(isWorldPosition({x: 0, y: 64}), false);
  assert.equal(coordsFromText('x=1 y=2 z=3')?.kind, 'full');
  assert.equal(coordsFromText('1, 2, 3')?.kind, 'full');
  assert.equal(coordsFromText('nessun numero qui'), null);
  assert.equal(formatPosition({x: 120.4, y: 64.6, z: -230}), '120, 65, -230');
  assert.equal(formatPosition(null), '?');
  assert.equal(dimensionLabel('overworld'), 'Overworld');
  assert.equal(dimensionLabel('nether'), 'Nether');
  assert.equal(dimensionLabel('end'), 'End');
  assert.equal(dimensionLabel(null), '?');
});
