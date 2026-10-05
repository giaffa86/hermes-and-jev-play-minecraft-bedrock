// M8: the line the bot says when it starts a job on its own. Pure composition:
// no server, no model. The sentence must exist in every language, name the
// concrete thing when the catalogue knows it, and never leak a raw id.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, DEFAULT_LANG, hasMessage, MESSAGES, t } from '../chat-i18n.mjs';
import { narrateGoal, narrateChore, narrateNeed, targetWord } from '../chat-narration.mjs';
import { VILLAGE_CHORES } from '../village-labor.mjs';
import { NEED_PRIORITY } from '../survival/needs.mjs';
import { DEFAULT_REPLY_MAX_LENGTH } from '../human-replies.mjs';

const potato = { kind: 'crop', item: 'potato' };

test('every village chore has a progressive form in every language', () => {
  for (const chore of VILLAGE_CHORES) {
    for (const lang of LANGS) {
      assert.ok(hasMessage(lang, `narrate.${chore.id}`), `narrate.${chore.id} missing in ${lang}`);
      assert.ok(narrateChore(chore.id, potato, { lang }), `${chore.id} does not compose in ${lang}`);
    }
  }
});

test('every need of the governor can be announced in every language', () => {
  for (const need of Object.keys(NEED_PRIORITY)) {
    for (const lang of LANGS) {
      assert.ok(hasMessage(lang, `need.${need}`), `need.${need} missing in ${lang}`);
      assert.ok(narrateNeed(need, { lang }), `${need} does not compose in ${lang}`);
    }
  }
});

test('the announcement names the concrete crop the census saw', () => {
  const plan = { chore: 'harvest_crops', choreTarget: potato };
  assert.equal(narrateGoal(plan), 'In autonomia: sto raccogliendo le patate');
  assert.equal(narrateGoal(plan, { lang: 'en' }), "On my own: I'm harvesting the potatoes");
  assert.equal(narrateGoal(plan, { lang: 'fr' }), 'En autonomie : je récolte les pommes de terre');
  assert.equal(narrateGoal(plan, { lang: 'es' }), 'En autonomía: estoy cosechando las patatas');
  assert.equal(narrateGoal(plan, { lang: 'de' }), 'Selbstständig: ich ernte die Kartoffeln');
});

test('the target falls back to the family word, never to a raw id', () => {
  assert.equal(targetWord({ kind: 'log' }), 'la legna');
  assert.equal(targetWord({ kind: 'ore' }), 'i minerali');
  assert.equal(targetWord({ kind: 'crop', item: 'unobtainium' }), 'le colture');
  assert.equal(targetWord({ kind: 'crop', item: 'wheat' }), 'il grano');
  assert.equal(targetWord(null), 'la roba raccolta');
  assert.equal(narrateGoal({ chore: 'chop_wood', choreTarget: { kind: 'log' } }), 'In autonomia: sto tagliando la legna');
  assert.equal(narrateGoal({ chore: 'mine_ore', choreTarget: { kind: 'ore' } }), 'In autonomia: sto estraendo i minerali');
  for (const lang of LANGS) {
    const text = narrateGoal({ chore: 'gather_stone', choreTarget: { kind: 'stone' } }, { lang });
    assert.ok(!text.includes('{') && !text.includes('}'), `placeholder left in ${lang}: ${text}`);
  }
});

test('a survival need is announced with the need catalogue', () => {
  assert.equal(narrateGoal({ need: 'sleep' }), 'In autonomia devo andare a dormire');
  assert.equal(narrateGoal({ need: 'eat' }, { lang: 'en' }), 'On my own I am eating something');
  assert.equal(narrateGoal({ need: 'escape' }, { lang: 'fr' }), "En autonomie, je suis en train de fuir le danger");
  assert.equal(narrateGoal({ need: 'heal' }, { lang: 'es' }), 'En autonomía voy a curarme');
  assert.equal(narrateGoal({ need: 'surface' }, { lang: 'de' }), 'Selbstständig muss ich wieder an die Oberfläche kommen');
});

test('nothing to say means no message at all', () => {
  assert.equal(narrateGoal(null), null);
  assert.equal(narrateGoal({}), null);
  assert.equal(narrateGoal({ objective: 'do something' }), null);
  assert.equal(narrateGoal({ chore: 'not_a_chore' }), null);
  assert.equal(narrateGoal({ need: 'not_a_need' }), null);
});

test('a chore whose progressive form is missing is not announced', () => {
  assert.equal(narrateChore('not_a_chore', potato), null);
  assert.equal(narrateNeed('not_a_need'), null);
});

test('every announcement is one line that fits the chat budget', () => {
  const cases = [
    ...VILLAGE_CHORES.map(chore => ({ chore: chore.id, choreTarget: potato })),
    ...Object.keys(NEED_PRIORITY).map(need => ({ need })),
  ];
  for (const plan of cases) {
    for (const lang of LANGS) {
      const text = narrateGoal(plan, { lang });
      if (!text) continue;
      assert.ok(!text.includes('\n'), `announcement is multiline in ${lang}: ${text}`);
      assert.ok(text.length <= DEFAULT_REPLY_MAX_LENGTH, `announcement too long in ${lang}: ${text}`);
    }
  }
});

test('the frame comes from the catalogue, not from a hardcoded string', () => {
  assert.ok(MESSAGES[DEFAULT_LANG]['autonomy_narration'].includes('{phrase}'));
  assert.equal(t(DEFAULT_LANG, 'autonomy_narration', { phrase: 'x' }), 'In autonomia: x');
  assert.ok(MESSAGES[DEFAULT_LANG]['narrate_need'].includes('{phrase}'));
});
