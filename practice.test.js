const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("./practice.js");
const fs = require("node:fs");
const vm = require("node:vm");

function listenerHarness() {
  const timers = new Map();
  let nextTimer = 0;
  class Recognition {
    starts = 0;
    start() {
      this.starts += 1;
    }
    stop() {
      this.stopped = true;
    }
    abort() {
      this.aborted = true;
    }
  }
  const context = vm.createContext({
    Recognition,
    listening: null,
    CHECK_MAX_MS: 120000,
    FATAL_RECOGNITION_ERRORS: new Set(["not-allowed"]),
    finalTranscripts: p.finalTranscripts,
    joinAlternatives: p.joinAlternatives,
    setTimeout(callback, ms) {
      timers.set(++nextTimer, { callback, ms });
      return nextTimer;
    },
    clearTimeout(timer) {
      timers.delete(timer);
    },
  });
  const source = fs.readFileSync(`${__dirname}/app.js`, "utf8");
  vm.runInContext(
    source.slice(
      source.indexOf("function stopListening()"),
      source.indexOf("async function listenAt("),
    ),
    context,
  );
  return { context, timers };
}

const finalSegment = (...alternatives) =>
  Object.assign(
    alternatives.map((transcript) => ({ transcript })),
    { isFinal: true },
  );

test("listening keeps going after the browser stops, until the user finishes", async () => {
  const { context, timers } = listenerHarness();
  const attempt = context.recognise("item");
  const session = context.listening;
  const { rec } = session;
  assert.equal(rec.continuous, true);
  rec.onresult({ results: [finalSegment("first part")] });
  rec.onerror({ error: "no-speech" });
  rec.onend();
  assert.equal(rec.starts, 2);
  assert.equal(context.listening, session);
  rec.onresult({ results: [finalSegment("second part")] });
  context.finishListening();
  assert.equal(rec.stopped, true);
  rec.onend();
  assert.equal(rec.starts, 2);
  assert.deepEqual(Array.from((await attempt).heard), [
    "first part second part",
  ]);
  assert.equal(context.listening, null);
  assert.equal(timers.size, 0);
});

test("listening stops on a fatal error or after the safety limit", async () => {
  const { context, timers } = listenerHarness();
  const denied = context.recognise("a");
  context.listening.rec.onerror({ error: "not-allowed" });
  context.listening.rec.onend();
  assert.equal((await denied).error, "not-allowed");

  const long = context.recognise("b");
  const { rec } = context.listening;
  [...timers.values()].find(({ ms }) => ms === 120000).callback();
  assert.equal(rec.stopped, true);
  rec.onend();
  assert.equal((await long).error, "no-speech");
  assert.equal(timers.size, 0);
});

test("cancelling does not clear a newer listener", async () => {
  const { context, timers } = listenerHarness();
  const attempt = context.recognise("a");
  const { rec } = context.listening;
  context.stopListening();
  assert.equal(rec.aborted, true);
  const newer = context.recognise("b");
  const active = context.listening;
  rec.onend();
  assert.equal((await attempt).error, "aborted");
  assert.equal(context.listening, active);
  context.finishListening();
  active.rec.onend();
  await newer;
  assert.equal(timers.size, 0);
});

test("finalTranscripts joins final segments per alternative and skips interim", () => {
  const interim = Object.assign([{ transcript: "maybe" }], { isFinal: false });
  assert.deepEqual(
    p.finalTranscripts([finalSegment("a", "x"), finalSegment("b"), interim]),
    ["a b", "x b"],
  );
  assert.deepEqual(p.finalTranscripts([interim]), []);
});

test("joinAlternatives appends later speech to earlier speech", () => {
  assert.deepEqual(p.joinAlternatives([], ["b"]), ["b"]);
  assert.deepEqual(p.joinAlternatives(["a", "x"], []), ["a", "x"]);
  assert.deepEqual(p.joinAlternatives(["a", "x"], ["b"]), ["a b", "x b"]);
});

test("normalizeWord strips accents, punctuation and final sigma", () => {
  assert.equal(p.normalizeWord("Ίνταλως;"), "ινταλωσ");
  assert.equal(p.normalizeWord("«ααα»."), "ααα");
});

test("scoreAttempt gives full score for an exact attempt", () => {
  const r = p.scoreAttempt(
    "Καλημέρα κυρία Μαρούλλα.",
    "καλημέρα κυρία μαρούλα",
  );
  assert.equal(r.score, 1);
});

test("scoreAttempt accepts standard Greek for Cypriot words", () => {
  const r = p.scoreAttempt("Ίντα κάμνεις τζιαι εσού;", "τι κάμνεις και εσύ");
  assert.equal(r.score, 1);
});

test("scoreAttempt marks missing words", () => {
  const r = p.scoreAttempt("Δώσ' μου δκυό κιλά.", "δώσε μου");
  assert.deepEqual(
    r.words.map((w) => w.ok),
    [true, true, false, false],
  );
  assert.equal(r.score, 0.5);
});

test("bestAttempt picks the highest scoring alternative", () => {
  const r = p.bestAttempt("Πολλά καλά", ["πόλη", "πολλά καλά"]);
  assert.equal(r.heard, "πολλά καλά");
});

test("hintText keeps first letters and punctuation", () => {
  assert.equal(p.hintText("Γεια σας!"), "Γ___ σ__!");
});

test("review scheduling moves through intervals then retires", () => {
  const today = 100;
  let entry = p.scheduleAgain({ key: "k", step: 3, due: 0 }, today);
  assert.deepEqual([entry.step, entry.due], [0, 101]);
  entry = p.scheduleKnown(entry, today);
  assert.deepEqual([entry.step, entry.due], [1, 103]);
  const last = { key: "k", step: p.REVIEW_INTERVALS_DAYS.length - 1, due: 0 };
  assert.equal(p.scheduleKnown(last, today), null);
});

const EMPTY = { day: null, count: 0, streak: 0, goalDay: null };

test("recordPractice resets the count on a new day", () => {
  const yesterday = p.recordPractice(EMPTY, 10, 3);
  const today = p.recordPractice(yesterday, 11, 3);
  assert.equal(p.todayCount(today, 11), 1);
  assert.equal(p.todayCount(today, 12), 0);
});

test("streak grows on consecutive goal days and breaks after a gap", () => {
  const reach = (progress, day) =>
    [1, 2].reduce((acc) => p.recordPractice(acc, day, 2), progress);
  let progress = reach(EMPTY, 10);
  assert.equal(p.currentStreak(progress, 10), 1);
  progress = reach(progress, 11);
  assert.equal(p.currentStreak(progress, 11), 2);
  assert.equal(p.currentStreak(progress, 12), 2);
  assert.equal(p.currentStreak(progress, 13), 0);
  progress = reach(progress, 13);
  assert.equal(p.currentStreak(progress, 13), 1);
});

test("going past the goal does not add to the streak twice", () => {
  const progress = [1, 2, 3, 4].reduce(
    (acc) => p.recordPractice(acc, 10, 2),
    EMPTY,
  );
  assert.deepEqual([progress.count, progress.streak], [4, 1]);
});
