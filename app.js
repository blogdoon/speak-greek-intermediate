const $ = (selector) => document.querySelector(selector);

const SETTINGS_KEY = "skg-settings";
const DONE_KEY = "skg-done";
const REVIEW_KEY = "skg-review";
const FADE_KEY = "skg-fade";
const PROGRESS_KEY = "skg-progress";
const REVIEW_ID = "review";
const NICOS = "Νίκος";
const FADE_LABELS = ["Κείμενο: Όλο", "Κείμενο: Αρχικά", "Κείμενο: Κρυφό"];
const MAX_FADE = FADE_LABELS.length - 1;
const LINE_GAP_MS = 600;
const SHADOW_GAP_MS = 250;
const COMPARE_GAP_MS = 400;
const CHECK_MIN_MS = 30000;
const CHECK_MAX_MS = 120000;
const RECORD_MAX_MS = 15000;
const MIN_TURN_MS = 1200;
const MS_PER_CHAR = 70;
const VOICE_SAMPLE = "Καλημέρα! Ίντα μου κάμνεις;";

const MODES = {
  listen: { label: "Άκου", hint: "Listen: every line is read in Greek." },
  repeat: {
    label: "Επανάλαβε",
    hint: "Repeat: after each line, say it back out loud.",
  },
  shadow: {
    label: "Σκιά",
    hint: "Shadow: speak along with the voice, at the same time. No pauses.",
  },
  role: {
    label: "Παίξε ρόλο",
    hint: "Role-play: pick who you are. Say your lines when it is your turn; the phone plays everyone else, then the correct line.",
  },
  recall: {
    label: "Θυμήσου",
    hint: "Recall: hear English, say it in Greek, then hear the Greek.",
  },
};

const settings = {
  mode: "listen",
  rate: 0.9,
  pause: 1.5,
  showText: false,
  voiceEl: "",
  roles: {},
  ...readJson(SETTINGS_KEY, {}),
};
if (settings.mode === "nicos") settings.mode = "role";
const done = new Set(readJson(DONE_KEY, []));
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
const canRecord = Boolean(
  window.MediaRecorder && navigator.mediaDevices?.getUserMedia,
);
const recordings = new Map();

let reviews = readJson(REVIEW_KEY, {});
let fade = readJson(FADE_KEY, {});
let progress = readJson(PROGRESS_KEY, {
  day: null,
  count: 0,
  streak: 0,
  goalDay: null,
});
let listening = null;
let recording = null;
let playback = null;
let lessons = [];
let current = null;
let index = 0;
let runId = 0;
let isPlaying = false;
let voices = { el: null, en: null };
let wakeLock = null;

function readJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function h(tag, props = {}) {
  return Object.assign(document.createElement(tag), props);
}

/* ---------- Markdown parsing ---------- */

function cleanText(text) {
  return text.replace(/\\_/g, "_").replace(/\*\*/g, "").trim();
}

function parseRow(line) {
  return line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

function parseMarkdown(md) {
  const doc = { title: "", sections: [] };
  let section = null;
  const addLine = (line) => {
    if (!section) {
      section = { title: doc.title, lines: [] };
      doc.sections.push(section);
    }
    section.lines.push(line);
  };

  for (const line of md.split(/\r?\n/).map((l) => l.trim())) {
    if (line.startsWith("# ")) {
      doc.title = line.slice(2).trim();
    } else if (line.startsWith("## ")) {
      section = { title: line.slice(3).trim(), lines: [] };
      doc.sections.push(section);
    } else if (/^\*\*(.+?):\*\*/.test(line)) {
      const [, speaker, text] = line.match(/^\*\*(.+?):\*\*\s*(.*)$/);
      addLine({ speaker, el: cleanText(text), en: "" });
    } else if (line.startsWith("|") && line.endsWith("|")) {
      const cells = parseRow(line);
      const isHeader =
        cells.includes("Κυπριακά") || cells.every((c) => /^:?-+:?$/.test(c));
      if (isHeader) continue;
      const [speaker, el, en] = cells.length >= 3 ? cells : ["", ...cells];
      addLine({ speaker, el: cleanText(el), en: cleanText(en ?? "") });
    } else if (/^- (?!.*\\_)/.test(line)) {
      addLine({
        speaker: "",
        el: cleanText(line.replace(/^- (\[[ xX]\] )?/, "")),
        en: "",
      });
    }
  }
  doc.sections = doc.sections.filter((s) => s.lines.length > 0);
  return doc;
}

async function loadLibrary() {
  const docs = await Promise.all(
    LIBRARY.flatMap((group) =>
      group.files.map(async (file) => {
        const res = await fetch(file);
        if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
        return { group, file, doc: parseMarkdown(await res.text()) };
      }),
    ),
  );
  return docs.flatMap(({ group, file, doc }) =>
    doc.sections.map((s, i) => ({
      id: `${file}#${i}`,
      group: group.id,
      title: s.title,
      lines: s.lines.map((line) => ({
        ...line,
        key: `${file}#${i}::${line.el}`,
      })),
    })),
  );
}

/* ---------- Speech ---------- */

function pickVoices() {
  const all = speechSynthesis.getVoices();
  const byLang = (re) => all.find((v) => re.test(v.lang));
  const greek = all.filter((v) => /^el/i.test(v.lang));
  voices = {
    el: greek.find((v) => v.voiceURI === settings.voiceEl) ?? greek[0],
    en: byLang(/^en[-_]gb/i) ?? byLang(/^en/i),
  };
  $("#voice-warning").hidden = all.length === 0 || Boolean(voices.el);
  $("#voice-label").hidden = greek.length < 2;
  $("#voice").replaceChildren(
    ...greek.map((v) => {
      const option = h("option", { value: v.voiceURI, textContent: v.name });
      option.selected = v === voices.el;
      return option;
    }),
  );
}

function speechText(text) {
  return text.replace(/[«»]/g, "").replace(/\s\/\s/g, ", ");
}

function speak(text, lang, id) {
  return new Promise((resolve) => {
    if (id !== runId) return resolve(0);
    const utterance = new SpeechSynthesisUtterance(speechText(text));
    const voice = voices[lang];
    if (voice) utterance.voice = voice;
    utterance.lang = voice?.lang ?? (lang === "el" ? "el-GR" : "en-GB");
    utterance.rate = settings.rate;
    const start = performance.now();
    utterance.onend = utterance.onerror = () =>
      resolve(performance.now() - start);
    speechSynthesis.speak(utterance);
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function turnMs(text) {
  return (
    Math.max(MIN_TURN_MS, (text.length * MS_PER_CHAR) / settings.rate) *
    settings.pause
  );
}

function isYourLine(line) {
  const mode = activeMode();
  return (
    (mode === "recall" && Boolean(line.en)) ||
    (mode === "role" && line.speaker === roleFor(current))
  );
}

async function yourTurn(line, id) {
  const item = $("#lines").children[index];
  const ms = turnMs(line.el);
  if (activeMode() !== "role" || !Recognition) return wait(ms);
  showResultMessage(item, "Είναι η σειρά σου…", "listening");
  const [outcome] = await Promise.all([
    recognise(listeningMs(line.el)),
    wait(ms),
  ]);
  if (id === runId) showOutcome(line, item, outcome);
  else item.querySelector(".result").hidden = true;
}

async function playLine(line, id) {
  const mode = activeMode();

  if (isYourLine(line)) {
    if (mode === "recall") await speak(line.en, "en", id);
    if (id !== runId) return;
    await yourTurn(line, id);
    if (id !== runId) return;
  }

  reveal(index);
  const spokenMs = await speak(line.el, "el", id);
  const gapMs = {
    repeat: spokenMs * settings.pause + LINE_GAP_MS,
    shadow: SHADOW_GAP_MS,
  };
  await wait(gapMs[mode] ?? LINE_GAP_MS);
}

async function play() {
  if (!current) return;
  const id = ++runId;
  speechSynthesis.cancel();
  setPlaying(true);
  while (index < current.lines.length) {
    setActive(index);
    await playLine(current.lines[index], id);
    if (id !== runId) return;
    countPractice();
    index += 1;
  }
  markDone(current.id);
  index = 0;
  setActive(-1);
  setPlaying(false);
}

function stop() {
  runId += 1;
  speechSynthesis.cancel();
  stopListening();
  stopRecording();
  playback?.pause();
  playback = null;
  setPlaying(false);
}

function jump(delta) {
  if (!current) return;
  const wasPlaying = isPlaying;
  stop();
  index = Math.min(Math.max(index + delta, 0), current.lines.length - 1);
  setActive(index);
  if (wasPlaying) play();
}

async function holdScreen(on) {
  // Keeping the screen on is best-effort; playback works without it.
  try {
    if (on && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => {
        wakeLock = null;
      });
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    wakeLock = null;
  }
}

function setPlaying(on) {
  isPlaying = on;
  const button = $("#play");
  button.textContent = on ? "❚❚" : "▶";
  button.setAttribute("aria-label", on ? "Pause" : "Play");
  holdScreen(on);
}

/* ---------- Lesson view ---------- */

function speakers(lesson) {
  return [...new Set(lesson.lines.map((l) => l.speaker).filter(Boolean))];
}

function roleFor(lesson) {
  const names = speakers(lesson);
  const saved = settings.roles[lesson.id];
  if (names.includes(saved)) return saved;
  return names.includes(NICOS) ? NICOS : names[0];
}

function setRole(name) {
  stop();
  settings.roles = { ...settings.roles, [current.id]: name };
  saveSettings();
  renderModes();
  applyConcealment();
}

function availableModes(lesson) {
  const modes = ["listen", "repeat", "shadow"];
  if (speakers(lesson).length > 0) modes.push("role");
  if (lesson.lines.some((l) => l.en)) modes.push("recall");
  return modes;
}

function activeMode() {
  return current && availableModes(current).includes(settings.mode)
    ? settings.mode
    : "listen";
}

function isConcealed(line) {
  return !settings.showText && isYourLine(line);
}

function renderModes() {
  const mode = activeMode();
  $("#modes").replaceChildren(
    ...availableModes(current).map((key) => {
      const button = h("button", {
        type: "button",
        className: "mode",
        textContent: MODES[key].label,
      });
      button.setAttribute("aria-pressed", String(key === mode));
      button.addEventListener("click", () => setMode(key));
      return button;
    }),
  );
  const role = roleFor(current);
  $("#roles").hidden = mode !== "role";
  $("#roles").replaceChildren(
    ...speakers(current).map((name) => {
      const button = h("button", {
        type: "button",
        className: "role",
        textContent: name,
      });
      button.setAttribute("aria-pressed", String(name === role));
      button.addEventListener("click", () => setRole(name));
      return button;
    }),
  );
  $("#mode-hint").textContent = MODES[mode].hint;
}

function lineItem(line, i) {
  const item = h("li", { className: "line" });
  if (line.speaker)
    item.append(h("span", { className: "speaker", textContent: line.speaker }));
  item.append(
    h("span", { className: "el", lang: "el", textContent: line.el }),
    h("span", {
      className: "el-hint",
      lang: "el",
      textContent: hintText(line.el),
    }),
  );
  if (line.en)
    item.append(
      h("span", { className: "en", lang: "en", textContent: line.en }),
    );
  item.append(
    lineActions(line, item),
    h("div", { className: "result", hidden: true }),
  );
  item.addEventListener("click", () => {
    stop();
    index = i;
    play();
  });
  return item;
}

function actionButton(text, label, onClick) {
  const button = h("button", {
    type: "button",
    className: "line-btn",
    textContent: text,
    title: label,
  });
  button.setAttribute("aria-label", label);
  button.addEventListener("click", onClick);
  return button;
}

function lineActions(line, item) {
  const bar = h("div", { className: "line-actions" });
  bar.addEventListener("click", (e) => e.stopPropagation());
  if (Recognition)
    bar.append(
      actionButton("Πε το", "Say it and check pronunciation", () =>
        checkLine(line, item),
      ),
    );
  if (canRecord) {
    const compareBtn = actionButton(
      "Σύγκρινε",
      "Play the voice, then your recording",
      () => compare(line),
    );
    compareBtn.hidden = !recordings.has(line.key);
    const recordBtn = actionButton("Γράψε", "Record yourself saying it", () =>
      toggleRecording(line, recordBtn, compareBtn),
    );
    bar.append(recordBtn, compareBtn);
  }
  if (current.id === REVIEW_ID) {
    bar.append(
      actionButton("Ξανά", "Still hard: review again tomorrow", () =>
        gradeReview(line, item, false),
      ),
      actionButton("Το ξέρω", "I know it: review later", () =>
        gradeReview(line, item, true),
      ),
    );
  } else {
    const star = actionButton("★", "Add to daily review", () =>
      toggleReview(line, star),
    );
    star.classList.add("star");
    star.setAttribute("aria-pressed", String(line.key in reviews));
    bar.append(star);
  }
  return bar;
}

function fadeLevel() {
  return current.id === REVIEW_ID ? 0 : (fade[current.id] ?? 0);
}

function setFade(id, level) {
  fade = { ...fade, [id]: level };
  localStorage.setItem(FADE_KEY, JSON.stringify(fade));
}

function applyConcealment() {
  const level = settings.showText ? 0 : fadeLevel();
  const you = roleFor(current);
  [...$("#lines").children].forEach((item, i) => {
    const concealed = isConcealed(current.lines[i]);
    item.classList.toggle("mine", current.lines[i].speaker === you);
    item.classList.toggle("concealed", concealed);
    item.classList.toggle("fade-hints", !concealed && level === 1);
    item.classList.toggle("fade-hidden", !concealed && level === 2);
    item.classList.remove("revealed");
  });
  $("#fade").textContent = FADE_LABELS[fadeLevel()];
  $("#fade").hidden = current.id === REVIEW_ID;
}

function renderLesson(lesson) {
  current = lesson;
  index = 0;
  $("#page-title").textContent = lesson.title;
  $("#lines").replaceChildren(...lesson.lines.map(lineItem));
  renderModes();
  applyConcealment();
}

/* ---------- Pronunciation check ---------- */

function stopListening() {
  listening?.abort();
  listening = null;
}

function listeningMs(text) {
  return Math.min(CHECK_MAX_MS, Math.max(CHECK_MIN_MS, turnMs(text) * 2));
}

// Resolves with { heard: [...] } or { error }; never rejects.
function recognise(maxMs) {
  return new Promise((resolve) => {
    const rec = new Recognition();
    rec.lang = "el-GR";
    rec.maxAlternatives = 5;
    rec.continuous = true;
    rec.interimResults = true;
    let outcome = { error: "no-speech" };
    let silenceTimer;
    const silenceMs = 3000;
    const timer = setTimeout(() => rec.stop(), maxMs);
    rec.onresult = (e) => {
      clearTimeout(silenceTimer);
      const finals = Array.from(e.results).filter((result) => result.isFinal);
      if (finals.length) {
        const alternatives = Math.max(...finals.map((result) => result.length));
        outcome = {
          heard: Array.from({ length: alternatives }, (_, alternative) =>
            finals
              .map((result) =>
                (result[alternative] ?? result[0]).transcript.trim(),
              )
              .join(" "),
          ),
        };
      }
      silenceTimer = setTimeout(() => rec.stop(), silenceMs);
    };
    rec.onerror = (e) => {
      outcome = { error: e.error };
    };
    rec.onend = () => {
      clearTimeout(timer);
      clearTimeout(silenceTimer);
      if (listening === rec) listening = null;
      resolve(outcome);
    };
    listening = rec;
    try {
      rec.start();
    } catch {
      outcome = { error: "not-allowed" };
      rec.onend();
    }
  });
}

function showResultMessage(item, text, kind) {
  const box = item.querySelector(".result");
  box.hidden = false;
  box.className = `result ${kind}`;
  box.textContent = text;
}

function showScore(item, result) {
  const box = item.querySelector(".result");
  box.hidden = false;
  box.className = `result ${result.score >= PASS_SCORE ? "pass" : "fail"}`;
  const words = h("span", { className: "words", lang: "el" });
  for (const word of result.words)
    words.append(
      h("span", { className: word.ok ? "" : "miss", textContent: word.text }),
      " ",
    );
  box.replaceChildren(
    h("strong", { textContent: `${Math.round(result.score * 100)}%` }),
    words,
    h("small", { lang: "el", textContent: `Άκουσα: ${result.heard}` }),
  );
}

function recognitionErrorText(error) {
  if (error === "not-allowed" || error === "service-not-allowed")
    return "Allow microphone access to check your pronunciation.";
  if (error === "network")
    return "The pronunciation check needs an internet connection.";
  if (error === "no-speech") return "Δεν άκουσα τίποτε. Try again.";
  return "Δεν άκουσα καλά. Try again.";
}

function showOutcome(line, item, outcome) {
  if (outcome.error) {
    showResultMessage(item, recognitionErrorText(outcome.error), "error");
    return;
  }
  const result = bestAttempt(line.el, outcome.heard);
  showScore(item, result);
  if (result.score < PASS_SCORE && current?.id !== REVIEW_ID) {
    addReview(line);
    item.querySelector(".star")?.setAttribute("aria-pressed", "true");
  }
}

async function checkLine(line, item) {
  stop();
  const id = runId;
  showResultMessage(item, "Ακούω… πε τη φράση.", "listening");
  const outcome = await recognise(listeningMs(line.el));
  if (id !== runId) {
    item.querySelector(".result").hidden = true;
    return;
  }
  showOutcome(line, item, outcome);
  if (!outcome.error) countPractice();
}

/* ---------- Record and compare ---------- */

function stopRecording(thenCompare = false) {
  if (recording?.recorder.state !== "recording") return;
  recording.thenCompare = thenCompare;
  recording.recorder.stop();
}

async function toggleRecording(line, recordBtn, compareBtn) {
  if (recording?.button === recordBtn) {
    stopRecording(true);
    return;
  }
  stop();
  const id = runId;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    recordBtn.textContent = "Χωρίς μικρόφωνο";
    return;
  }
  if (id !== runId) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }
  const recorder = new MediaRecorder(stream);
  const session = { recorder, button: recordBtn, thenCompare: false };
  const chunks = [];
  const timer = setTimeout(() => stopRecording(true), RECORD_MAX_MS);
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = () => {
    clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    if (recording === session) recording = null;
    recordBtn.textContent = "Γράψε";
    recordBtn.setAttribute("aria-pressed", "false");
    URL.revokeObjectURL(recordings.get(line.key));
    const blob = new Blob(chunks, { type: recorder.mimeType });
    recordings.set(line.key, URL.createObjectURL(blob));
    compareBtn.hidden = false;
    if (!session.thenCompare) return;
    countPractice();
    compare(line);
  };
  recording = session;
  recordBtn.textContent = "Σταμάτα";
  recordBtn.setAttribute("aria-pressed", "true");
  recorder.start();
}

async function compare(line) {
  stop();
  const id = runId;
  await speak(line.el, "el", id);
  await wait(COMPARE_GAP_MS);
  if (id !== runId || !recordings.has(line.key)) return;
  playback = new Audio(recordings.get(line.key));
  // A rejected play() only means the user moved on; nothing to report.
  playback.play().catch(() => {});
}

/* ---------- Daily goal ---------- */

function countPractice() {
  progress = recordPractice(progress, dayNumber());
  localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  renderGoal();
}

function renderGoal() {
  const count = todayCount(progress, dayNumber());
  const goal = $("#goal");
  goal.textContent = `${Math.min(count, DAILY_GOAL)}/${DAILY_GOAL}`;
  goal.classList.toggle("met", count >= DAILY_GOAL);
  goal.setAttribute(
    "aria-label",
    `Today: ${count} of ${DAILY_GOAL} lines practised`,
  );
}

function goalCard() {
  const today = dayNumber();
  const count = todayCount(progress, today);
  const streak = currentStreak(progress, today);
  const card = h("div", { className: "goal-card" });
  const bar = h("progress", {
    max: DAILY_GOAL,
    value: Math.min(count, DAILY_GOAL),
  });
  bar.setAttribute("aria-label", "Daily goal");
  card.append(
    h("span", {
      className: "goal-title",
      textContent: streak === 1 ? "Σερί: 1 μέρα" : `Σερί: ${streak} μέρες`,
    }),
    bar,
    h("span", {
      className: "goal-meta",
      textContent:
        count >= DAILY_GOAL
          ? `Goal reached today · ${count} lines`
          : `${count} of ${DAILY_GOAL} lines today`,
    }),
  );
  return card;
}

/* ---------- Daily review ---------- */

function setReview(key, entry) {
  const { [key]: _removed, ...rest } = reviews;
  reviews = entry ? { ...rest, [key]: entry } : rest;
  localStorage.setItem(REVIEW_KEY, JSON.stringify(reviews));
}

function addReview(line) {
  if (line.key in reviews) return;
  const { speaker, el, en } = line;
  setReview(line.key, {
    key: line.key,
    line: { speaker, el, en },
    step: 0,
    due: dayNumber(),
  });
}

function toggleReview(line, button) {
  if (line.key in reviews) setReview(line.key, null);
  else addReview(line);
  button.setAttribute("aria-pressed", String(line.key in reviews));
}

function gradeReview(line, item, known) {
  const entry = reviews[line.key];
  if (!entry) return;
  const today = dayNumber();
  const next = known
    ? scheduleKnown(entry, today)
    : scheduleAgain(entry, today);
  setReview(line.key, next);
  countPractice();
  const days = next ? next.due - today : 0;
  const note = !next
    ? "Το έμαθες!"
    : days === 1
      ? "Ξανά αύριο"
      : `Ξανά σε ${days} μέρες`;
  item.classList.add("graded");
  item
    .querySelector(".line-actions")
    .replaceChildren(
      h("span", { className: "graded-note", textContent: note }),
    );
}

function dueReviews() {
  const today = dayNumber();
  return Object.values(reviews)
    .filter((entry) => entry.due <= today)
    .sort((a, b) => a.due - b.due);
}

function reviewLesson() {
  const due = dueReviews();
  if (!due.length) return null;
  return {
    id: REVIEW_ID,
    group: REVIEW_ID,
    title: "Επανάληψη",
    lines: due.map((entry) => ({ ...entry.line, key: entry.key })),
  };
}

function setMode(mode) {
  stop();
  settings.mode = mode;
  saveSettings();
  renderModes();
  applyConcealment();
}

function setActive(i) {
  [...$("#lines").children].forEach((item, n) =>
    item.classList.toggle("active", n === i),
  );
  $("#lines").children[i]?.scrollIntoView({
    block: "center",
    behavior: "smooth",
  });
}

function reveal(i) {
  $("#lines").children[i]?.classList.add("revealed");
}

function markDone(id) {
  if (id === REVIEW_ID) return;
  done.add(id);
  localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
  setFade(id, Math.min((fade[id] ?? 0) + 1, MAX_FADE));
  applyConcealment();
}

/* ---------- Home view ---------- */

function lessonLink(lesson) {
  const link = h("a", {
    href: `#lesson=${encodeURIComponent(lesson.id)}`,
    className: done.has(lesson.id) ? "lesson done" : "lesson",
  });
  link.append(
    h("span", { className: "lesson-title", textContent: lesson.title }),
    h("span", {
      className: "lesson-meta",
      textContent: String(lesson.lines.length),
    }),
  );
  const item = h("li");
  item.append(link);
  return item;
}

function reviewCard() {
  const queued = Object.keys(reviews).length;
  if (!queued) return null;
  const due = dueReviews().length;
  const card = h(due ? "a" : "div", {
    className: due ? "review-card" : "review-card idle",
  });
  if (due) card.href = `#lesson=${REVIEW_ID}`;
  card.append(
    h("span", { className: "review-title", textContent: "Επανάληψη σήμερα" }),
    h("span", {
      className: "review-meta",
      textContent: due
        ? `${due} to review`
        : `Nothing due today · ${queued} in queue`,
    }),
  );
  return card;
}

function renderHome() {
  $("#page-title").textContent = "Κυπριακά";
  const card = reviewCard();
  $("#home").replaceChildren(
    goalCard(),
    ...(card ? [card] : []),
    ...LIBRARY.map((group) => {
      const section = h("section", { className: `group group-${group.id}` });
      const list = h("ul", { className: "lesson-list" });
      list.append(
        ...lessons.filter((l) => l.group === group.id).map(lessonLink),
      );
      section.append(
        h("h2", { textContent: group.title }),
        h("p", { className: "subtitle", textContent: group.subtitle }),
        list,
      );
      return section;
    }),
  );
}

function route() {
  stop();
  const id = new URLSearchParams(location.hash.slice(1)).get("lesson");
  const lesson =
    id === REVIEW_ID ? reviewLesson() : lessons.find((l) => l.id === id);
  for (const selector of ["#lesson", "#player", "#back"])
    $(selector).hidden = !lesson;
  $("#home").hidden = Boolean(lesson);
  if (lesson) renderLesson(lesson);
  else {
    current = null;
    renderHome();
  }
  window.scrollTo(0, 0);
}

/* ---------- Settings & startup ---------- */

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function syncSettingsUi() {
  $("#rate").value = settings.rate;
  $("#rate-out").textContent = `${Number(settings.rate).toFixed(2)}×`;
  $("#pause").value = settings.pause;
  $("#pause-out").textContent = `${Number(settings.pause).toFixed(2)}×`;
  $("#show-text").checked = settings.showText;
}

function bindControls() {
  $("#back").addEventListener("click", () => history.back());
  $("#play").addEventListener("click", () => (isPlaying ? stop() : play()));
  $("#prev").addEventListener("click", () => jump(-1));
  $("#next").addEventListener("click", () => jump(1));
  $("#fade").addEventListener("click", () => {
    stop();
    setFade(current.id, (fadeLevel() + 1) % FADE_LABELS.length);
    applyConcealment();
  });
  $("#rate").addEventListener("input", (e) => {
    settings.rate = Number(e.target.value);
    saveSettings();
    syncSettingsUi();
  });
  $("#pause").addEventListener("input", (e) => {
    settings.pause = Number(e.target.value);
    saveSettings();
    syncSettingsUi();
  });
  $("#show-text").addEventListener("change", (e) => {
    settings.showText = e.target.checked;
    saveSettings();
    applyConcealment();
  });
  $("#voice").addEventListener("change", (e) => {
    settings.voiceEl = e.target.value;
    saveSettings();
    pickVoices();
    stop();
    speak(VOICE_SAMPLE, "el", runId);
  });
  syncSettingsUi();
  renderGoal();
}

function showLoadError(err) {
  const message = h("p", { className: "warning" });
  message.textContent = `Could not load lessons (${err.message}). Open the app from a web server or GitHub Pages, not as a local file.`;
  $("#home").replaceChildren(message);
}

async function init() {
  bindControls();
  pickVoices();
  speechSynthesis.addEventListener("voiceschanged", pickVoices);
  try {
    lessons = await loadLibrary();
  } catch (err) {
    showLoadError(err);
    return;
  }
  route();
  window.addEventListener("hashchange", route);
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js");
  }
}

init();
