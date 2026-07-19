import test from 'node:test';
import assert from 'node:assert/strict';
import { DURATION_UNIT_TO_MS, getNumberEmojiDays, getReplyBody, isDeleteCommand, parseDurationInput } from '../src/mute.js';

test('getNumberEmojiDays accepts keycap digits with and without variation selectors', () => {
    assert.equal(getNumberEmojiDays('1️⃣'), 1);
    assert.equal(getNumberEmojiDays('1⃣'), 1);
    assert.equal(getNumberEmojiDays('7️⃣'), 7);
    assert.equal(getNumberEmojiDays('8️⃣'), null);
});

test('getReplyBody removes the Matrix plain-text reply fallback', () => {
    assert.equal(getReplyBody({ body: '> <@bot:example.org> Alert text\n\n2d' }), '2d');
    assert.equal(getReplyBody({ body: '2d' }), '2d');
});

test('parseDurationInput accepts a reply duration after fallback removal', () => {
    const duration = parseDurationInput(getReplyBody({ body: '> <@bot:example.org> Alert text\n\n1:2:30' }));

    assert.deepEqual(duration, {
        durationMs: DURATION_UNIT_TO_MS.d + (2 * DURATION_UNIT_TO_MS.h) + (30 * DURATION_UNIT_TO_MS.m),
        text: '1 day 2 hours 30 minutes'
    });
});

test('isDeleteCommand only accepts explicit delete aliases', () => {
    assert.equal(isDeleteCommand('del'), true);
    assert.equal(isDeleteCommand(' DELETE '), true);
    assert.equal(isDeleteCommand('delete this'), false);
});
