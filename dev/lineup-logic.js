// Pure state-transition functions for the lineup/grid interaction algebra.
// Kept dependency-free and DOM-free so they can be unit tested directly in
// Node before being embedded into dist/index.html verbatim.

function computeBenched(allIds, order) {
  const inOrder = new Set(order);
  return allIds.filter(id => !inOrder.has(id));
}

// Bench a player: remove from order, gap closes automatically (array splice).
function benchPlayer(order, id) {
  return order.filter(x => x !== id);
}

// Tap a benched player: append to end of order.
function addToOrder(order, id) {
  if (order.includes(id)) return order.slice();
  return [...order, id];
}

// Drag: move player `id` to `toIndex` in the order array.
function moveInOrder(order, id, toIndex) {
  const cur = order.filter(x => x !== id);
  const clamped = Math.max(0, Math.min(toIndex, cur.length));
  cur.splice(clamped, 0, id);
  return cur;
}

// After any edit, make sure the pointer still points at someone in the order.
// Non-destructive: if the pointer's player is still present, don't move it.
function resolvePointer(order, pointerId) {
  if (pointerId !== null && order.includes(pointerId)) return pointerId;
  return order.length > 0 ? order[0] : null;
}

function nextPointer(order, pointerId) {
  if (order.length === 0) return null;
  const i = order.indexOf(pointerId);
  if (i === -1) return order[0];
  return order[(i + 1) % order.length];
}

function prevPointer(order, pointerId) {
  if (order.length === 0) return null;
  const i = order.indexOf(pointerId);
  if (i === -1) return order[0];
  return order[(i - 1 + order.length) % order.length];
}

// Next `count` kickers after the pointer, wrapping, never including the
// pointer itself, and never padded with duplicates when the roster is small.
function onDeckIds(order, pointerId, count = 3) {
  if (order.length <= 1) return [];
  const i = order.indexOf(pointerId);
  const start = i === -1 ? 0 : i;
  const n = Math.min(count, order.length - 1);
  const out = [];
  for (let k = 1; k <= n; k++) {
    out.push(order[(start + k) % order.length]);
  }
  return out;
}

function positionLabel(order, pointerId) {
  if (order.length === 0) return null;
  const i = order.indexOf(pointerId);
  if (i === -1) return null;
  return { position: i + 1, total: order.length };
}

module.exports = {
  computeBenched, benchPlayer, addToOrder, moveInOrder,
  resolvePointer, nextPointer, prevPointer, onDeckIds, positionLabel,
};
