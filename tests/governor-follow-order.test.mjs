// Patch 10 — l'ordine umano "seguimi" sopravvive al filtro di emergenza.
//
// Live 04/10 (m01471): con il bot a hp 3 il governor e' in `emergency` e il
// filtro toglieva `follow_player` (intento `unknown`), lasciando solo
// `go_home`/`sleep`: il bot "tornava indietro tipo spaesato" invece di seguire
// l'umano. Il fail-open spiegava l'alternanza (quando nulla di ammesso
// sopravviveva tornavano tutte le opzioni, inseguimento compreso).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { filterOptionsForGovernor } from '../survival/resolver.mjs';
import { optionIntents } from '../survival/intents.mjs';

const EMERGENCY = { mode: 'emergency', allowedIntents: ['heal', 'eat', 'escape', 'shelter'], needs: ['survive', 'heal'] };

function offered () {
  return [
    { key: 'follow_player', description: 'Follow Ale (3.0 blocks away)' },
    { key: 'seek_player', description: 'Search Ale' },
    { key: 'sleep', description: 'Sleep in the bed' },
    { key: 'go_home', description: 'Walk home' },
    { key: 'mine_dirt', description: 'Mine dirt' },
    { key: 'wait', description: 'Wait' },
  ];
}

const keysOf = result => result.options.map(option => option.key);

test('follow_player ha un intento dichiarato (non più `unknown`)', () => {
  assert.deepEqual(optionIntents('follow_player'), ['travel']);
  assert.deepEqual(optionIntents('seek_player'), ['travel']);
});

test('in emergenza, senza ordine umano, l\'inseguimento resta filtrato', () => {
  const result = filterOptionsForGovernor(offered(), EMERGENCY);
  assert.equal(result.filtered, true);
  assert.equal(keysOf(result).includes('follow_player'), false);
  assert.equal(keysOf(result).includes('seek_player'), false);
  assert.equal(keysOf(result).includes('sleep'), true, 'sleep resta: intento heal');
  assert.equal(keysOf(result).includes('go_home'), true, 'go_home resta: escape/shelter');
  assert.equal(keysOf(result).includes('mine_dirt'), false);
  assert.equal(keysOf(result).includes('wait'), false, 'wait non passa mai dal filtro');
  assert.equal(result.removed.some(entry => entry.key === 'follow_player'), true);
});

test('un ordine umano aperto protegge inseguimento e ricerca', () => {
  const result = filterOptionsForGovernor(offered(), EMERGENCY, { protectedKeys: ['follow_player', 'seek_player'] });
  const keys = keysOf(result);
  assert.equal(keys.includes('follow_player'), true);
  assert.equal(keys.includes('seek_player'), true);
  assert.equal(keys.includes('sleep'), true, 'il bisogno urgente resta disponibile');
  assert.equal(keys.includes('mine_dirt'), false, 'le altre key restano filtrate');
  assert.equal(result.removed.some(entry => entry.key === 'follow_player'), false);
});

test('fuori dall\'emergenza il filtro non tocca nulla (nemmeno con key protette)', () => {
  const calm = { mode: 'caution', allowedIntents: ['heal'] };
  const result = filterOptionsForGovernor(offered(), calm, { protectedKeys: ['follow_player'] });
  assert.equal(result.filtered, false);
  assert.equal(result.reason, null);
  assert.equal(result.options.length, offered().length);
});

test('il fail-open resta: se nulla è ammesso tornano tutte le opzioni', () => {
  const hostile = { mode: 'emergency', allowedIntents: ['swim'] };
  const result = filterOptionsForGovernor(offered(), hostile);
  assert.equal(result.filtered, false);
  assert.equal(result.reason, 'no_allowed_option');
  assert.equal(result.options.length, offered().length);
});

test('la rotta /options del harness protegge le key dell\'ordine umano', () => {
  const source = readFileSync(new URL('../bedrock-harness.mjs', import.meta.url), 'utf8');
  assert.match(source, /const humanOrderKeys = obs\.plan\?\.follow \? \['follow_player', 'seek_player'\] : \[\];/);
  assert.match(source, /filterOptionsForGovernor\(offered, survival, \{ protectedKeys: humanOrderKeys \}\)/);
});
