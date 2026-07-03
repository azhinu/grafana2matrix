import test from 'node:test';
import assert from 'node:assert/strict';
import { getAlertValue, getSilencesFilterFunction, parseTimeToMinutes } from '../src/util.js';

test('getAlertValue reads labels, top-level values, annotations, and defaults safely', () => {
    assert.equal(getAlertValue({ labels: { severity: 'critical' } }, 'severity', 'UNKNOWN'), 'critical');
    assert.equal(getAlertValue({ severity: 'warning' }, 'severity', 'UNKNOWN'), 'warning');
    assert.equal(getAlertValue({ annotations: { severity: 'info' } }, 'severity', 'UNKNOWN'), 'info');
    assert.equal(getAlertValue({}, 'severity', 'UNKNOWN'), 'UNKNOWN');
    assert.equal(getAlertValue(null, 'severity', 'UNKNOWN'), 'UNKNOWN');
});

test('getSilencesFilterFunction handles missing severity matcher', () => {
    const filter = getSilencesFilterFunction('WARN');

    assert.equal(filter({ matchers: [] }), false);
    assert.equal(filter({}), false);
    assert.equal(filter({ matchers: [{ name: 'severity', value: 'warning' }] }), true);
});

test('parseTimeToMinutes parses valid time and rejects malformed input', () => {
    assert.equal(parseTimeToMinutes('06:30'), 390);
    assert.equal(parseTimeToMinutes('bad'), -1);
    assert.equal(parseTimeToMinutes('10'), -1);
});
