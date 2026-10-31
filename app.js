const $ = (selector) => document.querySelector(selector);

const SETTINGS_KEY = "skg-settings";
const DONE_KEY = "skg-done";
const NICOS = "Νίκος";
const LINE_GAP_MS = 600;
const MIN_TURN_MS = 1200;
const MS_PER_CHAR = 70;

const MODES = {
  listen: { label: "Άκου", hint: "Listen: every line is read in Greek." },
  repeat: {
    label: "Επανάλαβε",
    hint: "Repeat: after each line, say it back out loud.",
  },
  nicos: {
    label: "Είσαι ο Νίκος",
    hint: "Be Nicos: the phone is the other person. Say Nicos’s lines yourself; then you hear the correct line.",
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
  ...readJson(SETTINGS_KEY, {}),
};
const done = new Set(readJson(DONE_KEY, []));

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
      lines: s.lines,
    })),
  );
}

/* ---------- Speech ---------- */

function pickVoices() {
  const all = speechSynthesis.getVoices();
  const byLang = (re) => all.find((v) => re.test(v.lang));
  voices = { el: byLang(/^el/i), en: byLang(/^en[-_]gb/i) ?? byLang(/^en/i) };
  $("#voice-warning").hidden = all.length === 0 || Boolean(voices.el);
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

async function playLine(line, id) {
  const mode = activeMode();
  const isYourTurn =
    (mode === "recall" && line.en) ||
    (mode === "nicos" && line.speaker === NICOS);

  if (isYourTurn) {
    if (mode === "recall") await speak(line.en, "en", id);
    if (id !== runId) return;
    await wait(turnMs(line.el));
    if (id !== runId) return;
  }

  reveal(index);
  const spokenMs = await speak(line.el, "el", id);
  await wait(
    mode === "repeat" ? spokenMs * settings.pause + LINE_GAP_MS : LINE_GAP_MS,
  );
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

function availableModes(lesson) {
  const modes = ["listen", "repeat"];
  if (lesson.lines.some((l) => l.speaker === NICOS)) modes.push("nicos");
  if (lesson.lines.some((l) => l.en)) modes.push("recall");
  return modes;
}

function activeMode() {
  return current && availableModes(current).includes(settings.mode)
    ? settings.mode
    : "listen";
}

function isConcealed(line) {
  if (settings.showText) return false;
  const mode = activeMode();
  return (
    (mode === "recall" && Boolean(line.en)) ||
    (mode === "nicos" && line.speaker === NICOS)
  );
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
  $("#mode-hint").textContent = MODES[mode].hint;
}

function lineItem(line, i) {
  const item = h("li", {
    className: line.speaker === NICOS ? "line nicos" : "line",
  });
  if (line.speaker)
    item.append(h("span", { className: "speaker", textContent: line.speaker }));
  item.append(h("span", { className: "el", lang: "el", textContent: line.el }));
  if (line.en)
    item.append(
      h("span", { className: "en", lang: "en", textContent: line.en }),
    );
  item.addEventListener("click", () => {
    stop();
    index = i;
    play();
  });
  return item;
}

function applyConcealment() {
  [...$("#lines").children].forEach((item, i) => {
    item.classList.toggle("concealed", isConcealed(current.lines[i]));
    item.classList.remove("revealed");
  });
}

function renderLesson(lesson) {
  current = lesson;
  index = 0;
  $("#page-title").textContent = lesson.title;
  $("#lines").replaceChildren(...lesson.lines.map(lineItem));
  renderModes();
  applyConcealment();
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
  done.add(id);
  localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
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

function renderHome() {
  $("#page-title").textContent = "Κυπριακά";
  $("#home").replaceChildren(
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
  const lesson = lessons.find((l) => l.id === id);
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
  syncSettingsUi();
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
