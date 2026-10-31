const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("./practice.js");

test("normalizeWord strips accents, punctuation and final sigma", () => {
  assert.equal(p.normalizeWord("Ίνταλως;"), "ινταλωσ");
  assert.equal(p.normalizeWord("«ααα»."), "ααα");
});

test("scoreAttempt gives full score for an exact attempt", () => {
  const r = p.scoreAttempt("Καλημέρα κυρία Μαρούλλα.", "καλημέρα κυρία μαρούλα");
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
