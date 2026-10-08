import assert from 'node:assert/strict';
export const sum = (a,b) => a-b;
assert.equal(sum(2,4),6);
console.log('CLOUD_ACCEPTANCE_NODE_OK');
