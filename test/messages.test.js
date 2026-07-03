import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatrixMessage } from '../src/messages.js';

test('createMatrixMessage builds firing alert message', () => {
    const message = createMatrixMessage({
        status: 'firing',
        labels: {
            alertname: 'DiskFull',
            host: 'db-01',
            severity: 'critical',
        },
        annotations: {
            summary: 'Disk usage is high',
            description: 'Root partition is almost full',
        },
        generatorURL: 'https://grafana.example/alert/1',
    });

    assert.match(message, /CRITICAL: DiskFull/);
    assert.match(message, /\*\*HOST: db-01\*\*/);
    assert.match(message, /Disk usage is high/);
    assert.match(message, /Root partition is almost full/);
    assert.match(message, /\[View Alert\]\(https:\/\/grafana\.example\/alert\/1\)/);
});

test('createMatrixMessage marks resolved alerts', () => {
    const message = createMatrixMessage({
        status: 'resolved',
        labels: {
            alertname: 'CpuHigh',
            instance: 'api-01',
            severity: 'warn',
        },
        annotations: {},
    });

    assert.match(message, /RESOLVED WARN: CpuHigh/);
    assert.match(message, /\*\*HOST: api-01\*\*/);
});

test('createMatrixMessage tolerates missing labels and annotations', () => {
    const message = createMatrixMessage({
        status: 'firing',
    });

    assert.match(message, /UNKNOWN: Unknown Alert/);
    assert.match(message, /\*\*HOST: Unknown Host\*\*/);
});
