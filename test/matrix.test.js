import test from 'node:test';
import assert from 'node:assert/strict';
import { MatrixServer } from '../src/matrix.js';

const formatMessageBody = (message) => {
    const formatter = Object.create(MatrixServer.prototype);
    return formatter.formatMessageBody(message);
};

test('formatMessageBody escapes unsafe HTML from alert fields', () => {
    const body = formatMessageBody('<font color="#d20000">**CRIT: <img src=x onerror=alert(1)>**</font>');

    assert.equal(
        body.formatted_body,
        '<font color="#d20000"><b>CRIT: &lt;img src=x onerror=alert(1)&gt;</b></font>'
    );
});

test('formatMessageBody drops unsafe links and keeps https links', () => {
    const body = formatMessageBody('[Bad](javascript:alert(1)) [Good](https://example.com/a?b=1&c=2)');

    assert.equal(
        body.formatted_body,
        'Bad <a href="https://example.com/a?b=1&amp;c=2">Good</a>'
    );
});

test('safeEmitAsync waits listeners and continues after handler failure', async () => {
    const matrix = Object.create(MatrixServer.prototype);
    Object.assign(matrix, {
        _events: Object.create(null),
        _eventsCount: 0,
        _maxListeners: undefined,
    });

    const calls = [];
    const originalError = console.error;
    console.error = () => {};

    try {
        matrix.on('event', async () => {
            calls.push('first');
            throw new Error('Boom');
        });
        matrix.on('event', async () => {
            calls.push('second');
        });

        await matrix.safeEmitAsync('event', {});
    } finally {
        console.error = originalError;
    }

    assert.deepEqual(calls, ['first', 'second']);
});
