import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchWithRetry } from '../src/fetch.js';

test('fetchWithRetry retries timed out requests with configured progression', async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    let calls = 0;

    console.warn = () => {};
    globalThis.fetch = (_url, options) => {
        calls += 1;
        return new Promise((resolve, reject) => {
            const delayMs = calls < 3 ? 50 : 1;
            const timer = setTimeout(() => resolve(new Response('ok')), delayMs);
            options.signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(options.signal.reason);
            });
        });
    };

    try {
        const response = await fetchWithRetry('https://example.test', {}, { timeoutsMs: [10, 20, 100] });

        assert.equal(await response.text(), 'ok');
        assert.equal(calls, 3);
    } finally {
        console.warn = originalWarn;
        globalThis.fetch = originalFetch;
    }
});

test('fetchWithRetry retries retryable HTTP responses', async () => {
    const originalFetch = globalThis.fetch;
    const originalWarn = console.warn;
    let calls = 0;

    console.warn = () => {};
    globalThis.fetch = async () => {
        calls += 1;
        return calls < 3 ? new Response('Temporary failure', { status: 500 }) : new Response('ok');
    };

    try {
        const response = await fetchWithRetry('https://example.test', {}, { timeoutsMs: [10, 20, 30] });

        assert.equal(response.status, 200);
        assert.equal(await response.text(), 'ok');
        assert.equal(calls, 3);
    } finally {
        console.warn = originalWarn;
        globalThis.fetch = originalFetch;
    }
});

test('fetchWithRetry does not retry non-retryable HTTP responses', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;

    globalThis.fetch = async () => {
        calls += 1;
        return new Response('Unauthorized', { status: 401 });
    };

    try {
        const response = await fetchWithRetry('https://example.test', {}, { timeoutsMs: [10, 20, 30] });

        assert.equal(response.status, 401);
        assert.equal(calls, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
