import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNewer } from '../src/network/updateCheck.js';

test('isNewer compares x.y.z versions numerically', () => {
  assert.equal(isNewer('1.0.2', '1.0.1'), true);
  assert.equal(isNewer('1.10.0', '1.9.9'), true);
  assert.equal(isNewer('2.0.0', '1.99.99'), true);
  assert.equal(isNewer('1.0.1', '1.0.1'), false);
  assert.equal(isNewer('1.0.0', '1.0.1'), false);
  assert.equal(isNewer('1.0.1', '1.0.1-dev'), false);
});
