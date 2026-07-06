// Minimal fake DOM + browser globals sufficient to boot the app script and
// exercise its render/state logic outside a real browser. Not a substitute
// for on-device testing (drag gestures, real audio, Safari quirks) -- but
// it catches ReferenceErrors, thrown exceptions, and state-machine bugs in
// the render/click-handler wiring before Jason ever sees the file.

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(c) { this.set.add(c); }
  remove(c) { this.set.delete(c); }
  toggle(c, force) {
    if (force === undefined) { this.set.has(c) ? this.set.delete(c) : this.set.add(c); }
    else if (force) this.set.add(c); else this.set.delete(c);
  }
  contains(c) { return this.set.has(c); }
  toString() { return [...this.set].join(' '); }
}

class FakeElement {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase();
    this._children = [];
    this._listeners = {};
    this.classList = new FakeClassList();
    this.parentElement = null;
    this._text = '';
    this.disabled = false;
  }
  set className(v) { this.classList.set = new Set(v.split(' ').filter(Boolean)); }
  get className() { return this.classList.toString(); }
  set textContent(v) { this._text = v; this._children = []; }
  get textContent() {
    if (this._children.length === 0) return this._text;
    return this._children.map(c => c.textContent).join('');
  }
  set innerHTML(v) { if (v === '') this._children = []; }
  appendChild(child) { child.parentElement = this; this._children.push(child); return child; }
  setAttribute(k, v) { if (k === 'disabled') this.disabled = true; }
  addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
  removeEventListener() {}
  dispatch(type, evt) { (this._listeners[type] || []).forEach(fn => fn(evt || {})); }
  // Real disabled buttons block both user clicks AND programmatic .click()
  // calls -- mirror that here so a regression on the disabled-state bug
  // (setAttribute('disabled', null) still disables, see app.template.html
  // h()) would make this harness's click() silently no-op, same as a real
  // browser, instead of masking the bug like the old stub did.
  click() { if (this.disabled) return; this.dispatch('click', {}); }
  querySelectorAll(sel) {
    const cls = sel.replace('.', '');
    const out = [];
    const walk = (node) => {
      if (node.classList && node.classList.contains(cls)) out.push(node);
      node._children.forEach(walk);
    };
    walk(this);
    return out;
  }
  closest(sel) {
    const cls = sel.replace('.', '');
    let node = this;
    while (node) {
      if (node.classList && node.classList.contains(cls)) return node;
      node = node.parentElement;
    }
    return null;
  }
  getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 60 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  get style() { return {}; }
}

const registry = {};
global.document = {
  createElement: (tag) => new FakeElement(tag),
  getElementById: (id) => registry[id] || (registry[id] = new FakeElement('div')),
  addEventListener: () => {},
  elementFromPoint: () => null,
};

let store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = v; },
  removeItem: (k) => { delete store[k]; },
};

global.navigator = {}; // no wakeLock -> exercises the feature-detect skip path

class FakeParam { constructor() { this.value = 1; } cancelScheduledValues() {} setValueAtTime() {} linearRampToValueAtTime() {} }
class FakeGain { constructor() { this.gain = new FakeParam(); } connect() { return this; } }
class FakeSource {
  constructor() { this.buffer = null; this.onended = null; }
  connect() { return this; }
  start() {}
  stop() { if (this.onended) this.onended(); }
}
class FakeAudioContext {
  constructor() { this.state = 'running'; this.currentTime = 0; }
  async decodeAudioData(buf) { return { duration: 1, byteLength: buf.byteLength }; }
  createBufferSource() { return new FakeSource(); }
  createGain() { return new FakeGain(); }
  async resume() { this.state = 'running'; }
}
global.window = { AudioContext: FakeAudioContext };

const players = ['Alice', 'Bob', 'Charlie', 'Dana', 'Eli'].map(n => ({
  id: n.toLowerCase(), name: n, clips: [{ mime: 'audio/mp4', data: Buffer.from('x').toString('base64') }],
}));
const payloadJson = JSON.stringify({ team: 'Test Team', theme: 'dark', fadeOutMs: 1500, players });

const fs = require('fs');
const html = fs.readFileSync('app.template.html', 'utf8');
const scriptMatch = html.match(/<script>\n([\s\S]*)<\/script>/);
let script = scriptMatch[1].replace('__PAYLOAD_JSON__', payloadJson);

// Strip 'use strict': in strict mode, indirect eval's own let/const/function
// declarations stay confined to that eval call and never attach anywhere
// this file can reach them afterward. Doesn't affect the shipped file.
script = script.replace(/^'use strict';\n/, '');

// `state`, `order`, `pointerId`, `lastGameOrder` are let/const, so per spec
// they never become properties of the global object even via indirect eval
// (only var/function declarations do). Append accessor code *inside the
// same eval call* so it closes over those bindings directly, then stash the
// accessors on `global` (a plain property assignment, which does work).
script += `
global.__hooks = {
  getState: function() { return state; },
  getOrder: function() { return order; },
  getPointer: function() { return pointerId; },
  getLastGameOrder: function() { return lastGameOrder; },
};
`;

(0, eval)(script);
const hooks = global.__hooks;

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  await decodeAll();
  render();
  console.log('1. Boot + first render: OK');
  assert(hooks.getState().activeTab === 'grid' && hooks.getState().gridMode === 'reorder',
    'first-launch routing (no saved order -> reorder mode)');

  const screen = document.getElementById('screen');
  function findByText(text) {
    let found = null;
    const walk = (node) => {
      if (found) return;
      if (node.tagName === 'BUTTON' && node.textContent.includes(text) && !found) found = node;
      (node._children || []).forEach(walk);
    };
    walk(screen);
    return found;
  }
  function findByClassContaining(cls, text) {
    let found = null;
    const walk = (node) => {
      if (found) return;
      if (node.classList && node.classList.contains(cls) && node.textContent.includes(text)) found = node;
      (node._children || []).forEach(walk);
    };
    walk(screen);
    return found;
  }

  // Order tiles are wired with pointerdown/pointermove/pointerup (drag
  // support), not a plain click listener -- so "tap" here means a
  // pointerdown+pointerup pair with zero movement, exactly like a real tap.
  function simulateTap(el) {
    el.dispatch('pointerdown', { clientX: 0, clientY: 0, pointerId: 1 });
    el.dispatch('pointerup', { clientX: 0, clientY: 0, pointerId: 1 });
  }

  const recallBtnAtBoot = findByText('last game');
  assert(recallBtnAtBoot.disabled === true,
    'recall button must be disabled before any lineup has ever been finalized');
  console.log('1b. Recall button correctly disabled at first launch: OK');

  findByText('Alice').click();
  findByText('Bob').click();
  findByText('Charlie').click();
  assert(JSON.stringify(hooks.getOrder()) === JSON.stringify(['alice', 'bob', 'charlie']),
    'tap-in order: ' + hooks.getOrder());
  console.log('2. Tap-in bench->order path: OK, order =', hooks.getOrder());

  simulateTap(findByText('Bob')); // bench (tap-out) an in-order tile
  assert(JSON.stringify(hooks.getOrder()) === JSON.stringify(['alice', 'charlie']),
    'bench closes gap: ' + hooks.getOrder());
  console.log('3. Bench (tap-out) closes gap: OK, order =', hooks.getOrder());

  findByText('Bob').click(); // re-add from bench
  assert(JSON.stringify(hooks.getOrder()) === JSON.stringify(['alice', 'charlie', 'bob']),
    'bob re-added at end: ' + hooks.getOrder());
  console.log('4. Re-add appends at end: OK, order =', hooks.getOrder());

  findByText('Done').click();
  assert(hooks.getState().gridMode === 'play', 'Done exits to play mode');
  assert(JSON.stringify(hooks.getLastGameOrder()) === JSON.stringify(['alice', 'charlie', 'bob']),
    'lastGameOrder snapshot: ' + hooks.getLastGameOrder());
  console.log('5. Done -> play mode + snapshot: OK');

  // Regression test for the exact bug reported live: the recall button
  // must actually become enabled once a snapshot exists, not just
  // "clickable in a test that ignores disabled state." This is the check
  // that would have caught setAttribute('disabled', null) still disabling
  // the button permanently.
  document.getElementById('tabGrid').click();
  hooks.getState().gridMode = 'reorder';
  render();
  const recallBtnAfterDone = findByText('last game');
  assert(recallBtnAfterDone.disabled === false,
    'recall button must be enabled right after Done saves a snapshot');
  console.log('5b. Recall button enabled immediately after Done: OK');
  document.getElementById('tabGrid').click();
  hooks.getState().gridMode = 'play';
  render();

  document.getElementById('tabLineup').click();
  assert(hooks.getState().activeTab === 'lineup', 'tab switch to lineup');
  assert(hooks.getPointer() === 'alice', 'pointer defaults to first in order: ' + hooks.getPointer());
  console.log('6. Lineup tab shows NOW UP =', hooks.getPointer());

  findByClassContaining('nowup-card', 'ALICE').dispatch('click');
  assert(hooks.getPointer() === 'charlie', 'tapping NOW UP advances pointer: ' + hooks.getPointer());
  console.log('7. Tap NOW UP plays + advances pointer to', hooks.getPointer());

  findByText('skip ⏭').click();
  assert(hooks.getPointer() === 'bob', 'skip advances: ' + hooks.getPointer());
  findByText('⏮ back').click();
  assert(hooks.getPointer() === 'charlie', 'back returns: ' + hooks.getPointer());
  console.log('8. Skip/back nav: OK, pointer =', hooks.getPointer());

  const chip = findByClassContaining('ondeck-chip', 'Alice');
  assert(chip, 'alice on-deck chip exists');
  chip.click();
  assert(hooks.getPointer() === 'alice', 'on-deck chip jump: ' + hooks.getPointer());
  console.log('9. On-deck chip jump: OK, pointer =', hooks.getPointer());

  document.getElementById('tabGrid').click();
  hooks.getState().gridMode = 'reorder';
  render();
  findByText('Dana').click(); // benched tile tap -> late arrival added mid-game
  assert(hooks.getOrder().includes('dana'), 'late arrival added: ' + hooks.getOrder());
  assert(hooks.getPointer() === 'alice', 'pointer undisturbed by late arrival: ' + hooks.getPointer());
  console.log('10. Late arrival mid-game does not disturb pointer: OK');

  document.getElementById('stopBtn').click();
  console.log('11. Stop/fade with nothing playing: OK (no throw)');

  document.getElementById('tabGrid').click();
  hooks.getState().gridMode = 'play';
  render();
  const gridTile = findByText('Alice');
  gridTile.dispatch('click');
  console.log('12. Grid play-mode override tap: OK (no throw)');

  const guestTile = findByClassContaining('tile guest', 'Guest') || findByClassContaining('guest', 'Guest');
  assert(guestTile, 'guest tile renders');
  guestTile.click();
  console.log('13. Guest tile tap is a safe no-op: OK');

  // "Use last game's lineup" recall
  document.getElementById('tabGrid').click();
  hooks.getState().gridMode = 'reorder';
  render();
  simulateTap(findByText('Alice'));
  simulateTap(findByText('Charlie'));
  simulateTap(findByText('Bob'));
  simulateTap(findByText('Dana'));
  assert(hooks.getOrder().length === 0, 'everyone benched: ' + hooks.getOrder());
  const recallBtnNow = findByText('last game');
  assert(recallBtnNow.disabled === false,
    'recall button must still be enabled even when the live order is empty');
  recallBtnNow.click();
  assert(JSON.stringify(hooks.getOrder()) === JSON.stringify(['alice', 'charlie', 'bob']),
    'recall restores last finalized lineup: ' + hooks.getOrder());
  console.log('14. Recall last game lineup: OK, order =', hooks.getOrder());

  // localStorage persistence round-trip: keys are actually written under
  // the expected prefix and re-readable as JSON.
  const rawOrder = localStorage.getItem('kickball_v1_order');
  assert(rawOrder && JSON.parse(rawOrder).length === 3, 'order persisted to localStorage: ' + rawOrder);
  const rawLast = localStorage.getItem('kickball_v1_lastGameOrder');
  assert(rawLast && JSON.parse(rawLast).length === 3, 'lastGameOrder persisted: ' + rawLast);
  console.log('15. localStorage persistence round-trip: OK');

  console.log('\nALL DOM SMOKE TESTS PASSED');
}

main().catch(e => { console.error('SMOKE TEST FAILED:', e); process.exit(1); });
