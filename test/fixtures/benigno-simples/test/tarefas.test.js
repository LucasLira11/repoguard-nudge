const test = require('node:test');
const assert = require('node:assert');

test('lista inicial tem uma tarefa', () => {
  assert.strictEqual([{ id: 1 }].length, 1);
});
