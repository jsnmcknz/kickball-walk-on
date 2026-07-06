const assert = require('assert');
const L = require('./lineup-logic');

const ALL = ['a','b','c','d','e']; // 5 players for readable tests

// -- membership / gap-closing --
{
  let order = ['a','b','c','d'];
  order = L.benchPlayer(order, 'b');
  assert.deepStrictEqual(order, ['a','c','d'], 'bench closes gap, no hole');
  assert.deepStrictEqual(L.computeBenched(ALL, order), ['b','e'], 'benched = not in order');
  order = L.addToOrder(order, 'b');
  assert.deepStrictEqual(order, ['a','c','d','b'], 'tap-in appends to end');
}

// -- drag reorder --
{
  let order = ['a','b','c','d'];
  order = L.moveInOrder(order, 'd', 0);
  assert.deepStrictEqual(order, ['d','a','b','c'], 'drag to front');
  order = L.moveInOrder(order, 'a', 2);
  assert.deepStrictEqual(order, ['d','b','a','c'], 'drag to middle');
}

// -- pointer wrap --
{
  const order = ['a','b','c'];
  assert.strictEqual(L.nextPointer(order, 'a'), 'b');
  assert.strictEqual(L.nextPointer(order, 'c'), 'a', 'wraps last -> first');
  assert.strictEqual(L.prevPointer(order, 'a'), 'c', 'wraps first -> last (back)');
  assert.strictEqual(L.prevPointer(order, 'b'), 'a');
}

// -- non-destructive edits: pointer identity survives reorders --
{
  let order = ['a','b','c','d'];
  let pointer = 'c';
  order = L.moveInOrder(order, 'a', 3); // shuffle unrelated player
  pointer = L.resolvePointer(order, pointer);
  assert.strictEqual(pointer, 'c', 'pointer stays on same person after unrelated drag');
}

// -- benching the current up player falls back sanely --
{
  let order = ['a','b','c','d'];
  let pointer = 'b';
  order = L.benchPlayer(order, 'b');
  pointer = L.resolvePointer(order, pointer);
  assert.strictEqual(pointer, 'a', 'if pointer is benched, falls back to new order[0]');
}

// -- benching everyone except current up: pointer still resolves --
{
  let order = ['a'];
  let pointer = 'a';
  assert.strictEqual(L.resolvePointer(order, pointer), 'a');
  order = L.benchPlayer(order, 'a');
  assert.strictEqual(L.resolvePointer(order, null), null, 'empty order -> null pointer, no crash');
}

// -- on-deck strip: no dupes/padding on small rosters --
{
  assert.deepStrictEqual(L.onDeckIds(['a','b','c','d','e'], 'a'), ['b','c','d'], 'normal case: next 3');
  assert.deepStrictEqual(L.onDeckIds(['a','b','c','d','e'], 'd'), ['e','a','b'], 'wraps around end');
  assert.deepStrictEqual(L.onDeckIds(['a','b'], 'a'), ['b'], 'only 1 other player -> 1 chip, no dupes');
  assert.deepStrictEqual(L.onDeckIds(['a'], 'a'), [], 'solo player -> no on-deck chips');
  assert.deepStrictEqual(L.onDeckIds([], null), [], 'empty order -> no chips, no crash');
}

// -- position counter --
{
  assert.deepStrictEqual(L.positionLabel(['a','b','c'], 'b'), { position: 2, total: 3 });
  assert.strictEqual(L.positionLabel([], null), null);
}

// -- late arrival mid-game doesn't disturb who's up --
{
  let order = ['a','b','c'];
  let pointer = 'b';
  order = L.addToOrder(order, 'z'); // late arrival
  pointer = L.resolvePointer(order, pointer);
  assert.strictEqual(pointer, 'b', 'adding a late arrival never moves the current pointer');
  assert.deepStrictEqual(order, ['a','b','c','z']);
}

console.log('ALL LINEUP LOGIC TESTS PASSED');
