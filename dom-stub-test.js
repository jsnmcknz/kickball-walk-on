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
  removeChild(child) {
    const i = this._children.indexOf(child);
    if (i !== -1) { this._children.splice(i, 1); child.parentElement = null; }
    return child;
  }
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
  removeEventListener: (type, fn) => {
    const arr = docListeners[type] || [];
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
  },
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
  async close() { this.state = 'closed'; }
}
global.window = {
  AudioContext: FakeAudioContext,
  addEventListener: (type, fn) => { (winListeners[type] = winListeners[type] || []).push(fn); },
  dispatchTo: (type) => (winListeners[type] || []).forEach(fn => fn()),
  // Reassignable per-test so debugClearGameData's confirm-gate can be
  // exercised both ways; defaults to accept so no other test that happens
  // to touch a confirm-gated path is silently blocked.
  confirm: () => true,
};

const players = ['Alice', 'Bob', 'Charlie', 'Dana', 'Eli'].map(n => ({
  id: n.toLowerCase(), name: n, status: 'member',
  clips: [{ mime: 'audio/mp4', data: Buffer.from('x').toString('base64') }],
}));
const payloadJson = JSON.stringify({
  team: 'Test Team', theme: 'dark', fadeOutMs: 1500, autoPlayDelayMs: 2000,
  players, teamSounds: [], defaultClips: [],
  scoring: { enabled: false, supabaseUrl: '', supabaseAnonKey: '', teamPin: '0000', inningsPerGame: 7 },
});

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
  // The double-tap guard ignores taps-to-stop within STOP_TAP_GRACE_MS of
  // play start. Tests run play + stop in the same millisecond, so any test
  // that intends a *deliberate* stop-tap must first backdate the play
  // timestamp past the grace window -- which also keeps the guard itself
  // honest (an untimely stop-tap with no backdate must be a no-op).
  backdatePlayStart: function(ms) { playStartedAtMs -= ms; },
  // Audio-lifecycle internals (interrupted-state rebuild, watchdog).
  getCtx: function() { return ctx; },
  getAudioRebuilds: function() { return audioRebuilds; },
  // Scoring engine (S1.2) -- pure functions, exposed directly since they
  // take no closure state of their own beyond what's passed in.
  deriveState: function(events) { return deriveState(events); },
  computeStats: function(st) { return computeStats(st); },
  legalSetTargets: function(runners, id) { return legalSetTargets(runners, id); },
  applyRunnerPush: function(runners, fromBase, delta) { return applyRunnerPush(runners, fromBase, delta); },
  appendScoringEvent: function(events, type, payload) { return appendScoringEvent(events, type, payload); },
  // S1.5: correction-state UI orchestration -- flips scoring on for a test
  // (DATA is a const *binding*, but its properties are plain mutable
  // object fields), lets a test seed the event log directly, then drives
  // the real open*/apply* functions the diamond/chip buttons call.
  enableScoringForTest: function() { DATA.scoring.enabled = true; },
  setScoringEvents: function(ev) { scoringEvents = ev; saveScoringEvents(ev); scoringState = deriveState(ev); },
  getScoringState: function() { return scoringState; },
  getScoringEvents: function() { return scoringEvents; },
  getScoringCorrection: function() { return scoringCorrection; },
  openRunnerCorrection: function(id) { return openRunnerCorrection(id); },
  applyRunnerOut: function(id) { return applyRunnerOut(id); },
  applyRunnerSet: function(id, to) { return applyRunnerSet(id, to); },
  openLastActionCorrection: function() { return openLastActionCorrection(); },
  applyFixLastAmend: function(r) { return applyFixLastAmend(r); },
  applyFixLastUndo: function() { return applyFixLastUndo(); },
  applyFixLastHitStands: function() { return applyFixLastHitStands(); },
  applyUndoLast: function() { return applyUndoLast(); },
  closeScoringCorrection: function() { return closeScoringCorrection(); },
  // 2026-07-08 session: chain-forward sets, scored-runner corrections,
  // runner codes, autoplay-cancel-on-hide.
  applyChainForwardSet: function(runners, id, to) { return applyChainForwardSet(runners, id, to); },
  legalReturnTargets: function(runners) { return legalReturnTargets(runners); },
  openScoredCorrection: function() { return openScoredCorrection(); },
  applyScoredRunnerReturn: function(id, to) { return applyScoredRunnerReturn(id, to); },
  applyScoredRunnerOut: function(id) { return applyScoredRunnerOut(id); },
  runnerCode: function(id) { return runnerCode(id); },
  playerNameOf: function(id) { return playerNameOf(id); },
  scheduleScoringAutoPlay: function() { return scheduleScoringAutoPlay(); },
  getScoringAutoPlayPending: function() { return scoringAutoPlayPending; },
  // S1.6: tap-to-draft lineup editor, Start/End game, PIN gate, adjust steppers.
  getScoringLineupEditor: function() { return scoringLineupEditor; },
  setScoringLineupEditor: function(v) { scoringLineupEditor = v; },
  openStartGameFlow: function() { return openStartGameFlow(); },
  openMidGameLineupEditor: function() { return openMidGameLineupEditor(); },
  cancelScoringLineupEditor: function() { return cancelScoringLineupEditor(); },
  draftAppend: function(id) { return draftAppend(id); },
  draftRemove: function(id) { return draftRemove(id); },
  commitStartGame: function() { return commitStartGame(); },
  commitLineupEdit: function() { return commitLineupEdit(); },
  openEndGameConfirm: function() { return openEndGameConfirm(); },
  closeEndGameConfirm: function() { return closeEndGameConfirm(); },
  commitEndGame: function() { return commitEndGame(); },
  getEndGameConfirmOpen: function() { return endGameConfirmOpen; },
  openAddPlayerSheet: function() { return openAddPlayerSheet(); },
  closeAddPlayerSheet: function() { return closeAddPlayerSheet(); },
  commitAddPlayer: function() { return commitAddPlayer(); },
  getAddPlayerSheet: function() { return addPlayerSheet; },
  openPinSheet: function(cb) { return openPinSheet(cb); },
  closePinSheet: function() { return closePinSheet(); },
  pinKeyTap: function(k) { return pinKeyTap(k); },
  getPinSheet: function() { return pinSheet; },
  getPinUnlocked: function() { return pinUnlocked; },
  setPinUnlockedForTest: function(v) { pinUnlocked = v; },
  openAdjustSheet: function() { return openAdjustSheet(); },
  adjustStep: function(field, delta) { return adjustStep(field, delta); },
  commitAdjust: function() { return commitAdjust(); },
  pickDefaultScheduleGameId: function() { return pickDefaultScheduleGameId(); },
  scheduleFixtureById: function(id) { return scheduleFixtureById(id); },
  overlayBufferFor: function(id) { return overlayBufferFor(id); },
  getDefaultClipBuffers: function() { return defaultClipBuffers; },
  decodeAll: function() { return decodeAll(); },
  getDATA: function() { return DATA; },
  debugClearGameData: function() { return debugClearGameData(); },
  scorecardColumns: function() { return scorecardColumns(); },
  scorecardLayout: function() { return scorecardLayout(); },
};
`;

(0, eval)(script);
const hooks = global.__hooks;

function assert(cond, msg) { if (!cond) throw new Error('ASSERTION FAILED: ' + msg); }

async function main() {
  await decodeAll();
  render();
  console.log('1. Boot + first render: OK');
  assert(hooks.getState().activeTab === 'lineup' && hooks.getState().editing === true,
    'first-launch routing (no saved order -> Next Up opens in the order editor)');

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
  assert(hooks.getState().editing === false, 'Done exits the editor');
  assert(hooks.getState().activeTab === 'lineup', 'Done lands on the Lineup tab, not Grid: ' + hooks.getState().activeTab);
  assert(JSON.stringify(hooks.getLastGameOrder()) === JSON.stringify(['alice', 'charlie', 'bob']),
    'lastGameOrder snapshot: ' + hooks.getLastGameOrder());
  console.log('5. Done -> Lineup tab + snapshot: OK');

  // Regression test for the exact bug reported live: the recall button
  // must actually become enabled once a snapshot exists, not just
  // "clickable in a test that ignores disabled state." This is the check
  // that would have caught setAttribute('disabled', null) still disabling
  // the button permanently.
  findByText('order').click(); // the editor is entered from the Next Up screen now
  const recallBtnAfterDone = findByText('last game');
  assert(recallBtnAfterDone.disabled === false,
    'recall button must be enabled right after Done saves a snapshot');
  console.log('5b. Recall button enabled immediately after Done: OK');
  hooks.getState().editing = false;
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
  assert(captionWhilePlaying.textContent === '0:01 — tap to fade out',
    'countdown shows in the caption while playing: ' + captionWhilePlaying.textContent);
  console.log('7a. Countdown renders on the card while playing: OK');

  // Double-tap guard: a second tap landing within the grace window (an
  // excited operator's double-tap) must NOT stop the clip or advance the
  // pointer -- otherwise a double-tap plays a quarter-second of song and
  // skips the kicker.
  findByClassContaining('nowup-card', 'ALICE').dispatch('click');
  assert(hooks.getPlayingId() === 'alice', 'still playing after an immediate second tap: ' + hooks.getPlayingId());
  assert(hooks.getPointer() === 'alice', 'pointer unmoved by an immediate second tap: ' + hooks.getPointer());
  console.log('7a2. Double-tap within the grace window is ignored: OK');

  // While playing, the card itself is the stop control (no separate
  // Stop/fade button anymore) -- tapping it again (past the grace window)
  // stops the clip, and like any explicit stop, that resolves the turn and
  // advances the card.
  hooks.backdatePlayStart(1000);
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

  findByText('next ⏭').click();
  assert(hooks.getPointer() === 'alice', 'next advances: ' + hooks.getPointer());
  findByText('⏮ back').click();
  assert(hooks.getPointer() === 'bob', 'back returns: ' + hooks.getPointer());
  console.log('8. Skip/back nav: OK, pointer =', hooks.getPointer());

  const chip = findByClassContaining('ondeck-chip', 'Alice');
  assert(chip, 'alice on-deck chip exists');
  chip.click();
  assert(hooks.getPointer() === 'alice', 'on-deck chip jump: ' + hooks.getPointer());
  console.log('9. On-deck chip jump: OK, pointer =', hooks.getPointer());

  hooks.getState().activeTab = 'lineup';
  hooks.getState().editing = true;
  render();
  findByText('Dana').click(); // benched tile tap -> late arrival added mid-game
  assert(hooks.getOrder().includes('dana'), 'late arrival added: ' + hooks.getOrder());
  assert(hooks.getPointer() === 'alice', 'pointer undisturbed by late arrival: ' + hooks.getPointer());
  console.log('10. Late arrival mid-game does not disturb pointer: OK');

  // Tapping the playing card to stop it advances the card same as letting
  // it finish -- otherwise manually ending a turn early would leave the
  // card stuck showing the just-stopped kicker with no way to move on
  // except re-tapping them.
  hooks.getState().editing = false;
  document.getElementById('tabLineup').click();
  assert(hooks.getPointer() === 'alice', 'pointer still alice going into this check: ' + hooks.getPointer());
  findByClassContaining('nowup-card', 'ALICE').dispatch('click');
  assert(hooks.getPlayingId() === 'alice', 'alice lineup clip playing: ' + hooks.getPlayingId());
  hooks.backdatePlayStart(1000); // past the double-tap grace window
  findByClassContaining('nowup-card', 'ALICE').dispatch('click'); // tap again -> now the stop control
  assert(hooks.getPointer() === 'charlie', 'tap-to-stop on a lineup clip advances same as natural end: ' + hooks.getPointer());
  assert(hooks.getPlayingId() === null, 'playingId clears on tap-to-stop: ' + hooks.getPlayingId());
  console.log('10b. Tap-to-stop on a lineup clip advances the pointer: OK');

  // A manual skip/back/on-deck-jump while a clip is still playing already
  // resolves that turn -- the deferred auto-advance must not pile a second
  // advance on top when the stale clip finally ends.
  findByClassContaining('nowup-card', 'CHARLIE').dispatch('click');
  assert(hooks.getPlayingId() === 'charlie', 'charlie lineup clip playing: ' + hooks.getPlayingId());
  findByText('next ⏭').click();
  assert(hooks.getPointer() === 'bob', 'manual next moves pointer during playback: ' + hooks.getPointer());
  hooks.getCurrentSource().onended();
  assert(hooks.getPointer() === 'bob', 'stale clip ending after a manual skip must not double-advance: ' + hooks.getPointer());
  assert(hooks.getPlayingId() === null, 'playingId clears when the stale clip ends: ' + hooks.getPlayingId());
  console.log('10c. Manual skip during playback is not double-counted by the deferred auto-advance: OK');

  hooks.stopCurrent(true);
  console.log('11. Calling stopCurrent with nothing playing: OK (no throw)');

  document.getElementById('tabGrid').click(); // Soundboard: modeless, always the play grid
  findByText('Alice').dispatch('click'); // override play
  assert(hooks.getPlayingId() === 'alice', 'grid override tap plays: ' + hooks.getPlayingId());
  // The playing tile carries its own countdown line (fake clock: steady 0:01),
  // same text-node tick pattern as the card caption.
  const tileCountdown = findByClassContaining('tile-countdown', '0:01');
  assert(tileCountdown, 'playing grid tile shows a countdown');
  findByText('Alice').dispatch('click'); // immediate retap -> inside grace window, must be ignored
  assert(hooks.getPlayingId() === 'alice', 'grid tile double-tap guard holds: ' + hooks.getPlayingId());
  hooks.backdatePlayStart(1000);
  findByText('Alice').dispatch('click'); // tap the now-playing tile again -- it's the stop control now
  assert(hooks.getPlayingId() === null, 'tapping a playing grid tile stops it: ' + hooks.getPlayingId());
  console.log('12. Grid play-mode override tap + double-tap guard + tap-to-stop: OK');

  const guestTile = findByClassContaining('tile guest', 'Guest') || findByClassContaining('guest', 'Guest');
  assert(guestTile, 'guest tile renders');
  guestTile.click();
  console.log('13. Guest tile tap is a safe no-op: OK');

  // "Use last game's lineup" recall
  hooks.getState().activeTab = 'lineup';
  hooks.getState().editing = true;
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
  hooks.getState().editing = false;
  document.getElementById('tabGrid').click();
  const anyGridTile = findByText('Alice') || findByText('Charlie') || findByText('Bob');
  anyGridTile.dispatch('click'); // start something playing via Grid override
  const playingBefore = hooks.getPlayingId();
  assert(playingBefore !== null, 'sanity: something is playing before entering reorder');
  document.getElementById('tabLineup').click(); // the order button lives on Next Up only now
  findByText('order').click(); // the order-btn text is "⇅ order"
  assert(hooks.getState().editing === true, 'entered the editor');
  assert(hooks.getPlayingId() === playingBefore,
    'entering reorder mode must NOT stop a clip already playing');
  console.log('16. Entering reorder mode leaves an in-progress clip playing: OK');

  // iOS forcibly interrupts audio when the app is backgrounded -- a real
  // platform limitation, not something to work around. Simulate that by
  // firing visibilitychange with the page hidden, and confirm we treat it
  // as an explicit stop: playback clears, and since this was the lineup
  // clip, the card advances just like tapping to stop or letting it finish.
  hooks.getState().editing = false;
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

  // Firm principle 5, restated for the 2026-07-07 routing: the Soundboard is
  // MODELESS -- it must show the play grid with a full, partial, or empty
  // order, even while an edit is in progress on the Next Up tab. And
  // returning to Next Up must resume that in-progress edit.
  hooks.getState().activeTab = 'lineup';
  hooks.getState().editing = true;
  render();
  simulateTap(findByText('Alice'));
  simulateTap(findByText('Charlie'));
  simulateTap(findByText('Bob'));
  simulateTap(findByText('Dana'));
  assert(hooks.getOrder().length === 0, 'everyone benched again: ' + hooks.getOrder());
  document.getElementById('tabGrid').click(); // straight out of the editor
  assert(hooks.getState().activeTab === 'grid', 'Soundboard tab reachable mid-edit');
  assert(findByText('Alice'), 'play grid renders (and is playable) with an empty order');
  document.getElementById('tabLineup').click();
  assert(hooks.getState().editing === true, 'returning to Next Up resumes the in-progress edit');
  console.log('19. Soundboard is modeless and never blocks; Next Up resumes the edit: OK');
  // ...and no drag debris (ghosts/placeholders) survives a render pass.
  const appDebris = document.getElementById('app').querySelectorAll('.drag-ghost').length
    + document.getElementById('app').querySelectorAll('.drag-placeholder').length;
  assert(appDebris === 0, 'render sweep leaves no drag debris: ' + appDebris);
  console.log('20. Drag-debris sweep in render(): OK');

  // Clear button: one tap benches everyone; disabled once the order is
  // already empty; "last game" recall still restores the finalized lineup.
  hooks.getState().activeTab = 'lineup';
  hooks.getState().editing = true;
  render();
  findByText('last game').click(); // restore a lineup to clear
  assert(hooks.getOrder().length === 3, 'recall before clear: ' + hooks.getOrder());
  const clearBtn = findByText('clear');
  assert(clearBtn && clearBtn.disabled === false, 'clear enabled while order is non-empty');
  clearBtn.click();
  assert(hooks.getOrder().length === 0, 'clear empties the order: ' + hooks.getOrder());
  assert(hooks.getPointer() === null, 'pointer resets with the cleared order: ' + hooks.getPointer());
  assert(findByText('clear').disabled === true, 'clear disabled once order is empty');
  findByText('last game').click();
  assert(hooks.getOrder().length === 3, 'recall still restores after a clear: ' + hooks.getOrder());
  console.log('21. Clear button empties the order (recall remains the undo): OK');

  // iOS wedge regression (game 1, 2026-07-06): after a screen lock the
  // context sits in the nonstandard 'interrupted' state -- not 'suspended'
  // -- and resume() can no-op forever (WebAudio/web-audio-api#2585). A play
  // tap on any not-running context must synchronously REPLACE the context
  // (reusing decoded buffers) and play: one tap, no reboot. This test would
  // have caught game 1's dead-after-sleep bug.
  hooks.getState().editing = false;
  document.getElementById('tabLineup').click();
  const wedgedCtx = hooks.getCtx();
  wedgedCtx.state = 'interrupted';
  const rebuildsBefore = hooks.getAudioRebuilds();
  findByClassContaining('nowup-card', '').dispatch('click');
  assert(hooks.getCtx() !== wedgedCtx, 'wedged context replaced, not trusted to resume');
  assert(hooks.getCtx().state === 'running', 'replacement context running');
  assert(hooks.getAudioRebuilds() === rebuildsBefore + 1, 'rebuild counted: ' + hooks.getAudioRebuilds());
  assert(wedgedCtx.state === 'closed', 'old context closed (context-cap hygiene)');
  assert(hooks.getPlayingId() !== null, 'clip playing after ONE tap on a wedged context');
  hooks.backdatePlayStart(500);
  findByClassContaining('nowup-card', '').dispatch('click'); // tap-to-stop, clean up
  assert(hooks.getPlayingId() === null, 'stopped clean after rebuild-play');
  console.log('22. Interrupted-context tap rebuilds and plays in one tap: OK');

  // Watchdog: context wedges (or never unlocked) AFTER a play started --
  // tap-time check missed it. Within AUDIO_WATCHDOG_MS the app must
  // rebuild once and replay the same clip automatically, and must NOT
  // retry-loop beyond that single replay.
  document.getElementById('tabGrid').click();
  findByText('Eli').dispatch('click'); // grid override play
  assert(hooks.getPlayingId() === 'eli', 'override playing: ' + hooks.getPlayingId());
  const ctxAtPlay = hooks.getCtx();
  ctxAtPlay.state = 'interrupted';
  const rebuildsBeforeWd = hooks.getAudioRebuilds();
  await new Promise(r => setTimeout(r, 700));
  assert(hooks.getAudioRebuilds() === rebuildsBeforeWd + 1, 'watchdog rebuilt exactly once: ' + hooks.getAudioRebuilds());
  assert(hooks.getCtx() !== ctxAtPlay, 'fresh context after watchdog');
  assert(hooks.getPlayingId() === 'eli', 'same clip replayed automatically: ' + hooks.getPlayingId());
  await new Promise(r => setTimeout(r, 700)); // retry watchdog window passes quietly
  assert(hooks.getAudioRebuilds() === rebuildsBeforeWd + 1, 'no watchdog retry-loop');
  hooks.backdatePlayStart(1500);
  findByText('Eli').dispatch('click'); // tap-to-stop
  assert(hooks.getPlayingId() === null, 'stopped clean after watchdog replay');
  console.log('23. Watchdog rebuilds + replays once, never loops: OK');

  // Field debug readout: 5 quick wordmark taps toggle the overlay on,
  // 5 more toggle it off (also clearing its refresh interval -- this test
  // hanging the process would itself be the regression signal).
  const wordmark = findByClassContaining('wordmark', 'Test Team');
  assert(wordmark, 'wordmark rendered in grid header');
  for (let i = 0; i < 5; i++) wordmark.dispatch('click');
  assert(document.getElementById('app').querySelectorAll('.debug-panel').length === 1,
    'debug panel appears after 5 wordmark taps');
  for (let i = 0; i < 5; i++) wordmark.dispatch('click');
  assert(document.getElementById('app').querySelectorAll('.debug-panel').length === 0,
    'debug panel removed after 5 more taps');
  console.log('24. Hidden debug readout toggles via 5 wordmark taps: OK');

  // ============================================================
  // Scoring engine (S1.2): deriveState() replay against the committed
  // fixture (mockups/sample-game-events.json). This is the load-bearing
  // correctness test for the whole assumption engine -- checkpoints and
  // expectedStats are normative per the S1 kickoff doc, not just a smoke
  // test. wired in early, per the kickoff prompt, before any scoring UI.
  // ============================================================
  const fixture = JSON.parse(fs.readFileSync('mockups/sample-game-events.json', 'utf8'));
  const fixtureEvents = fixture.events;

  fixture.checkpoints.forEach((cp, i) => {
    const slice = fixtureEvents.filter(e => e.seq <= cp.afterSeq);
    const st = hooks.deriveState(slice);
    const nowUp = st.lineup[st.lineupPointer];
    const label = `25.${i + 1}. Fixture checkpoint afterSeq=${cp.afterSeq}`;
    assert(st.inning === cp.expect.inning, `${label}: inning ${st.inning} !== ${cp.expect.inning}`);
    assert(st.half === cp.expect.half, `${label}: half ${st.half} !== ${cp.expect.half}`);
    assert(st.outs === cp.expect.outs, `${label}: outs ${st.outs} !== ${cp.expect.outs}`);
    assert(st.scoreUs === cp.expect.scoreUs, `${label}: scoreUs ${st.scoreUs} !== ${cp.expect.scoreUs}`);
    assert(st.scoreThem === cp.expect.scoreThem, `${label}: scoreThem ${st.scoreThem} !== ${cp.expect.scoreThem}`);
    assert(JSON.stringify(st.runners) === JSON.stringify(cp.expect.runners),
      `${label}: runners ${JSON.stringify(st.runners)} !== ${JSON.stringify(cp.expect.runners)}`);
    assert(nowUp === cp.expect.nowUp, `${label}: nowUp ${nowUp} !== ${cp.expect.nowUp}`);
    console.log(`${label}: OK`);
  });

  const finalState = hooks.deriveState(fixtureEvents);
  const stats = hooks.computeStats(finalState);
  Object.keys(fixture.expectedStats).filter(k => k !== '_comment').forEach(playerId => {
    const expected = fixture.expectedStats[playerId];
    const got = stats[playerId] || { pa: 0, ab: 0, h: 0, r: 0, rbi: 0 };
    ['pa', 'ab', 'h', 'r', 'rbi'].forEach(field => {
      assert(got[field] === expected[field],
        `25.stats ${playerId}.${field}: ${got[field]} !== ${expected[field]}`);
    });
  });
  console.log('25.stats. Fixture expectedStats match for all 9 players: OK');

  // ============================================================
  // Scoring engine edge cases not covered by the fixture (undo, amend,
  // legal-move helpers) -- hand-built since the fixture is a clean single
  // game with no corrections beyond the one runner-out.
  // ============================================================
  // 26. undo tombstones an event; replay proceeds as if it never happened.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    const koEvent = ev[ev.length - 1];
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: 'K', inning: 1, half: 'us' });
    let st = hooks.deriveState(ev);
    assert(st.outs === 1, 'sanity before undo: outs=1, got ' + st.outs);
    ev = hooks.appendScoringEvent(ev, 'undo', { target_event_id: ev[2].id }); // undo bob's K
    st = hooks.deriveState(ev);
    assert(st.outs === 0, 'undo tombstones the K: outs should revert to 0, got ' + st.outs);
    assert(st.lineupPointer === 1, 'pointer also reverts (bob\'s PA fully undone): got ' + st.lineupPointer);
    console.log('26. undo tombstones an event and replay skips it: OK');
  }

  // 27. amend changes a PA's result; downstream state re-derives.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    const aliceEventId = ev[1].id;
    let st = hooks.deriveState(ev);
    assert(st.runners.alice === 1, 'sanity before amend: alice on 1st');
    ev = hooks.appendScoringEvent(ev, 'amend', { target_event_id: aliceEventId, result: 'K' }); // "actually she was out"
    st = hooks.deriveState(ev);
    assert(st.runners.alice === undefined, 'amended to K: alice should not be on base');
    assert(st.outs === 1, 'amended to K: an out should be recorded, got ' + st.outs);
    const stats = hooks.computeStats(st);
    assert(stats.alice.h === 0, 'amended PA is no longer a hit: h=' + stats.alice.h);
    console.log('27. amend re-derives a past PA\'s downstream effects: OK');
  }

  // 28. HR scores everyone incl. batter; RBI credited to the HR's own PA.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: 'HR', inning: 1, half: 'us' });
    const st = hooks.deriveState(ev);
    assert(st.scoreUs === 2, 'HR scores alice + bob: scoreUs=' + st.scoreUs);
    assert(Object.keys(st.runners).length === 0, 'bases empty after HR');
    const stats = hooks.computeStats(st);
    assert(stats.bob.rbi === 2, 'HR credits 2 RBI to the batter: got ' + stats.bob.rbi);
    console.log('28. HR scores the batter plus all runners, RBI credited correctly: OK');
  }

  // 29. runner_out_hit_stands (rundown case): hit stays in stats, out recorded.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'runner_out_hit_stands', { playerId: 'alice' });
    const st = hooks.deriveState(ev);
    assert(st.outs === 1, 'rundown out recorded: outs=' + st.outs);
    assert(st.runners.alice === undefined, 'alice removed from the bases');
    const stats = hooks.computeStats(st);
    assert(stats.alice.h === 1, 'the original 1B still counts as a hit: h=' + stats.alice.h);
    console.log('29. runner_out_hit_stands keeps the hit, records the out: OK');
  }

  // 30. legalSetTargets / applyRunnerPush sanity (S1.5 round 7: absolute-
  // target model replacing legalAdvanceBases/previewRunnerAdvance).
  {
    const runners = { alice: 1, bob: 2 };
    assert(JSON.stringify(hooks.legalSetTargets(runners, 'alice')) === JSON.stringify([2, 3, 4]),
      'legal targets from 1st: forward only (2nd/3rd/home) -- nothing behind 1st: ' + JSON.stringify(hooks.legalSetTargets(runners, 'alice')));
    assert(JSON.stringify(hooks.legalSetTargets(runners, 'bob')) === JSON.stringify([3, 4]),
      'legal targets from 2nd: forward (3rd/home); backward (1st) excluded -- occupied by alice: ' + JSON.stringify(hooks.legalSetTargets(runners, 'bob')));
    assert(JSON.stringify(hooks.legalSetTargets(runners, 'nobody')) === JSON.stringify([]),
      'no legal targets for a player not on base');

    const gapRunners = { alice: 1, charlie: 3 }; // 2nd open
    assert(JSON.stringify(hooks.legalSetTargets(gapRunners, 'charlie')) === JSON.stringify([2, 4]),
      'backward target reaches the open base ahead of the trailing runner; forward always includes home: '
      + JSON.stringify(hooks.legalSetTargets(gapRunners, 'charlie')));
    // Round 2 (Jason, 2026-07-08): backward moves may never PASS a
    // trailing runner -- an occupied base ends the backward list, it is
    // not skipped over.
    const passRunners = { alice: 2, charlie: 3 };
    assert(JSON.stringify(hooks.legalSetTargets(passRunners, 'charlie')) === JSON.stringify([4]),
      'backward list stops at the first occupied base (no passing a trailing runner): '
      + JSON.stringify(hooks.legalSetTargets(passRunners, 'charlie')));

    const pushed = hooks.applyRunnerPush(runners, 1, 1); // everyone at base>=1 advances by 1 -- forward sets still reuse this
    assert(pushed.runners.alice === 2 && pushed.runners.bob === 3, 'uniform push: ' + JSON.stringify(pushed.runners));
    assert(pushed.scored.length === 0, 'nobody scores on a +1 push from 1st/2nd');
    console.log('30. legalSetTargets / applyRunnerPush: OK');
  }

  // 31. Force-chain-only 1B (Jason, live feedback): a runner on 3rd with
  // 1st/2nd empty is NOT pushed on a single -- they hold, since nothing
  // forces them off 3rd. A runner on 1st IS always forced (batter takes
  // 1st); that in turn forces 2nd only if it was occupied, etc.
  {
    // 3rd only, 1st/2nd empty -> holds.
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '3B', inning: 1, half: 'us' }); // alice on 3rd, nobody else
    let st = hooks.deriveState(ev);
    assert(st.runners.alice === 3, 'sanity: alice on 3rd, got ' + JSON.stringify(st.runners));
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' });
    st = hooks.deriveState(ev);
    assert(st.runners.alice === 3, 'alice on 3rd must HOLD (not forced) on a 1B with 1st/2nd empty: ' + JSON.stringify(st.runners));
    assert(st.runners.bob === 1, 'bob (batter) reaches 1st: ' + JSON.stringify(st.runners));
    assert(st.scoreUs === 0, 'nobody scores: alice never left 3rd, got scoreUs=' + st.scoreUs);

    // Full force chain: 1st+2nd+3rd occupied -> everyone forced up exactly one base.
    let ev2 = [];
    ev2 = hooks.appendScoringEvent(ev2, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie', 'dana'] });
    ev2 = hooks.appendScoringEvent(ev2, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });   // alice: 1st
    ev2 = hooks.appendScoringEvent(ev2, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' });     // forces alice 1st->2nd; bob: 1st
    ev2 = hooks.appendScoringEvent(ev2, 'pa', { playerId: 'charlie', result: '1B', inning: 1, half: 'us' }); // forces alice 2nd->3rd, bob 1st->2nd; charlie: 1st
    let st2 = hooks.deriveState(ev2);
    assert(st2.runners.alice === 3 && st2.runners.bob === 2 && st2.runners.charlie === 1,
      'full 1B force chain: ' + JSON.stringify(st2.runners));
    ev2 = hooks.appendScoringEvent(ev2, 'pa', { playerId: 'dana', result: '1B', inning: 1, half: 'us' }); // bases loaded -> forces everyone, alice scores
    st2 = hooks.deriveState(ev2);
    assert(st2.runners.alice === undefined, 'bases-loaded 1B forces alice home: ' + JSON.stringify(st2.runners));
    assert(st2.runners.bob === 3 && st2.runners.charlie === 2 && st2.runners.dana === 1,
      'bases-loaded 1B force chain: ' + JSON.stringify(st2.runners));
    assert(st2.scoreUs === 1, 'exactly one run forced in: scoreUs=' + st2.scoreUs);

    // Gap in the middle: 1st + 3rd occupied, 2nd empty -> 1st-runner forced
    // only to 2nd (the open base); 3rd-runner NOT forced (no one behind them).
    let ev3 = [];
    ev3 = hooks.appendScoringEvent(ev3, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev3 = hooks.appendScoringEvent(ev3, 'pa', { playerId: 'alice', result: '3B', inning: 1, half: 'us' }); // alice: 3rd
    ev3 = hooks.appendScoringEvent(ev3, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' });   // bob: 1st (2nd still empty)
    let st3 = hooks.deriveState(ev3);
    assert(st3.runners.alice === 3 && st3.runners.bob === 1, 'sanity, gap case setup: ' + JSON.stringify(st3.runners));
    ev3 = hooks.appendScoringEvent(ev3, 'pa', { playerId: 'charlie', result: '1B', inning: 1, half: 'us' }); // forces bob 1st->2nd only; alice on 3rd untouched
    st3 = hooks.deriveState(ev3);
    assert(st3.runners.alice === 3, 'alice on 3rd still holds -- the gap at 2nd breaks the chain: ' + JSON.stringify(st3.runners));
    assert(st3.runners.bob === 2, 'bob forced 1st->2nd: ' + JSON.stringify(st3.runners));
    assert(st3.runners.charlie === 1, 'charlie (batter) at 1st: ' + JSON.stringify(st3.runners));
    console.log('31. Force-chain-only 1B: holds/forces/gap-breaks-chain all correct: OK');
  }

  // 32. adjust/outs=3 carries the same half-flip consequence as reaching 3
  // outs any other way -- this is what the defense screen's mercy-rule
  // "End half-inning now" button relies on (Jason, live feedback).
  {
    // adjust/outs=3 during a live 'us' half flips us->them, exactly like a
    // real 3rd out -- this is the direction the mercy-button path uses,
    // since the mercy limit applies to THEIR half (defense), meaning the
    // app is sitting in 'us' (offense) when a mercy scenario would apply
    // to the PREVIOUS half... actually the mercy check itself lives on the
    // defense screen (half === 'them'), so the real path is covered below;
    // this first case just confirms the mechanism is direction-agnostic.
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob'] });
    ev = hooks.appendScoringEvent(ev, 'adjust', { field: 'outs', value: 3 });
    let st = hooks.deriveState(ev);
    assert(st.half === 'them' && st.outs === 0, 'adjust to 3 outs from a fresh "us" half flips to "them": ' + JSON.stringify({ outs: st.outs, half: st.half }));
    // Re-run to confirm the OTHER direction too -- the real mercy-button
    // path: 2 real opp_outs (still 'them', defense), then the mercy
    // button's adjust for the 3rd, flipping them->us with the inning
    // incrementing, same as reaching 3 outs would any other way.
    let ev2 = [];
    ev2 = hooks.appendScoringEvent(ev2, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob'] });
    ev2 = hooks.appendScoringEvent(ev2, 'pa', { playerId: 'alice', result: 'K', inning: 1, half: 'us' });
    ev2 = hooks.appendScoringEvent(ev2, 'pa', { playerId: 'bob', result: 'K', inning: 1, half: 'us' });
    ev2 = hooks.appendScoringEvent(ev2, 'pa', { playerId: 'alice', result: 'K', inning: 1, half: 'us' }); // 3rd out -> flips to 'them'
    ev2 = hooks.appendScoringEvent(ev2, 'opp_out', { inning: 1 });
    ev2 = hooks.appendScoringEvent(ev2, 'opp_out', { inning: 1 });
    let st2 = hooks.deriveState(ev2);
    assert(st2.half === 'them' && st2.outs === 2 && st2.inning === 1,
      'sanity before mercy adjust: ' + JSON.stringify({ half: st2.half, outs: st2.outs, inning: st2.inning }));
    ev2 = hooks.appendScoringEvent(ev2, 'adjust', { field: 'outs', value: 3 }); // the mercy-button path
    st2 = hooks.deriveState(ev2);
    assert(st2.half === 'us' && st2.outs === 0 && st2.inning === 2,
      'mercy adjust flips them->us and increments the inning, same as a real 3rd out: ' + JSON.stringify({ half: st2.half, outs: st2.outs, inning: st2.inning }));
    console.log('32. adjust/outs=3 triggers the same half-flip as a real 3rd out, both directions: OK');
  }

  // ============================================================
  // S1.5 correction states (06-Scoring-Specs.md item 5). The underlying
  // replay primitives (undo/amend/runner_out_hit_stands/legal-move
  // helpers) are already covered by 26-31 above -- these groups cover the
  // NEW orchestration layer: the open*/apply* functions the diamond,
  // chip, and correction sheets actually call, plus one full click-path
  // test through the real renderer to catch wiring bugs the hook-only
  // tests can't see.
  // ============================================================
  hooks.enableScoringForTest();

  // 33. Previous-kicker redirect: tapping the runner placed by their OWN
  // most recent PA opens fix-last, not the OUT/+N sheet; any other runner
  // gets the normal sheet.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' }); // alice -> 1st
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' }); // forces alice 1st->2nd; bob -> 1st
    const bobEventId = ev[ev.length - 1].id;
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();
    const st = hooks.getScoringState();
    assert(st.runners.alice === 2 && st.runners.bob === 1, 'sanity: alice 2nd, bob 1st: ' + JSON.stringify(st.runners));
    assert(st.previousKickerPlayerId === 'bob', 'previous kicker is bob: ' + st.previousKickerPlayerId);

    hooks.openRunnerCorrection('bob');
    let c = hooks.getScoringCorrection();
    assert(c && c.mode === 'fixLast' && c.viaRedirect === true && c.forPlayerId === 'bob' && c.targetId === bobEventId,
      'bob (previous kicker) redirects to fix-last: ' + JSON.stringify(c));
    hooks.closeScoringCorrection();

    hooks.openRunnerCorrection('alice');
    c = hooks.getScoringCorrection();
    assert(c && c.mode === 'runner' && c.playerId === 'alice', 'alice (not previous kicker) opens the runner sheet: ' + JSON.stringify(c));
    hooks.closeScoringCorrection();
    console.log('33. Previous-kicker redirect routes to fix-last; other runners get the OUT/+N sheet: OK');
  }

  // 34. Runner sheet: OUT, a forward tap-a-base set (with cascade push),
  // and a backward tap-a-base set all append the correct event shape and
  // close the sheet afterward (S1.5 round 7: absolute-target model).
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' });     // forces alice 1st->2nd; bob->1st
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'charlie', result: '1B', inning: 1, half: 'us' }); // forces alice 2nd->3rd, bob 1st->2nd; charlie->1st
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();
    let st = hooks.getScoringState();
    assert(st.runners.alice === 3 && st.runners.bob === 2 && st.runners.charlie === 1, 'sanity: full house: ' + JSON.stringify(st.runners));

    // Forward tap-a-base: bob (2nd) set to 3rd -- pushes alice (3rd) home,
    // same cascade a relative "+1" would have produced, now via a target.
    hooks.openRunnerCorrection('bob'); // not the previous kicker (charlie is) -- normal sheet
    hooks.applyRunnerSet('bob', 3);
    st = hooks.getScoringState();
    assert(st.runners.bob === 3, 'bob set to 3rd: ' + JSON.stringify(st.runners));
    assert(st.runners.alice === undefined, 'alice pushed past home by the cascade: ' + JSON.stringify(st.runners));
    assert(st.scoreUs === 1, 'alice\'s push-through credited a run: ' + st.scoreUs);
    assert(hooks.getScoringCorrection() === null, 'sheet closes after applying a set');
    let lastEvt = hooks.getScoringEvents()[hooks.getScoringEvents().length - 1];
    assert(lastEvt.type === 'runner' && lastEvt.payload.playerId === 'bob' && lastEvt.payload.action === 'set' && lastEvt.payload.to === 3,
      'forward set event shape: ' + JSON.stringify(lastEvt));

    // Backward tap-a-base: charlie (1st) set back to... nothing legal is
    // open behind 1st, so use bob (now on 3rd) set back to 2nd (open) --
    // moves alone, doesn't touch charlie.
    hooks.openRunnerCorrection('bob');
    hooks.applyRunnerSet('bob', 2);
    st = hooks.getScoringState();
    assert(st.runners.bob === 2, 'bob corrected backward to 2nd: ' + JSON.stringify(st.runners));
    assert(st.runners.charlie === 1, 'charlie untouched by bob\'s backward correction: ' + JSON.stringify(st.runners));
    lastEvt = hooks.getScoringEvents()[hooks.getScoringEvents().length - 1];
    assert(lastEvt.type === 'runner' && lastEvt.payload.action === 'set' && lastEvt.payload.to === 2,
      'backward set event shape: ' + JSON.stringify(lastEvt));

    hooks.openRunnerCorrection('charlie');
    hooks.applyRunnerOut('charlie');
    st = hooks.getScoringState();
    assert(st.runners.charlie === undefined, 'charlie removed from the bases after the OUT correction');
    assert(st.outs === 1, 'OUT correction records an out: ' + st.outs);
    assert(hooks.getScoringCorrection() === null, 'sheet closes after applying OUT');
    lastEvt = hooks.getScoringEvents()[hooks.getScoringEvents().length - 1];
    assert(lastEvt.type === 'runner' && lastEvt.payload.action === 'out', 'OUT event shape: ' + JSON.stringify(lastEvt));
    console.log('34. Runner sheet OUT / forward set (cascade) / backward set all append the right event and close the sheet: OK');
  }

  // 35. Fix-last amend changes the logged result; re-tapping the SAME
  // result is a no-op close (no redundant event).
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();

    hooks.openLastActionCorrection(); // last action is alice's 1B -- full fix-last
    let c = hooks.getScoringCorrection();
    assert(c && c.mode === 'fixLast' && c.viaRedirect === false && c.currentResult === '1B',
      'chip on a pa opens fix-last, not via redirect: ' + JSON.stringify(c));

    const eventsBefore = hooks.getScoringEvents().length;
    hooks.applyFixLastAmend('1B'); // tapping the SAME result -- just closes
    assert(hooks.getScoringEvents().length === eventsBefore, 'amending to the current result appends nothing');
    assert(hooks.getScoringCorrection() === null, 'sheet still closes on a same-result tap');

    hooks.openLastActionCorrection();
    hooks.applyFixLastAmend('2B'); // "actually it was a double"
    const st = hooks.getScoringState();
    assert(st.runners.alice === 2, 'alice now on 2nd after amending 1B -> 2B: ' + JSON.stringify(st.runners));
    const stats = hooks.computeStats(st);
    assert(stats.alice.h === 1 && stats.alice.ab === 1, 'still one hit/AB after the amend: ' + JSON.stringify(stats.alice));
    console.log('35. Fix-last amend changes the logged result; same-result tap is a no-op close: OK');
  }

  // 36. Fix-last undo fully restores pre-tap state -- the pointer reverts
  // to the fixed batter because the tombstoned pa event's own
  // advanceLineupPointer() never replays.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();
    assert(hooks.getScoringState().lineupPointer === 1, 'sanity: pointer advanced to bob after alice\'s PA');

    hooks.openLastActionCorrection();
    hooks.applyFixLastUndo();
    const st = hooks.getScoringState();
    assert(st.lineupPointer === 0, 'pointer reverted to alice after undo: ' + st.lineupPointer);
    assert(Object.keys(st.runners).length === 0, 'alice never reached base -- fully undone');
    assert(hooks.getScoringCorrection() === null, 'sheet closes after undo');
    const stats = hooks.computeStats(st);
    assert(!stats.alice, 'no stats recorded at all for the undone PA');
    console.log('36. Fix-last undo fully restores pre-tap state (pointer reverts, PA erased): OK');
  }

  // 37. Rundown exception (hit-stands) is only OFFERED when reached via the
  // previous-kicker redirect AND the batter is still actually on base --
  // guarded at render time (mockup 4: "add as a third dashed row when
  // entered via the redirect"), same as the rest of the app's "impossible
  // states are unreachable by construction" convention.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();

    hooks.openLastActionCorrection(); // chip tap, NOT the redirect -- viaRedirect: false
    render();
    assert(!findByClassContaining('fixlast-hitstands', 'hit stands'), 'hit-stands row absent when not entered via the redirect');
    hooks.closeScoringCorrection();

    hooks.openRunnerCorrection('alice'); // alice IS the previous kicker -- redirects with viaRedirect: true
    render();
    assert(findByClassContaining('fixlast-hitstands', 'hit stands'), 'hit-stands row present when entered via the redirect and still on base');
    hooks.applyFixLastHitStands();
    const st = hooks.getScoringState();
    assert(st.outs === 1 && st.runners.alice === undefined, 'hit-stands: out recorded, alice off the bases: ' + JSON.stringify({ outs: st.outs, runners: st.runners }));
    const stats = hooks.computeStats(st);
    assert(stats.alice.h === 1, 'the original hit still counts: h=' + stats.alice.h);
    console.log('37. Rundown hit-stands option only offered via the redirect while still on base: OK');
  }

  // 38. Chip tap on a non-`pa` last action (a runner correction, here)
  // opens the minimal undo-only sheet, not full fix-last -- there's no
  // "result" to re-target a pad at for these event kinds.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'opp_out', { inning: 1 }); // an event of a totally different kind, just to be the "last action"
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();

    hooks.openLastActionCorrection();
    const c = hooks.getScoringCorrection();
    assert(c && c.mode === 'undoLast', 'chip on a non-pa last action opens the undo-only sheet: ' + JSON.stringify(c));
    hooks.applyUndoLast();
    const st = hooks.getScoringState();
    assert(hooks.getScoringCorrection() === null, 'sheet closes after undo');
    assert(st.runners.alice === 1, 'unrelated state (alice on base) untouched by undoing the opp_out');
    console.log('38. Chip tap on a non-PA last action opens the undo-only sheet: OK');
  }

  // 39. Regression: the exact order-of-operations bug Jason reported live,
  // which is the whole reason S1.5 round 7 replaced the relative-delta
  // runner correction with an absolute target. A relative "+1" used to
  // replay against whatever base the runner happened to occupy AT REPLAY
  // TIME -- if an earlier event that had force-advanced them was undone
  // afterward, the delta landed on the wrong base (Jason's exact words:
  // "#1 is moved backwards to 2B" when it should have stayed on 3rd). An
  // absolute "set to 3rd" has no such dependency.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' }); // alice -> 1st
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' });   // forces alice 1st->2nd; bob -> 1st
    const bobEventId = ev[ev.length - 1].id;
    let st = hooks.deriveState(ev);
    assert(st.runners.alice === 2, 'sanity: alice forced to 2nd by bob\'s hit: ' + JSON.stringify(st.runners));

    // Manual correction made at THIS point in the game: alice actually
    // reached 3rd (a legal forward set from wherever she currently sits).
    ev = hooks.appendScoringEvent(ev, 'runner', { playerId: 'alice', action: 'set', to: 3 });
    st = hooks.deriveState(ev);
    assert(st.runners.alice === 3, 'sanity: alice corrected to 3rd: ' + JSON.stringify(st.runners));

    // Now bob's entire PA is undone (e.g. fix-last's "still at bat") --
    // his force-advance of alice never happened on replay.
    ev = hooks.appendScoringEvent(ev, 'undo', { target_event_id: bobEventId });
    st = hooks.deriveState(ev);
    assert(st.lineupPointer === 1, 'bob\'s PA fully undone -- pointer reverts to him: ' + st.lineupPointer);
    assert(st.runners.alice === 3,
      'alice must still land on 3rd -- the absolute "set to 3rd" replays correctly regardless of whether her base at replay time is 2 (tap-time reality) or 1 (bob\'s push erased): ' + JSON.stringify(st.runners));
    console.log('39. Order-of-operations regression: absolute set survives an undone intervening event: OK');
  }

  // 40. Full click path through the REAL renderer (not just hooks) --
  // diamond tap -> runner sheet -> OUT -> chip -> undo-only sheet -> undo.
  // The only test in this file that would catch a broken h()/class
  // reference in the new correction-sheet render functions before Jason
  // sees it on a phone.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' }); // alice -> 2nd, bob -> 1st
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();

    // Diamond bases carry no text of their own -- find the base button by
    // its adjacent initial-letter label (renderDiamond always appends the
    // base element immediately before its label).
    function findDiamondBaseByInitial(initial) {
      let found = null;
      const walk = (node) => {
        if (found) return;
        if (node.classList && node.classList.contains('diamond-label') && node.textContent === initial) {
          const wrap = node.parentElement;
          const idx = wrap._children.indexOf(node);
          found = wrap._children[idx - 1];
        }
        (node._children || []).forEach(walk);
      };
      walk(screen);
      return found;
    }

    // Labels are 2-letter runner codes as of 2026-07-08 (Alice -> AL).
    const aliceBaseBtn = findDiamondBaseByInitial('AL');
    assert(aliceBaseBtn && aliceBaseBtn.tagName === 'BUTTON', 'alice\'s occupied base rendered as a tappable button: ' + (aliceBaseBtn && aliceBaseBtn.tagName));
    aliceBaseBtn.dispatch('click');
    let c = hooks.getScoringCorrection();
    assert(c && c.mode === 'runner' && c.playerId === 'alice', 'clicking alice\'s base opens the runner sheet via the real DOM path: ' + JSON.stringify(c));

    const outBtn = findByClassContaining('correction-out', 'OUT');
    assert(outBtn, 'OUT button rendered in the runner sheet');
    outBtn.dispatch('click');
    assert(hooks.getScoringState().runners.alice === undefined, 'clicking OUT in the real DOM removes alice from the bases');
    assert(hooks.getScoringCorrection() === null, 'sheet closes after the real click');

    const chip = findByClassContaining('last-action-chip', 'tap to fix or undo');
    assert(chip && chip.tagName === 'BUTTON', 'last-action chip rendered as a tappable button');
    chip.dispatch('click');
    c = hooks.getScoringCorrection();
    // Round 2 (Jason, 2026-07-08): the chip is the AT-BAT's surface --
    // even when the newest event is a runner correction, chip tap opens
    // fix-last for the most recent PA (bob's), carrying the correction
    // along as an "undo last fix" escape hatch.
    assert(c && c.mode === 'fixLast' && c.forPlayerId === 'bob', 'chip tap after a runner correction opens fix-last for the last PA: ' + JSON.stringify(c));
    assert(c.lastCorrection && c.lastCorrection.targetId, 'the correction rides along as the undoable last fix: ' + JSON.stringify(c.lastCorrection));

    const undoFixBtn = findByClassContaining('fixlast-hitstands', 'undo last fix');
    assert(undoFixBtn, '"undo last fix" escape hatch rendered in the fix-last sheet');
    undoFixBtn.dispatch('click');
    const st = hooks.getScoringState();
    assert(st.outs === 0, 'undoing the OUT correction via the real DOM restores outs to 0: ' + st.outs);
    assert(st.runners.alice === 2, 'alice back on 2nd (her state before the OUT correction): ' + JSON.stringify(st.runners));
    assert(hooks.getScoringCorrection() === null, 'sheet closes after the real undo click');
    console.log('40. Full click path through the real renderer (diamond tap -> sheet -> OUT -> chip -> undo last fix): OK');
  }

  // 41. Tap-a-base through the REAL renderer (round 7's actual feature):
  // legal targets render as buttons on the diamond itself; tapping one
  // both moves the selected runner AND carries a lead runner along,
  // exactly like the old +N button list did, just via a diamond tap.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' });     // forces alice 1st->2nd; bob->1st
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'charlie', result: '1B', inning: 1, half: 'us' }); // forces alice 2nd->3rd, bob 1st->2nd; charlie->1st
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();
    let st = hooks.getScoringState();
    assert(st.runners.alice === 3 && st.runners.bob === 2 && st.runners.charlie === 1, 'sanity: full house: ' + JSON.stringify(st.runners));

    function findByClasses(classes) {
      let found = null;
      const walk = (node) => {
        if (found) return;
        if (node.classList && classes.every(c => node.classList.contains(c))) found = node;
        (node._children || []).forEach(walk);
      };
      walk(screen);
      return found;
    }

    // bob (2nd) tapped -- not the previous kicker (charlie is) -- opens
    // the normal sheet, legal targets [3, 4] (backward/1st excluded,
    // occupied by charlie).
    hooks.openRunnerCorrection('bob');
    render();
    const nonTarget1st = findByClasses(['diamond-base', 'pos-1st']);
    assert(nonTarget1st && !nonTarget1st.classList.contains('legal-target') && nonTarget1st.tagName !== 'BUTTON',
      '1st is occupied by charlie and NOT a legal target -- stays a plain, untappable div');
    const target3rd = findByClasses(['diamond-base', 'pos-3rd', 'legal-target']);
    assert(target3rd && target3rd.tagName === 'BUTTON', '3rd renders as a tappable legal-target button: ' + (target3rd && target3rd.tagName));

    target3rd.dispatch('click');
    st = hooks.getScoringState();
    assert(st.runners.bob === 3, 'bob moved to 3rd via the real diamond tap: ' + JSON.stringify(st.runners));
    assert(st.runners.alice === undefined, 'alice (previously on 3rd) pushed home by the real tap -- same cascade as before, now via a target: ' + JSON.stringify(st.runners));
    assert(st.scoreUs === 1, 'the push-through credited a run: ' + st.scoreUs);
    assert(hooks.getScoringCorrection() === null, 'sheet closes after the real tap-a-base click');
    console.log('41. Tap-a-base through the real renderer (legal targets on the diamond, forward cascade): OK');
  }

  // 42. Chain-forward set gap regression (2026-07-08 audit find): runners
  // on the corners, trail runner corrected 1st->2nd -- the UNBLOCKED lead
  // runner on 3rd must HOLD, not be pushed home. (The old uniform push
  // scored them silently; loaded-bases cascades, where uniform and chain
  // agree, are already covered by tests 34/41.)
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' });     // alice forced to 2nd
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'charlie', result: '1B', inning: 1, half: 'us' }); // alice 3rd, bob 2nd, charlie 1st
    ev = hooks.appendScoringEvent(ev, 'runner', { playerId: 'bob', action: 'out' });                        // corners: alice 3rd, charlie 1st
    let st = hooks.deriveState(ev);
    assert(st.runners.alice === 3 && st.runners.charlie === 1 && st.runners.bob === undefined,
      'sanity: corners board: ' + JSON.stringify(st.runners));
    ev = hooks.appendScoringEvent(ev, 'runner', { playerId: 'charlie', action: 'set', to: 2 });
    st = hooks.deriveState(ev);
    assert(st.runners.charlie === 2, 'charlie moved to 2nd: ' + JSON.stringify(st.runners));
    assert(st.runners.alice === 3, 'alice HELD 3rd -- not pushed by an unblocked 1-base correction behind her: ' + JSON.stringify(st.runners));
    assert(st.scoreUs === 0, 'no phantom run: ' + st.scoreUs);
    // Chain still carries a passed/collided runner: charlie 2nd->3rd bumps alice home.
    ev = hooks.appendScoringEvent(ev, 'runner', { playerId: 'charlie', action: 'set', to: 3 });
    st = hooks.deriveState(ev);
    assert(st.runners.charlie === 3 && st.runners.alice === undefined && st.scoreUs === 1,
      'landing ON an occupied base still bumps its occupant home: ' + JSON.stringify(st.runners) + ' score ' + st.scoreUs);
    console.log('42. Chain-forward set: gap holds the lead runner, collision still bumps: OK');
  }

  // 43. Jason's Megan/Ming scenario (2026-07-08, on-device find): 1B
  // logged, runner manually set to 3rd, then the 1B amended to a 2B. The
  // amended replay's push must NOT score the runner past the operator's
  // absolute observation -- the set wins, the run comes back off, and the
  // PA record's own movement line reads the corrected placement.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['bob', 'alice', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: '2B', inning: 1, half: 'us' });   // bob (the "Ming") on 2nd
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' }); // alice (the "Megan") 1st; bob unforced, holds
    let st = hooks.deriveState(ev);
    assert(st.runners.bob === 2 && st.runners.alice === 1, 'sanity: bob held at 2nd on the single: ' + JSON.stringify(st.runners));
    ev = hooks.appendScoringEvent(ev, 'runner', { playerId: 'bob', action: 'set', to: 3 });              // operator: bob actually took 3rd
    const alicePa = ev.find(e => e.type === 'pa' && e.payload.playerId === 'alice');
    ev = hooks.appendScoringEvent(ev, 'amend', { target_event_id: alicePa.id, result: '2B' });           // operator: it was really a double
    st = hooks.deriveState(ev);
    assert(st.runners.alice === 2, 'alice re-derived onto 2nd: ' + JSON.stringify(st.runners));
    assert(st.runners.bob === 3, 'bob lands where the operator SAID he was (3rd), not pushed home by the amended double: ' + JSON.stringify(st.runners));
    assert(st.scoreUs === 0, 'the amend-then-set interplay credits no phantom run: ' + st.scoreUs);
    const rec = st.paLog.filter(r => r.playerId === 'alice')[0];
    assert(rec.rbi === 0 && rec.inferredRbi === 0, 'no stale RBI left on the amended PA: ' + JSON.stringify({ rbi: rec.rbi, inf: rec.inferredRbi }));
    assert(rec.movements.some(m => m.playerId === 'bob' && m.to === 3 && !m.scored),
      'the PA record\'s movement line was rewritten to the corrected placement: ' + JSON.stringify(rec.movements));
    console.log('43. Amend-after-set: absolute observation beats the assumption engine, run reversed: OK');
  }

  // 44. Scored-runner correction through the REAL renderer (2026-07-08:
  // the "auto-scored on the assumption engine's double, but really held at
  // 3rd" case): home plate is the tap target, the sheet's legal-target tap
  // walks the run back off the board.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['bob', 'alice', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: '2B', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '2B', inning: 1, half: 'us' }); // uniform hit push: bob scores
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();
    let st = hooks.getScoringState();
    assert(st.scoreUs === 1 && st.runners.bob === undefined, 'sanity: assumption engine scored bob: ' + JSON.stringify(st.runners));
    assert(JSON.stringify(st.scoredThisHalf) === JSON.stringify(['bob']), 'scoredThisHalf lists bob: ' + JSON.stringify(st.scoredThisHalf));

    function findByClasses(classes) {
      let found = null;
      const walk = (node) => {
        if (found) return;
        if (node.classList && classes.every(c => node.classList.contains(c))) found = node;
        (node._children || []).forEach(walk);
      };
      walk(screen);
      return found;
    }

    const home = findByClasses(['diamond-base', 'pos-home', 'has-scored']);
    assert(home && home.tagName === 'BUTTON', 'home plate renders as a tappable button while a run this half exists: ' + (home && home.tagName));
    home.dispatch('click');
    let c = hooks.getScoringCorrection();
    assert(c && c.mode === 'scoredRunner' && c.playerId === 'bob', 'single scored runner goes straight to the correction sheet: ' + JSON.stringify(c));

    const target3rd = findByClasses(['diamond-base', 'pos-3rd', 'legal-target']);
    assert(target3rd && target3rd.tagName === 'BUTTON', '3rd offered as a walk-back target: ' + (target3rd && target3rd.tagName));
    target3rd.dispatch('click');
    st = hooks.getScoringState();
    assert(st.runners.bob === 3 && st.scoreUs === 0, 'real click walked the run back: bob on 3rd, score reversed: ' + JSON.stringify(st.runners) + ' score ' + st.scoreUs);
    assert(hooks.getScoringCorrection() === null, 'sheet closes after the walk-back');

    // Assessment chip (round 2, 2026-07-08): the chip shows the newly
    // CALCULATED at-bat -- corrections folded in as if scored that way
    // live ("Bob 2nd→3rd"), no edit-ledger ✎ lines.
    render();
    const chip = findByClassContaining('last-action-chip', 'tap to fix or undo');
    assert(chip && chip.textContent.includes('Alice') && chip.textContent.includes('Doubled'),
      'chip headline is the at-bat: ' + chip.textContent);
    assert(chip.textContent.includes('Bob 2nd→3rd'), 'correction folded into the assessment as a plain movement: ' + chip.textContent);
    assert(!chip.textContent.includes('✎ Bob'), 'no edit-ledger line for the correction: ' + chip.textContent);
    assert(!chip.textContent.includes('RBI'), 'the reversed run took its RBI line with it: ' + chip.textContent);

    // Out-at-home variant, engine-level: reverse the walk-back, then log
    // "actually out at home" -- run off, out up.
    hooks.setScoringEvents(ev); // back to the auto-scored state
    hooks.applyScoredRunnerOut('bob');
    st = hooks.getScoringState();
    assert(st.scoreUs === 0 && st.outs === 1 && st.runners.bob === undefined,
      'out-at-home reverses the run and records the out: score ' + st.scoreUs + ' outs ' + st.outs);
    console.log('44. Scored-runner correction: home-plate tap, walk-back, merged chip, out-at-home: OK');
  }

  // 45. Same-half guard on un-scoring: a legitimate run from a FINISHED
  // half is untouchable -- a stale set replaying against it must no-op,
  // never claw the run back.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['bob', 'alice', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: 'HR', inning: 1, half: 'us' }); // bob scores, legitimately
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: 'K', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'charlie', result: 'K', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: 'K', inning: 1, half: 'us' }); // 3rd out -- half flips
    ev = hooks.appendScoringEvent(ev, 'runner', { playerId: 'bob', action: 'set', to: 2 });           // stale/garbage set next half
    const st = hooks.deriveState(ev);
    assert(st.half === 'them' && st.scoreUs === 1, 'the inning-1 run survives a cross-half stale set: score ' + st.scoreUs);
    assert(st.runners.bob === undefined, 'the stale set placed nobody: ' + JSON.stringify(st.runners));
    console.log('45. Un-scoring same-half guard: finished-half runs are untouchable: OK');
  }

  // 46. Runner codes: unique 2-letter, deterministic (Alice->AL, Bob->BO,
  // Charlie->CH, Dana->DA, Eli->EL for the test roster).
  {
    const codes = ['alice', 'bob', 'charlie', 'dana', 'eli'].map(id => hooks.runnerCode(id));
    assert(JSON.stringify(codes) === JSON.stringify(['AL', 'BO', 'CH', 'DA', 'EL']), 'expected codes: ' + JSON.stringify(codes));
    assert(new Set(codes).size === codes.length, 'codes are unique');
    console.log('46. 2-letter runner codes derived and unique: OK');
  }

  // 47. Backgrounding cancels a pending auto-play (2026-07-08 audit):
  // iOS freezes the timer while hidden and fires it on return -- music
  // starting unexpectedly outside any gesture. Hidden must clear it.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    hooks.setScoringEvents(ev);
    hooks.scheduleScoringAutoPlay();
    assert(hooks.getScoringAutoPlayPending() !== null, 'auto-play armed');
    document.visibilityState = 'hidden';
    document.dispatchTo('visibilitychange');
    document.visibilityState = 'visible';
    assert(hooks.getScoringAutoPlayPending() === null, 'backgrounding cleared the pending auto-play');
    console.log('47. Pending auto-play cancelled on backgrounding: OK');
  }

  // 48. Backward pass-blocking, end to end (Jason's Marcel/Penny find,
  // 2026-07-08 round 2): Marcel triples, Penny doubles (Marcel auto-
  // scored). Walking Marcel back must offer ONLY 3rd -- 1st is behind
  // Penny on 2nd, physically impossible -- and a forced illegal event
  // must no-op at replay (the run stays) rather than teleporting him.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['charlie', 'alice', 'bob'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'charlie', result: '3B', inning: 1, half: 'us' }); // the "Marcel"
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '2B', inning: 1, half: 'us' });   // the "Penny": charlie auto-scores
    let st = hooks.deriveState(ev);
    assert(st.scoreUs === 1 && st.runners.alice === 2 && st.runners.charlie === undefined,
      'sanity: charlie auto-scored, alice on 2nd: ' + JSON.stringify(st.runners));
    assert(JSON.stringify(hooks.legalReturnTargets(st.runners)) === JSON.stringify([3]),
      'walk-back targets stop at the trailing runner: only 3rd, never 1st: ' + JSON.stringify(hooks.legalReturnTargets(st.runners)));
    // Force the illegal event anyway (UI can no longer produce it):
    ev = hooks.appendScoringEvent(ev, 'runner', { playerId: 'charlie', action: 'set', to: 1 });
    st = hooks.deriveState(ev);
    assert(st.scoreUs === 1 && st.runners.charlie === undefined,
      'illegal walk-back no-ops at replay -- run stands, nobody teleports behind alice: ' + JSON.stringify(st.runners) + ' score ' + st.scoreUs);
    // The legal one still works, and the chip assessment reads "held 3rd"
    // territory (charlie 3rd->3rd nets to no movement line; run reversed).
    ev = ev.slice(0, -1);
    ev = hooks.appendScoringEvent(ev, 'runner', { playerId: 'charlie', action: 'set', to: 3 });
    st = hooks.deriveState(ev);
    assert(st.scoreUs === 0 && st.runners.charlie === 3, 'legal walk-back still lands: ' + JSON.stringify(st.runners) + ' score ' + st.scoreUs);
    // Backward set among ON-BASE runners obeys the same rule at replay:
    // bob on 3rd may not be set to 1st past alice on 2nd.
    let ev2 = [];
    ev2 = hooks.appendScoringEvent(ev2, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['bob', 'alice'] });
    ev2 = hooks.appendScoringEvent(ev2, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' });   // bob 1st
    ev2 = hooks.appendScoringEvent(ev2, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' }); // bob forced 2nd, alice 1st
    ev2 = hooks.appendScoringEvent(ev2, 'runner', { playerId: 'bob', action: 'set', to: 3 });              // bob 3rd; alice 1st; 2nd open
    ev2 = hooks.appendScoringEvent(ev2, 'runner', { playerId: 'alice', action: 'set', to: 2 });            // alice 2nd -- now bob 3rd, alice 2nd
    ev2 = hooks.appendScoringEvent(ev2, 'runner', { playerId: 'bob', action: 'set', to: 1 });              // ILLEGAL: past alice
    const st2 = hooks.deriveState(ev2);
    assert(st2.runners.bob === 3 && st2.runners.alice === 2,
      'on-base backward set past a trailing runner no-ops at replay: ' + JSON.stringify(st2.runners));
    console.log('48. Backward pass-blocking: targets, walk-back, and replay all agree: OK');
  }

  // 49. Reverse-order scorer corrections (Jason's grand-slam find,
  // 2026-07-08 round 3): bases-loaded HR scores four. Home tap must open
  // the MOST RECENT scorer only -- and since that's the kicker whose own
  // at-bat scored them, it routes to fix-last (chip-equivalent), so
  // "actually a double" re-derives everything. Mid-order scorers are
  // untouchable until later ones are walked back, at BOTH the UI and
  // replay levels.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie', 'dana'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'charlie', result: '1B', inning: 1, half: 'us' }); // loaded: alice 3rd, bob 2nd, charlie 1st
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'dana', result: 'HR', inning: 1, half: 'us' });    // grand slam: order alice, bob, charlie, dana
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();
    let st = hooks.getScoringState();
    assert(st.scoreUs === 4 && Object.keys(st.runners).length === 0, 'sanity: grand slam, bases cleared: ' + st.scoreUs);

    // Home tap: most recent scorer is dana, the kicker -- fix-last redirect.
    hooks.openScoredCorrection();
    let c = hooks.getScoringCorrection();
    assert(c && c.mode === 'fixLast' && c.forPlayerId === 'dana',
      'home tap after an HR routes to fix-last for the kicker, not a runner sheet: ' + JSON.stringify(c));

    // "Actually a double": re-derives -- dana on 2nd, charlie (from 1st)
    // on 3rd, alice + bob still score. Chip logic now reads Doubled.
    hooks.applyFixLastAmend('2B');
    st = hooks.getScoringState();
    assert(st.scoreUs === 2 && st.runners.dana === 2 && st.runners.charlie === 3,
      'amend HR->2B re-derives runners and runs: ' + JSON.stringify(st.runners) + ' score ' + st.scoreUs);

    // Home tap now: most recent remaining scorer is bob (scored ahead of
    // alice? credit order for the 2B push is highest base first: alice
    // then bob) -- last entry is bob, a RUNNER, so the walk-back sheet.
    hooks.openScoredCorrection();
    c = hooks.getScoringCorrection();
    assert(c && c.mode === 'scoredRunner' && c.playerId === 'bob',
      'next correction targets the most recent scorer only: ' + JSON.stringify(c));
    // With charlie on 3rd, bob (who scored ahead of charlie... behind on
    // the paths) has NO legal return base -- everything is behind the
    // trailing runner's blockade. OUT at home remains the only option.
    assert(JSON.stringify(hooks.legalReturnTargets(st.runners)) === JSON.stringify([]),
      'no walk-back past the runner standing on 3rd: ' + JSON.stringify(hooks.legalReturnTargets(st.runners)));
    hooks.closeScoringCorrection();

    // Replay-level reverse-order guard: a forced illegal set for ALICE
    // (mid-order scorer, not the most recent) must no-op even though 1st
    // is open and the path from home is... blocked anyway -- so use a
    // board with a clear path: undo the amend? Simpler: direct engine
    // check on a fresh log where two scored and the FIRST is targeted.
    let ev2 = [];
    ev2 = hooks.appendScoringEvent(ev2, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev2 = hooks.appendScoringEvent(ev2, 'pa', { playerId: 'alice', result: 'HR', inning: 1, half: 'us' }); // alice scores first
    ev2 = hooks.appendScoringEvent(ev2, 'pa', { playerId: 'bob', result: 'HR', inning: 1, half: 'us' });   // bob scores second
    ev2 = hooks.appendScoringEvent(ev2, 'runner', { playerId: 'alice', action: 'set', to: 2 });            // ILLEGAL: alice is not the most recent scorer
    let st2 = hooks.deriveState(ev2);
    assert(st2.scoreUs === 2 && st2.runners.alice === undefined,
      'mid-order scorer un-score no-ops at replay: ' + JSON.stringify(st2.runners) + ' score ' + st2.scoreUs);
    ev2 = ev2.slice(0, -1);
    ev2 = hooks.appendScoringEvent(ev2, 'runner', { playerId: 'bob', action: 'set', to: 2 });              // legal: bob IS the most recent
    st2 = hooks.deriveState(ev2);
    assert(st2.scoreUs === 1 && st2.runners.bob === 2,
      'most-recent scorer walk-back still works: ' + JSON.stringify(st2.runners) + ' score ' + st2.scoreUs);
    console.log('49. Reverse-order scorer corrections: redirect for the kicker, one-at-a-time walk-backs: OK');
  }

  // 50. Live box score (first pass, 2026-07-08 round 5): the score-bug
  // chip toggles the scorecard takeover panel; the panel replaces the
  // game body (no result pad while open); the engine's scorecard marks
  // (runsByInning, kickerScored, endedHalf) derive correctly. Canvas
  // drawing itself is skipped in the stub (no getContext) -- layout and
  // wiring are what this group proves.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Kick City', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: 'HR', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'charlie', result: 'K', inning: 1, half: 'us' });
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();

    let st = hooks.getScoringState();
    assert(st.runsByInning.us[1] === 1, 'line-score tally derives: ' + JSON.stringify(st.runsByInning));
    const aliceRec = st.paLog.filter(r => r.playerId === 'alice')[0];
    assert(aliceRec.kickerScored === true, 'HR marks the kicker\'s own cell scored');
    const bobRec = st.paLog.filter(r => r.playerId === 'bob')[0];
    assert(bobRec.kickerScored === false && bobRec.kickerOut === false, 'bob\'s cell is a plain single');

    const chip = findByClassContaining('boxscore-chip', 'box score');
    assert(chip && chip.tagName === 'BUTTON', 'box-score chip rendered in the score bug');
    chip.dispatch('click');
    render();
    assert(findByClassContaining('boxscore-panel', ''), 'scorecard panel open');
    assert(!findByText('MISSED'), 'result pad replaced while the box score is open');

    const closeBtn = findByClassContaining('boxscore-close', 'close box score');
    assert(closeBtn, 'close button rendered');
    closeBtn.dispatch('click');
    assert(!findByClassContaining('boxscore-panel', ''), 'panel closes');
    assert(findByText('MISSED'), 'result pad back after close');

    // A runner-out third out marks endedHalf on the right cell. These two
    // PAs are also alice's and bob's SECOND of the inning -- the
    // staircase must open a continuation column for inning 1.
    ev = hooks.getScoringEvents();
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: 'K', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: 'K', inning: 1, half: 'us' }); // 3rd out, half flips
    st = hooks.deriveState(ev);
    const lastBobRec = st.paLog.filter(r => r.playerId === 'bob').pop();
    assert(lastBobRec.endedHalf === true, 'third-out corner mark lands on the half-ending cell');
    assert(st.half === 'them', 'sanity: half flipped');

    // Iteration 2: reachedBase tracks forced advancement (bob's single in
    // pass 1 sat on 1st until... build a fresh force scenario instead).
    let ev3 = [];
    ev3 = hooks.appendScoringEvent(ev3, 'game_start', { opponent: 'X', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev3 = hooks.appendScoringEvent(ev3, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    ev3 = hooks.appendScoringEvent(ev3, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' });   // forces alice to 2nd
    ev3 = hooks.appendScoringEvent(ev3, 'runner', { playerId: 'alice', action: 'set', to: 3 });            // manual advance
    const st3 = hooks.deriveState(ev3);
    const aliceRec3 = st3.paLog.filter(r => r.playerId === 'alice')[0];
    assert(aliceRec3.reachedBase === 3, 'edge fills follow the runner: force to 2nd then set to 3rd -> reachedBase 3: ' + aliceRec3.reachedBase);
    console.log('50. Live box score: chip toggle, takeover panel, scorecard marks, staircase + progression: OK');
  }

  // 51. Roster-overlay plumbing (S1.6 prep, 2026-07-08): a `player_add`
  // sub resolves to their real name and a collision-aware runner code on
  // every scoring surface, without existing in the built manifest.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'ellie'] });
    ev = hooks.appendScoringEvent(ev, 'player_add', { playerId: 'ellie', name: 'Ellie', status: 'sub' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();
    assert(hooks.playerNameOf('ellie') === 'Ellie', 'overlay player resolves by name: ' + hooks.playerNameOf('ellie'));
    // Eli (manifest) already owns EL -- the sub must get a different code.
    const code = hooks.runnerCode('ellie');
    assert(code === 'EI' || (code.length === 2 && code !== hooks.runnerCode('eli')),
      'overlay code is collision-aware vs Eli\'s EL: ellie=' + code + ' eli=' + hooks.runnerCode('eli'));
    // Ellie is NOW UP after alice's single -- the card must show her name.
    const nowUp = findByClassContaining('nowup-name', 'ELLIE');
    assert(nowUp, 'NOW UP card renders the overlay sub\'s name');
    console.log('51. Roster overlay: names + collision-aware codes for player_add subs: OK');
  }

  // 52. S1.6 lineup editor: PIN gate (wrong PIN shakes+clears, correct PIN
  // unlocks + persists + proceeds), draft append/remove/idempotency,
  // cancel discards everything including edits.
  {
    hooks.enableScoringForTest();
    hooks.setScoringEvents([]);
    hooks.setScoringLineupEditor(null);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();

    const startBtn = findByText('start game');
    assert(startBtn, 'Start game entry point rendered on the classic Next Up screen when scoring is enabled and no game is live');

    hooks.openStartGameFlow();
    assert(hooks.getPinSheet() !== null, 'Start Game gates behind the PIN sheet when this device is not yet unlocked');
    assert(hooks.getScoringLineupEditor() === null, 'the editor does not open until the PIN succeeds');

    '9999'.split('').forEach(d => hooks.pinKeyTap(d));
    assert(hooks.getPinUnlocked() === false, 'wrong PIN does not unlock');
    assert(hooks.getPinSheet() && hooks.getPinSheet().shake === true, 'wrong PIN shakes (no error prose)');
    await new Promise(r => setTimeout(r, 400)); // let the shake-then-clear timer fire
    assert(hooks.getPinSheet().digits === '', 'wrong PIN clears after the shake');

    '0000'.split('').forEach(d => hooks.pinKeyTap(d)); // manifest default teamPin
    assert(hooks.getPinUnlocked() === true, 'correct PIN unlocks the device');
    assert(hooks.getPinSheet() === null, 'PIN sheet closes on success');
    assert(hooks.getScoringLineupEditor() && hooks.getScoringLineupEditor().mode === 'start',
      'PIN success proceeds straight into the Start Game flow (the queued onSuccess callback)');
    assert(localStorage.getItem('kickball_v1_scoringPinUnlocked') === 'true', 'the unlock persists to localStorage (07: the flag IS the scorer-device marker)');

    hooks.draftAppend('alice');
    hooks.draftAppend('bob');
    assert(hooks.getScoringLineupEditor().draft.includes('alice') && hooks.getScoringLineupEditor().draft.includes('bob'),
      'draftAppend adds players to the draft');
    hooks.draftAppend('alice'); // duplicate tap
    assert(hooks.getScoringLineupEditor().draft.filter(x => x === 'alice').length === 1, 'draftAppend is idempotent');
    hooks.draftRemove('alice');
    assert(!hooks.getScoringLineupEditor().draft.includes('alice'), 'draftRemove takes a player back out of the draft');

    hooks.draftAppend('charlie');
    hooks.cancelScoringLineupEditor();
    assert(hooks.getScoringLineupEditor() === null, 'cancel closes the editor');
    assert(hooks.getScoringEvents().length === 0, 'cancel appends no event -- every draft edit, including the clear, is discarded');
    console.log('52. Lineup editor: PIN gate (wrong/correct/persistence), draft append/remove/idempotency, cancel discards: OK');
  }

  // 53. Start Game (schedule pre-pick -> scheduleGameId) and End Game.
  {
    hooks.getDATA().schedule = [
      { id: 'g1', date: '2020-01-01', time: '20:00', opponent: 'Old Foes', result: { us: 1, them: 2 } }, // final in the manifest -- never a start candidate
      { id: 'g2', date: '2099-01-06', time: '20:30', opponent: 'Future FC' }, // soonest real upcoming fixture
    ];
    hooks.openStartGameFlow(); // already unlocked from test 52 -- proceeds straight to the editor, no PIN sheet
    let ed = hooks.getScoringLineupEditor();
    assert(ed && ed.mode === 'start', 'Start Game opens directly once unlocked');
    assert(ed.scheduleGameId === 'g2', 'pre-picks the soonest upcoming, non-final fixture, skipping game 1\'s manifest result: ' + ed.scheduleGameId);
    hooks.draftAppend('alice'); hooks.draftAppend('bob'); hooks.draftAppend('charlie');
    hooks.commitStartGame();

    let st = hooks.getScoringState();
    assert(st.gameStarted === true && st.opponent === 'Future FC' && st.scheduleGameId === 'g2',
      'game_start carries the picked fixture\'s opponent + scheduleGameId: ' + st.opponent + ' / ' + st.scheduleGameId);
    assert(hooks.getScoringLineupEditor() === null, 'editor closes after Start');

    hooks.openMidGameLineupEditor();
    assert(hooks.getScoringLineupEditor().mode === 'edit', 'mid-game ✎ lineup opens the edit-mode editor');
    hooks.openEndGameConfirm();
    assert(hooks.getEndGameConfirmOpen() === true, 'end game confirm sheet opens');
    hooks.commitEndGame();
    st = hooks.getScoringState();
    assert(st.gameEnded === true && st.finalUs === st.scoreUs && st.finalThem === st.scoreThem,
      'game_end closes the game with the live score as final');
    assert(hooks.getScoringLineupEditor() === null && hooks.getEndGameConfirmOpen() === false,
      'both the editor and the confirm sheet close after End Game');
    console.log('53. Start Game (schedule pre-pick, scheduleGameId) + End Game: OK');
  }

  // 54. Mid-game lineup edit: current-kicker removal guard, a normal
  // removal, a reorder, cancel-vs-done, and pointer-carries-by-identity
  // (the new lineup_set event, 06-Scoring-Specs.md item 6 amendment).
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();
    let st = hooks.getScoringState();
    assert(st.lineup[st.lineupPointer] === 'alice', 'sanity: alice is up first');

    hooks.openMidGameLineupEditor();
    const ed = hooks.getScoringLineupEditor();
    assert(ed.mode === 'edit' && ed.draft.join(',') === 'alice,bob,charlie', 'edit-mode draft seeds from the live lineup');

    hooks.draftRemove('alice'); // current kicker
    assert(hooks.getScoringLineupEditor().draft.includes('alice'), 'the current kicker cannot be removed mid-game, only reordered around');
    hooks.draftRemove('charlie'); // not up -- removable
    assert(!hooks.getScoringLineupEditor().draft.includes('charlie'), 'a non-current player can be removed');

    hooks.cancelScoringLineupEditor();
    st = hooks.getScoringState();
    assert(st.lineup.join(',') === 'alice,bob,charlie', 'cancel leaves the live lineup untouched');
    assert(hooks.getScoringEvents().filter(e => e.type === 'lineup_set').length === 0, 'cancel appends no lineup_set event');

    hooks.openMidGameLineupEditor();
    hooks.getScoringLineupEditor().draft = ['bob', 'alice']; // simulates a completed drag's DOM-order commit
    hooks.commitLineupEdit();
    st = hooks.getScoringState();
    assert(st.lineup.join(',') === 'bob,alice', 'Done commits the edited order as one lineup_set: ' + st.lineup.join(','));
    assert(st.lineup[st.lineupPointer] === 'alice', 'pointer carries forward by identity (alice), not by index');
    assert(hooks.getScoringEvents().filter(e => e.type === 'lineup_set').length === 1, 'exactly one lineup_set event for the whole edit session');
    console.log('54. Mid-game lineup edit: current-kicker guard, remove, reorder, cancel-vs-done, pointer-by-identity: OK');
  }

  // 55. player_add overlay end-to-end through the real add-player sheet,
  // including the known playback gap this session fixes: an overlay id's
  // chosen defaultClip must resolve to a real decoded buffer.
  {
    hooks.getDATA().defaultClips = [{ id: 'default-0', name: 'Hype Track 1', durationSec: 3, mime: 'audio/mp4', data: Buffer.from('x').toString('base64') }];
    await hooks.decodeAll();
    assert(hooks.getDefaultClipBuffers()['default-0'], 'defaultClip decodes into its own id-keyed buffer map');

    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice'] });
    hooks.setScoringEvents(ev);
    hooks.openMidGameLineupEditor();
    hooks.openAddPlayerSheet();
    const s = hooks.getAddPlayerSheet();
    assert(s !== null, 'add-player sheet open');
    s.name = 'Dana Sub';
    s.status = 'sub';
    s.clipIndex = 0;
    hooks.commitAddPlayer();

    const st = hooks.getScoringState();
    const overlay = st.rosterOverlay.find(p => p.name === 'Dana Sub');
    assert(overlay && overlay.status === 'sub' && overlay.defaultClip === 'default-0',
      'player_add records name/status/defaultClip: ' + JSON.stringify(overlay));
    assert(hooks.getScoringLineupEditor().draft.includes(overlay.id),
      'the new player lands straight in the draft order (07\'s open question, resolved by the sheet\'s "add to order" copy)');
    assert(hooks.getAddPlayerSheet() === null, 'add-player sheet closes on submit');

    const buf = hooks.overlayBufferFor(overlay.id);
    assert(buf === hooks.getDefaultClipBuffers()['default-0'],
      'overlayBufferFor resolves the sub\'s id to their chosen defaultClip\'s decoded buffer -- the fix for playClip\'s previous no-op on overlay ids');
    console.log('55. player_add overlay: name/status/defaultClip recorded, lands in draft order, clip playback resolves: OK');
  }

  // 56. Adjust steppers (score-bug tap): draft/commit/cancel, outs clamp at
  // 2, the inning stepper walks halves before incrementing, and commit
  // appends exactly one adjust event per CHANGED field.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'Test FC', innings: 7, lineup: ['alice', 'bob'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    hooks.setScoringEvents(ev);
    hooks.getState().activeTab = 'lineup'; hooks.getState().editing = false;
    render();

    hooks.openAdjustSheet();
    let c = hooks.getScoringCorrection();
    assert(c && c.mode === 'adjust', 'score-bug tap opens the adjust sheet');
    assert(c.draft.outs === 0 && c.draft.inning === 1 && c.draft.half === 'us', 'draft seeded from live state');

    hooks.adjustStep('outs', 1); hooks.adjustStep('outs', 1); hooks.adjustStep('outs', 1);
    assert(hooks.getScoringCorrection().draft.outs === 2, 'outs stepper clamps at 2 -- a third out is a real event, not an adjustment');

    hooks.adjustStep('inning', 1); // us -> them, same inning number
    assert(hooks.getScoringCorrection().draft.half === 'them' && hooks.getScoringCorrection().draft.inning === 1,
      'inning stepper walks to the other half first (▲1 -> ▼1)');
    hooks.adjustStep('inning', 1); // them -> us, inning increments
    assert(hooks.getScoringCorrection().draft.half === 'us' && hooks.getScoringCorrection().draft.inning === 2,
      'inning stepper increments on the us-half wrap (▼1 -> ▲2)');

    hooks.adjustStep('scoreUs', 1);
    hooks.adjustStep('scoreThem', 1);
    hooks.closeScoringCorrection(); // cancel
    let st = hooks.getScoringState();
    assert(st.outs === 0 && st.inning === 1 && st.scoreUs === 0, 'cancel discards every stepper change, even after edits');
    assert(hooks.getScoringEvents().filter(e => e.type === 'adjust').length === 0, 'cancel appends no adjust events');

    hooks.openAdjustSheet();
    hooks.adjustStep('outs', 1);
    hooks.adjustStep('scoreUs', 1);
    hooks.commitAdjust();
    st = hooks.getScoringState();
    const adjustEvents = hooks.getScoringEvents().filter(e => e.type === 'adjust');
    assert(adjustEvents.length === 2, 'done commits exactly one adjust event per CHANGED field: ' + adjustEvents.length);
    assert(st.outs === 1 && st.scoreUs === 1 && st.inning === 1 && st.half === 'us',
      'unchanged fields (inning/half) get no adjust event and stay as they were');
    assert(hooks.getScoringCorrection() === null, 'adjust sheet closes after commit');
    console.log('56. Adjust steppers: draft/commit/cancel, outs clamp, inning-walks-halves, one event per changed field: OK');
  }

  // 57. Debug panel "clear game data" action (2026-07-12 session): the
  // test-game hygiene tool for Jason's separate test device. Gated behind
  // window.confirm() -- declining must be a true no-op; confirming wipes
  // the event log (memory + localStorage) and closes any open scoring
  // overlay so a stale sheet can't survive a wipe.
  {
    hooks.setScoringEvents([
      { id: 'e1', seq: 1, ts: new Date().toISOString(), type: 'game_start', payload: { lineup: ['alice', 'bob'], opponent: 'Test FC' } },
    ]);
    hooks.setScoringLineupEditor({ mode: 'edit', draft: ['alice', 'bob'] });
    hooks.openPinSheet(() => {});

    global.window.confirm = () => false;
    hooks.debugClearGameData();
    assert(hooks.getScoringEvents().length === 1, 'declining the confirm leaves the event log untouched');
    assert(hooks.getScoringLineupEditor() !== null, 'declining the confirm leaves an open editor untouched');

    global.window.confirm = () => true;
    hooks.debugClearGameData();
    assert(hooks.getScoringEvents().length === 0, 'confirming wipes the in-memory event log');
    assert(hooks.getScoringState().scoreUs === 0 && hooks.getScoringState().scoreThem === 0,
      'scoringState re-derives to a fresh/empty game after the wipe');
    assert(hooks.getScoringLineupEditor() === null, 'the wipe closes any open lineup editor');
    assert(hooks.getPinSheet() === null, 'the wipe closes any open PIN sheet');
    assert(hooks.getEndGameConfirmOpen() === false, 'the wipe closes any open end-game confirm');

    global.window.confirm = () => true; // restore default
    console.log('57. Debug panel "clear game data": confirm-gated, wipes events + localStorage, closes open overlays: OK');
  }

  // 58. Scorecard out annotations (2026-07-13, Jason): every out -- a
  // FLY/GND/K result AND a basepath/home out on a hit -- gets an
  // outNumberInHalf stamp (1/2/3) for the corner badge, and a basepath
  // out's reachedBase is available to center the X on the actual base
  // instead of the diamond middle.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'X', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: 'FLY', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'bob', result: '1B', inning: 1, half: 'us' });
    ev = hooks.appendScoringEvent(ev, 'runner', { playerId: 'bob', action: 'out' }); // out on the bases, still at 1st
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'charlie', result: 'K', inning: 1, half: 'us' }); // 3rd out
    const st = hooks.deriveState(ev);
    const aliceRec = st.paLog.filter(r => r.playerId === 'alice')[0];
    const bobRec = st.paLog.filter(r => r.playerId === 'bob')[0];
    const charlieRec = st.paLog.filter(r => r.playerId === 'charlie')[0];
    assert(aliceRec.outNumberInHalf === 1, 'alice\'s flyout is the 1st out: ' + aliceRec.outNumberInHalf);
    assert(bobRec.kickerOut === true && bobRec.reachedBase === 1, 'bob is out on the bases, still at 1st: ' + bobRec.reachedBase);
    assert(bobRec.outNumberInHalf === 2, 'bob\'s basepath out is the 2nd out: ' + bobRec.outNumberInHalf);
    assert(charlieRec.outNumberInHalf === 3, 'charlie\'s K is the 3rd out: ' + charlieRec.outNumberInHalf);
    assert(charlieRec.endedHalf === true, 'sanity: 3rd out still flips the half');
    console.log('58. Scorecard out annotations: outNumberInHalf stamped for FLY/GND/K and basepath outs, reachedBase available for X placement: OK');
  }

  // 59. Scorecard/box score only show innings actually reached (2026-07-13,
  // Jason: the game runs on a 50-minute timer, not a fixed inning count) --
  // scorecardColumns/scorecardLayout no longer pad out to
  // manifest.scoring.inningsPerGame with empty future innings.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'X', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    hooks.setScoringEvents(ev);
    const cols = hooks.scorecardColumns();
    const maxColInning = Math.max.apply(null, cols.cols.map(c => c.inning));
    assert(maxColInning === 1, 'only inning 1 has a column while the game is still in inning 1, not padded to 7: ' + maxColInning);
    const L = hooks.scorecardLayout();
    assert(L.innings === 1, 'line-score width is sized to the current inning, not manifest.scoring.inningsPerGame: ' + L.innings);
    console.log('59. Scorecard/box score: only innings actually reached are shown, no padding to inningsPerGame: OK');
  }

  // 60. Scoring auto-play survives a routine baserunner correction, but a
  // correction that actually changes who's up next still invalidates it
  // (2026-07-13, Jason: baserunner edits are routine mid-countdown and
  // shouldn't kill the next batter's music every time, but a real
  // half-flip still must not misfire the stale batter). The safety net
  // moved from "cancel on any correction" to scheduleScoringAutoPlay's own
  // fire-time revalidation against live state.
  {
    let ev = [];
    ev = hooks.appendScoringEvent(ev, 'game_start', { opponent: 'X', innings: 7, lineup: ['alice', 'bob', 'charlie'] });
    ev = hooks.appendScoringEvent(ev, 'pa', { playerId: 'alice', result: '1B', inning: 1, half: 'us' });
    hooks.setScoringEvents(ev);
    hooks.scheduleScoringAutoPlay();
    assert(hooks.getScoringAutoPlayPending() !== null, 'auto-play armed for bob');
    assert(hooks.getScoringAutoPlayPending().batterId === 'bob', 'bob is scheduled next: ' + hooks.getScoringAutoPlayPending().batterId);

    // Routine correction: alice is really on base (1st, from the 1B above)
    // -- advancing her to 2nd doesn't touch the lineup pointer or half.
    hooks.applyRunnerSet('alice', 2);
    assert(hooks.getScoringAutoPlayPending() !== null, 'a routine baserunner correction no longer cancels the pending auto-play');
    assert(hooks.getScoringAutoPlayPending().batterId === 'bob', 'still armed for the same batter after the correction');

    await new Promise((resolve) => setTimeout(resolve, 2100)); // DATA.autoPlayDelayMs is 2000 in the test payload
    assert(hooks.getPlayingId() === 'bob', 'the clip fired for bob exactly as scheduled, unaffected by the routine correction: ' + hooks.getPlayingId());
    hooks.stopCurrent(false);
    console.log('60. Scoring auto-play: routine baserunner correction no longer kills the pending clip, still fires on schedule: OK');
  }

  // Leave scoring's live-game UI state clean for anything appended after
  // this file in the future.
  hooks.getState().editing = true;
  hooks.closeScoringCorrection();
  hooks.setScoringLineupEditor(null);
  hooks.closePinSheet();
  hooks.closeEndGameConfirm();
  hooks.closeAddPlayerSheet();

  console.log('\nALL DOM SMOKE TESTS PASSED');
}

main().catch(e => { console.error('SMOKE TEST FAILED:', e); process.exit(1); });
