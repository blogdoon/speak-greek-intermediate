const REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30];
const WORD_MATCH_THRESHOLD = 0.7;
const PASS_SCORE = 0.8;
const DAY_MS = 86_400_000;
const DAILY_GOAL = 20;

// The recogniser hears standard Greek, so accept common standard forms of Cypriot words.
const CYPRIOT_EQUIVALENTS = {
  τζιαι: ["και"],
  εννα: ["θα"],
  εν: ["δεν", "ειναι", "ενα"],
  ιντα: ["τι"],
  ινταλωσ: ["πωσ"],
  δαμαι: ["εδω"],
  τζιαμαι: ["εκει"],
  νακκον: ["λιγο"],
  πκιο: ["πιο"],
  οι: ["οχι"],
  ουλλοι: ["ολοι"],
  ουλλα: ["ολα"],
  ουλλη: ["ολη"],
  ουλλεσ: ["ολεσ"],
  εσιει: ["εχει"],
  εσιεισ: ["εχεισ"],
  εσιετε: ["εχετε"],
  σημμερα: ["σημερα"],
  ποττε: ["ποτε"],
  αμμα: ["αλλα"],
  τουτο: ["αυτο"],
  τουτη: ["αυτη"],
  τουτοσ: ["αυτοσ"],
  στεσ: ["στισ"],
  τεσ: ["τισ"],
};

function normalizeWord(word) {
  return word
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ς/g, "σ")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

function normalizeWords(text) {
  return text.split(/\s+/).map(normalizeWord).filter(Boolean);
}

function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost));
    }
    prev = row;
  }
  return prev[b.length];
}

function similarity(a, b) {
  const longest = Math.max(a.length, b.length);
  return longest === 0 ? 1 : 1 - editDistance(a, b) / longest;
}

function wordHeard(target, heardWords) {
  const forms = [target, ...(CYPRIOT_EQUIVALENTS[target] ?? [])];
  return heardWords.some((heard) =>
    forms.some((form) => similarity(form, heard) >= WORD_MATCH_THRESHOLD),
  );
}

function scoreAttempt(target, heard) {
  const heardWords = normalizeWords(heard);
  const words = target
    .split(/\s+/)
    .filter(Boolean)
    .map((text) => {
      const norm = normalizeWord(text);
      return { text, ok: !norm || wordHeard(norm, heardWords) };
    });
  const scored = words.filter((w) => normalizeWord(w.text));
  const score = scored.length
    ? scored.filter((w) => w.ok).length / scored.length
    : 0;
  return { score, words, heard };
}

function bestAttempt(target, alternatives) {
  return alternatives
    .map((heard) => scoreAttempt(target, heard))
    .reduce((best, next) => (next.score > best.score ? next : best), {
      score: -1,
    });
}

function hintText(text) {
  return text.replace(/\p{L}+/gu, (w) => w[0] + "_".repeat(w.length - 1));
}

// One string per recognition alternative, joining every final segment.
function finalTranscripts(results) {
  const finals = Array.from(results).filter((r) => r.isFinal);
  if (!finals.length) return [];
  const count = Math.max(...finals.map((r) => r.length));
  return Array.from({ length: count }, (_, i) =>
    finals.map((r) => (r[i] ?? r[0]).transcript.trim()).join(" "),
  );
}

function joinAlternatives(before, after) {
  if (!after.length) return before;
  if (!before.length) return after;
  const count = Math.max(before.length, after.length);
  return Array.from(
    { length: count },
    (_, i) => `${before[i] ?? before[0]} ${after[i] ?? after[0]}`,
  );
}

function dayNumber(now = Date.now()) {
  const offsetMs = new Date(now).getTimezoneOffset() * 60_000;
  return Math.floor((now - offsetMs) / DAY_MS);
}

function scheduleAgain(entry, today) {
  return { ...entry, step: 0, due: today + REVIEW_INTERVALS_DAYS[0] };
}

// Returns null once the line has passed the last interval (learned).
function scheduleKnown(entry, today) {
  const step = entry.step + 1;
  if (step >= REVIEW_INTERVALS_DAYS.length) return null;
  return { ...entry, step, due: today + REVIEW_INTERVALS_DAYS[step] };
}

function todayCount(progress, today) {
  return progress.day === today ? progress.count : 0;
}

// The streak counts days in a row on which the daily goal was reached.
function recordPractice(progress, today, goal = DAILY_GOAL) {
  const count = todayCount(progress, today) + 1;
  if (count < goal || progress.goalDay === today)
    return { ...progress, day: today, count };
  const streak = progress.goalDay === today - 1 ? progress.streak + 1 : 1;
  return { ...progress, day: today, count, streak, goalDay: today };
}

function currentStreak(progress, today) {
  return progress.goalDay >= today - 1 ? progress.streak : 0;
}

if (typeof module !== "undefined") {
  module.exports = {
    PASS_SCORE,
    REVIEW_INTERVALS_DAYS,
    normalizeWord,
    similarity,
    scoreAttempt,
    bestAttempt,
    hintText,
    finalTranscripts,
    joinAlternatives,
    dayNumber,
    scheduleAgain,
    scheduleKnown,
    todayCount,
    recordPractice,
    currentStreak,
  };
}
