// Unit tests for the M5 chat replies (wiki/human-command.md): the ack of an
// accepted order and the outcome line when the goal closes. Pure functions, so
// no harness and no clock: the interesting part is the *shape* of the message
// (one line, bounded, addressed to the sender, never an order for the bot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  orderAck, orderOutcome, clampMessage, renderReply, isSelfTriggering,
  DEFAULT_REPLY_MAX_LENGTH,
} from '../human-replies.mjs';

test('an accepted order is acked with the understood objective', () => {
  const msg = orderAck({ from: 'Ale', plan: { objective: 'prendi 4 terra', targets: { dirt: 4 } } });
  assert.equal(msg, '@Ale ok: prendi 4 terra');
});

test('an escort order names the human the bot is coming to', () => {
  const msg = orderAck({ from: 'Ale', plan: { objective: 'seguimi', follow: 'Ale' } });
  assert.match(msg, /^@Ale ok: seguimi — arrivo da Ale$/);
});

test('the ack never starts with the order trigger (the bot cannot trigger itself)', () => {
  const bySender = orderAck({ from: 'Ale', plan: { objective: '@bot mina ferro' } });
  assert.equal(isSelfTriggering(bySender, '@bot'), false);
  assert.equal(isSelfTriggering('@bot mina ferro', '@bot'), true);
  assert.equal(isSelfTriggering('@BOT mina ferro', '@bot'), true);
  assert.equal(isSelfTriggering('@Botty mina ferro', '@bot'), true);
  assert.equal(isSelfTriggering('@Ale ok', '@bot'), false);
});

test('a reply is one line and never longer than the limit', () => {
  const long = 'x'.repeat(500);
  const msg = orderAck({ from: 'Ale', plan: { objective: long }, maxLength: 40 });
  assert.equal(msg.length, 40);
  assert.ok(msg.endsWith('…'));
  assert.equal(msg.includes('\n'), false);
  const multi = orderAck({ from: 'Ale', plan: { objective: 'prendi\nla\tterra  per favore' } });
  assert.equal(multi, '@Ale ok: prendi la terra per favore');
  assert.ok(orderAck({ from: 'Ale', plan: { objective: 'x' } }).length <= DEFAULT_REPLY_MAX_LENGTH);
});

test('a missing objective still produces a usable ack', () => {
  assert.equal(orderAck({ from: 'Ale', plan: {} }), '@Ale ok: ordine ricevuto');
  assert.equal(orderAck({ plan: { objective: 'x' } }), '@? ok: x');
});

test('the outcome line reports success with the action count', () => {
  const msg = orderOutcome({ from: 'Ale', status: 'success', objective: 'prendi 4 terra', steps: 7 });
  assert.equal(msg, '@Ale fatto: prendi 4 terra (7 azioni)');
  const unknownSteps = orderOutcome({ from: 'Ale', status: 'success', objective: 'x', steps: null });
  assert.equal(unknownSteps, '@Ale fatto: x (? azioni)');
});

test('the outcome line reports failure and cancellation differently', () => {
  const failed = orderOutcome({ from: 'Ale', status: 'failed', objective: 'x', reason: 'controller_error: boom' });
  assert.equal(failed, "@Ale non ce l'ho fatta: controller_error: boom");
  const stopped = orderOutcome({ from: 'Ale', status: 'exhausted', objective: 'x', reason: 'exhausted' });
  assert.equal(stopped, '@Ale mi fermo qui: exhausted');
  const noReason = orderOutcome({ from: 'Ale', status: 'exhausted', objective: 'x' });
  assert.equal(noReason, '@Ale mi fermo qui: budget di azioni esaurito');
});

test('clampMessage collapses whitespace, trims and truncates', () => {
  assert.equal(clampMessage('  a \n b \t c  '), 'a b c');
  assert.equal(clampMessage('', 10), '');
  assert.equal(clampMessage(null, 10), '');
  assert.equal(clampMessage('abcdef', 4), 'abc…');
  assert.equal(clampMessage('abc', 0), 'abc'); // invalid limit -> default
  const clamped = clampMessage('x'.repeat(10), 1);
  assert.equal(clamped.length, 1);
});

test('renderReply leaves unknown placeholders empty and clamps the result', () => {
  assert.equal(renderReply('a {one} b {two}', { one: '1' }, 50), 'a 1 b');
  assert.equal(renderReply('{a}{b}{c}', {}, 50), '');
});
