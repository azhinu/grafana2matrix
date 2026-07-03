import test from 'node:test';
import assert from 'node:assert/strict';
import { notifyWebhookProcessingError } from '../src/webhook-error.js';

test('notifyWebhookProcessingError sends an error message to Matrix', async () => {
    const sentMessages = [];
    const originalError = console.error;
    console.error = () => {};

    try {
        await notifyWebhookProcessingError({
            sendMatrixNotification: async (message) => {
                sentMessages.push(message);
                return '$event';
            },
        }, new Error('Payload exploded'));
    } finally {
        console.error = originalError;
    }

    assert.deepEqual(sentMessages, ['Failed to process Grafana webhook: Payload exploded']);
});

test('notifyWebhookProcessingError does not throw when Matrix error notification fails', async () => {
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args.join(' '));

    try {
        await notifyWebhookProcessingError({
            sendMatrixNotification: async () => {
                throw new Error('Matrix is down');
            },
        }, new Error('Payload exploded'));
    } finally {
        console.error = originalError;
    }

    assert.equal(errors.length, 2);
    assert.match(errors[0], /Error processing webhook: Payload exploded/);
    assert.match(errors[1], /Failed to send webhook processing error to Matrix: Matrix is down/);
});
