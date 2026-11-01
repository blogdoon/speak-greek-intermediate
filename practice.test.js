const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("./practice.js");
const fs = require("node:fs");
const vm = require("node:vm");

function listenerHarness() {
  const timers = new Map();
  let nextTimer = 0;
  class Recognition {
    start() {}
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
    CHECK_MIN_MS: 30000,
    CHECK_MAX_MS: 120000,
    turnMs: (text) => text.length * 100,
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
      source.indexOf("function showResultMessage("),
    ),
    context,
  );
  return { context, timers };
}

test("listener keeps multiple final segments and waits through ongoing speech", async () => {
  const { context, timers } = listenerHarness();
  const attempt = context.recognise(30000);
  const rec = context.listening;
  assert.equal(rec.continuous, true);
  assert.equal(rec.interimResults, true);
  const segment = (text, isFinal) =>
    Object.assign([{ transcript: text }], { isFinal });
  rec.onresult({ results: [segment("first phrase", true)] });
  const firstSilenceTimer = [...timers.keys()].find(
    (timer) => timers.get(timer).ms === 3000,
  );
  rec.onresult({
    results: [segment("first phrase", true), segment("more words", false)],
  });
  assert.equal(timers.has(firstSilenceTimer), false);
  assert.equal(
    [...timers.values()].some(({ ms }) => ms === 3000),
    true,
  );
  assert.equal(rec.stopped, undefined);
  rec.onresult({
    results: [segment("first phrase", true), segment("more words", true)],
  });
  rec.onresult({
    results: [segment("first phrase", true), segment("more words", true)],
  });
  const silence = [...timers.values()].find(({ ms }) => ms === 3000);
  assert.ok(silence);
  silence.callback();
  assert.equal(rec.stopped, true);
  rec.onend();
  assert.equal((await attempt).heard[0], "first phrase more words");
  assert.equal(timers.size, 0);
});

test("listener cancellation clears timers and does not clear a newer listener", async () => {
  const { context, timers } = listenerHarness();
  const attempt = context.recognise(30000);
  const rec = context.listening;
  context.stopListening();
  assert.equal(rec.aborted, true);
  const newer = context.recognise(30000);
  const active = context.listening;
  rec.onerror({ error: "aborted" });
  rec.onend();
  assert.equal((await attempt).error, "aborted");
  assert.equal(context.listening, active);
  active.onend();
  await newer;
  assert.equal(timers.size, 0);
});

test("listening budget grows with sentence length and stays bounded", () => {
  const { context } = listenerHarness();
  assert.equal(context.listeningMs("short"), 30000);
  assert.equal(context.listeningMs("word ".repeat(50)), 50000);
  assert.equal(context.listeningMs("word ".repeat(200)), 120000);
});

test("listener deadline accepts the last result and preserves repeated words", async () => {
  const { context, timers } = listenerHarness();
  const attempt = context.recognise(50000);
  const rec = context.listening;
  const deadline = [...timers.values()].find(({ ms }) => ms === 50000);
  assert.ok(deadline);
  deadline.callback();
  assert.equal(rec.stopped, true);
  const phrase = Object.assign(
    [{ transcript: "same words" }, { transcript: "alternate words" }],
    { isFinal: true },
  );
  rec.onresult({ results: [phrase, phrase] });
  rec.onend();
  assert.deepEqual(Array.from((await attempt).heard), [
    "same words same words",
    "alternate words alternate words",
  ]);
  assert.equal(timers.size, 0);
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
