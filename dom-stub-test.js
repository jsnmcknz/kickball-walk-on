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

// Minimal listener registries so tests can actually fire document/window-
// level events (visibilitychange, pagehide) rather than the old no-op
// stub -- needed to exercise the "backgrounding stops playback" behavior.
const docListeners = {};
const winListeners = {};
const registry = {};
global.document = {
  visibilityState: 'visible',
  createElement: (tag) => new FakeElement(tag),
  getElementById: (id) => registry[id] || (registry[id] = new FakeElement('div')),
  addEventListener: (type, fn) => { (docListeners[type] = docListeners[type] || []).push(fn); },
  dispatchTo: (type) => (docListeners[type] || []).forEach(fn => fn()),
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
global.window = {
  AudioContext: FakeAudioContext,
  addEventListener: (type, fn) => { (winListeners[type] = winListeners[type] || []).push(fn); },
  dispatchTo: (type) => (winListeners[type] || []).forEach(fn => fn()),
};

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
  getPlayingId: function() { return playingId; },
  getCurrentSource: function() { return currentSource; },
  stopCurrent: function(fade) { return stopCurrent(fade); },
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
  assert(hooks.getState().activeTab === 'lineup', 'Done lands on the Lineup tab, not Grid: ' + hooks.getState().activeTab);
  assert(JSON.stringify(hooks.getLastGameOrder()) === JSON.stringify(['alice', 'charlie', 'bob']),
    'lastGameOrder snapshot: ' + hooks.getLastGameOrder());
  console.log('5. Done -> Lineup tab + snapshot: OK');

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

  // The "x of y" breadcrumb moved from the header onto the card itself
  // (2026-07-06) -- confirm it actually renders there now, and that the
  // header's old counter slot is gone.
  const cardCounter = findByClassContaining('nowup-counter', 'of');
  assert(cardCounter, 'position counter renders on the card');
  assert(cardCounter.textContent === '1 of 3', 'position counter text: ' + cardCounter.textContent);
  assert(!document.getElementById('screen').querySelectorAll('.counter').length,
    'old header counter element is gone');
  console.log('6b. Position counter lives on the card, not the header: OK');

  // Tapping NOW UP must NOT advance the pointer/card immediately -- the
  // card should keep showing whoever's song is actually playing until that
  // clip really ends, so the on-screen name and the audio never disagree.
  findByClassContaining('nowup-card', 'ALICE').dispatch('click');
  assert(hooks.getPointer() === 'alice', 'tap must not advance immediately: ' + hooks.getPointer());
  assert(hooks.getPlayingId() === 'alice', 'alice clip is playing: ' + hooks.getPlayingId());
  console.log('7. Tap NOW UP plays but defers the advance, pointer still =', hooks.getPointer());

  // On-card countdown: the fake clip's decoded duration is always 1s and
  // the fake audio clock never advances, so the caption should read a
  // steady "0:01" while playing -- confirms the countdown is wired up and
  // reading off the (fake) audio clock rather than throwing or showing
  // stale/idle text.
  const captionWhilePlaying = findByClassContaining('nowup-caption', 'tap');
  assert(captionWhilePlaying.textContent === '0:01 — tap to stop',
    'countdown shows in the caption while playing: ' + captionWhilePlaying.textContent);
  console.log('7a. Countdown renders on the card while playing: OK');

  // While playing, the card itself is the stop control (no separate
  // Stop/fade button anymore) -- tapping it again stops the clip, and like
  // any explicit stop, that resolves the turn and advances the card.
  findByClassContaining('nowup-card', 'ALICE').dispatch('click');
  assert(hooks.getPointer() === 'charlie', 'tapping the playing card stops it and advances: ' + hooks.getPointer());
  assert(hooks.getPlayingId() === null, 'playingId clears on tap-to-stop: ' + hooks.getPlayingId());
  const captionAfterStop = findByClassContaining('nowup-caption', 'tap');
  assert(captionAfterStop.textContent === 'tap anywhere to play',
    'countdown clears and idle caption returns after stop: ' + captionAfterStop.textContent);
  console.log('7b. Tapping the card while playing stops the clip and advances: OK');

  // A clip simply allowed to finish on its own advances the same way.
  findByClassContaining('nowup-card', 'CHARLIE').dispatch('click');
  hooks.getCurrentSource().onended();
  assert(hooks.getPointer() === 'bob', 'pointer advances once the clip actually ends: ' + hooks.getPointer());
  assert(hooks.getPlayingId() === null, 'playingId clears when the clip ends: ' + hooks.getPlayingId());
  console.log('7c. Clip finishing naturally advances the pointer to', hooks.getPointer());

  findByText('skip ⏭').click();
  assert(hooks.getPointer() === 'alice', 'skip advances: ' + hooks.getPointer());
  findByText('⏮ back').click();
  assert(hooks.getPointer() === 'bob', 'back returns: ' + hooks.getPointer());
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

  // Tapping the playing card to stop it advances the card same as letting
  // it finish -- otherwise manually ending a turn early would leave the
  // card stuck showing the just-stopped kicker with no way to move on
  // except re-tapping them.
  document.getElementById('tabLineup').click();
  assert(hooks.getPointer() === 'alice', 'pointer still alice going into this check: ' + hooks.getPointer());
  findByClassContaining('nowup-card', 'ALICE').dispatch('click');
  assert(hooks.getPlayingId() === 'alice', 'alice lineup clip playing: ' + hooks.getPlayingId());
  findByClassContaining('nowup-card', 'ALICE').dispatch('click'); // tap again -> now the stop control
  assert(hooks.getPointer() === 'charlie', 'tap-to-stop on a lineup clip advances same as natural end: ' + hooks.getPointer());
  assert(hooks.getPlayingId() === null, 'playingId clears on tap-to-stop: ' + hooks.getPlayingId());
  console.log('10b. Tap-to-stop on a lineup clip advances the pointer: OK');

  // A manual skip/back/on-deck-jump while a clip is still playing already
  // resolves that turn -- the deferred auto-advance must not pile a second
  // advance on top when the stale clip finally ends.
  findByClassContaining('nowup-card', 'CHARLIE').dispatch('click');
  assert(hooks.getPlayingId() === 'charlie', 'charlie lineup clip playing: ' + hooks.getPlayingId());
  findByText('skip ⏭').click();
  assert(hooks.getPointer() === 'bob', 'manual skip moves pointer during playback: ' + hooks.getPointer());
  hooks.getCurrentSource().onended();
  assert(hooks.getPointer() === 'bob', 'stale clip ending after a manual skip must not double-advance: ' + hooks.getPointer());
  assert(hooks.getPlayingId() === null, 'playingId clears when the stale clip ends: ' + hooks.getPlayingId());
  console.log('10c. Manual skip during playback is not double-counted by the deferred auto-advance: OK');

  hooks.stopCurrent(true);
  console.log('11. Calling stopCurrent with nothing playing: OK (no throw)');

  document.getElementById('tabGrid').click();
  hooks.getState().gridMode = 'play';
  render();
  findByText('Alice').dispatch('click'); // override play
  assert(hooks.getPlayingId() === 'alice', 'grid override tap plays: ' + hooks.getPlayingId());
  findByText('Alice').dispatch('click'); // tap the now-playing tile again -- it's the stop control now
  assert(hooks.getPlayingId() === null, 'tapping a playing grid tile stops it: ' + hooks.getPlayingId());
  console.log('12. Grid play-mode override tap + tap-to-stop: OK');

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

  // Reorder-mode tiles don't play or stop anything, but a clip already
  // playing when you enter reorder mode (e.g. previewed in Grid play mode)
  // must keep playing -- explicitly requested: clips are short (<15s) and
  // stopping them isn't worth the friction. Verify entering reorder mode
  // does NOT touch playback.
  document.getElementById('tabGrid').click();
  hooks.getState().gridMode = 'play';
  render();
  const anyGridTile = findByText('Alice') || findByText('Charlie') || findByText('Bob');
  anyGridTile.dispatch('click'); // start something playing via Grid override
  const playingBefore = hooks.getPlayingId();
  assert(playingBefore !== null, 'sanity: something is playing before entering reorder');
  findByText('order').click(); // the order-btn text is "⇅ order"
  assert(hooks.getState().gridMode === 'reorder', 'entered reorder mode');
  assert(hooks.getPlayingId() === playingBefore,
    'entering reorder mode must NOT stop a clip already playing');
  console.log('16. Entering reorder mode leaves an in-progress clip playing: OK');

  // iOS forcibly interrupts audio when the app is backgrounded -- a real
  // platform limitation, not something to work around. Simulate that by
  // firing visibilitychange with the page hidden, and confirm we treat it
  // as an explicit stop: playback clears, and since this was the lineup
  // clip, the card advances just like tapping to stop or letting it finish.
  document.getElementById('tabLineup').click();
  const pointerBeforeBg = hooks.getPointer();
  findByClassContaining('nowup-card', '').dispatch('click'); // start the lineup clip
  assert(hooks.getPlayingId() === pointerBeforeBg, 'lineup clip playing before backgrounding: ' + hooks.getPlayingId());
  document.visibilityState = 'hidden';
  document.dispatchTo('visibilitychange');
  const orderNow = hooks.getOrder();
  const expectedNext = orderNow[(orderNow.indexOf(pointerBeforeBg) + 1) % orderNow.length];
  assert(hooks.getPlayingId() === null, 'backgrounding stops playback: ' + hooks.getPlayingId());
  assert(hooks.getPointer() === expectedNext, 'backgrounding advances the card like any other stop: ' + hooks.getPointer());
  document.visibilityState = 'visible';
  console.log('17. Backgrounding the app stops playback and advances the card: OK');

  // pagehide is a defensive backstop for actual navigation/close -- must
  // never throw, even with nothing playing.
  window.dispatchTo('pagehide');
  console.log('18. pagehide with nothing playing: OK (no throw)');

  console.log('\nALL DOM SMOKE TESTS PASSED');
}

main().catch(e => { console.error('SMOKE TEST FAILED:', e); process.exit(1); });
