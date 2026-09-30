import { mp3Seconds, toSlotMp3 } from "../lib/audio";
import { asset } from "../lib/base";
import { LANG_NAMES, packPath, packUrl, mirrorUrl } from "../lib/manifest";
import * as store from "../lib/store";
import { buildPack, IMAGE_SIZE, imageOverhead, isVoicePack, loadPack, SLOT_LABELS, type VoicePack } from "../lib/voicepack";
import { Xm4DirectUpdater } from "../lib/xm4-fota";
import { Xm4Transport } from "../lib/xm4-transport";
import { StereoEq } from "./eq";
import { stepScroll } from "./step-scroll";

const COMMON = [0, 1, 2, 3, 4, 5, 6, 7, 8, 15, 43, 44];
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

interface Sound {
  id: string; // "library/<file>" | "custom/<name>"
  kind: "library" | "custom";
  name: string;
  size: number;
  url: string;
  data?: Uint8Array;
}

const saved = JSON.parse(localStorage.getItem("xm4") || "{}");
const state = {
  source: (saved.source as string) || "01",
  assignments: (saved.assignments as Record<string, string>) || {},
  showAll: !!saved.showAll,
  /** Library tapes the user removed (they ship with the site, so they're hidden, not deleted). */
  hiddenLibrary: (saved.hiddenLibrary as string[]) || [],
  sounds: [] as Sound[],
  pack: undefined as VoicePack | undefined,
  built: undefined as Uint8Array | undefined,
  over: false,
  sonyLoading: true, // until the first loadSourcePack() finishes
};
const packCache = new Map<string, VoicePack>();
const bt = { transport: new Xm4Transport(), busy: false };
const audio = new Audio();
const eq = new StereoEq($("eq"), audio, { text: $("vfdText"), time: $("eqTime") });

function save() {
  const { source, assignments, showAll, hiddenLibrary } = state;
  localStorage.setItem("xm4", JSON.stringify({ source, assignments, showAll, hiddenLibrary }));
}
const kb = (n: number) => (n / 1024).toFixed(1) + " KB";
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k): k is Node | string => k != null));
  return e;
}
const blobUrl = (data: Uint8Array, type = "audio/mpeg") => URL.createObjectURL(new Blob([data as BlobPart], { type }));
// Library sounds are fetched and played from blob: URLs rather than handing the /sounds/ path to the
// <audio> element — Astro's dev server rejects cross-site no-cors media requests (e.g. inside an
// embedded preview), and a fetch() works the same everywhere.
const fetchedUrls = new Map<string, string>();
/** What the step 1 display shows while a sound plays: readout code, number, and title. */
interface Track { code: string; number?: number; title: string }

async function play(url: string, track: Track) {
  eq.connect(); // inside the click, so the AudioContext may start
  eq.load(track.code, track.number, track.title);
  try {
    if (!url.startsWith("blob:")) {
      let blob = fetchedUrls.get(url);
      if (!blob) {
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        blob = URL.createObjectURL(await r.blob());
        fetchedUrls.set(url, blob);
      }
      url = blob;
    }
    audio.src = url;
    await audio.play();
  } catch (e) {
    console.error("playback failed", url, e);
    alert(`Couldn't play this sound: ${(e as Error).message}`);
  }
}
function dropZone(zone: HTMLElement, input: HTMLInputElement, onFiles: (f: File[]) => void) {
  zone.onclick = () => input.click();
  input.onchange = () => { onFiles([...(input.files ?? [])]); input.value = ""; };
  zone.ondragover = (e) => { e.preventDefault(); zone.classList.add("over"); };
  zone.ondragleave = () => zone.classList.remove("over");
  zone.ondrop = (e) => { e.preventDefault(); zone.classList.remove("over"); onFiles([...(e.dataTransfer?.files ?? [])]); };
}

// ---------- languages ----------

function initLanguages() {
  const sel = $<HTMLSelectElement>("source");
  for (const [code, name] of Object.entries(LANG_NAMES).sort()) sel.append(el("option", { value: code, textContent: cap(name) }));
  sel.value = state.source;
  sel.onchange = () => {
    state.source = sel.value;
    state.built = undefined;
    save();
    void loadSourcePack();
  };
}

// ---------- Sony files ----------

/** Fetch the site's copy of a Sony file (public/sony/). Returns undefined if it's missing or invalid. */
async function fetchSony(path: string, valid: (raw: Uint8Array) => boolean): Promise<Uint8Array | undefined> {
  try {
    const r = await fetch(mirrorUrl(path));
    if (!r.ok) return undefined;
    const raw = new Uint8Array(await r.arrayBuffer());
    return valid(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

async function loadSourcePack() {
  const code = state.source;
  let pack = packCache.get(code);
  if (!pack) {
    let raw = await store.get(`pack:${code}`);
    if (!raw) {
      state.sonyLoading = true;
      renderSony();
      raw = await fetchSony(packPath(code), isVoicePack);
      if (raw) await store.set(`pack:${code}`, raw);
    }
    if (raw) {
      pack = loadPack(raw);
      packCache.set(code, pack);
    }
  }
  if (code !== state.source) return; // selection changed while loading
  state.sonyLoading = false;
  state.pack = pack;
  renderSony();
  renderSlots();
}

function renderSony() {
  const name = LANG_NAMES[state.source];
  const link = $<HTMLAnchorElement>("packLink");
  link.href = packUrl(state.source);
  link.textContent = `VP_${name}_UPG_03.bin`;
  for (const el of document.querySelectorAll(".sourceName")) el.textContent = cap(name);
  // Only a warning in step 1 when the automatic download fails.
  $("sonySummary").textContent = `⚠ Couldn't download Sony's ${cap(name)} voice pack automatically.`;
  $("sonyManual").hidden = state.sonyLoading || !!state.pack;
  renderBluetooth();
}

async function addSonyFiles(files: File[]) {
  for (const f of files) {
    const raw = new Uint8Array(await f.arrayBuffer());
    if (isVoicePack(raw)) {
      // Name the pack after its filename (VP_<lang>_UPG_03.bin); fall back to the selected base language.
      const lang = /VP_([a-z]+)_/i.exec(f.name)?.[1]?.toLowerCase();
      const code = Object.entries(LANG_NAMES).find(([, n]) => n === lang)?.[0] ?? state.source;
      try {
        packCache.set(code, loadPack(raw));
      } catch (e) {
        alert(`${f.name}: couldn't read voice pack (${(e as Error).message})`);
        continue;
      }
      await store.set(`pack:${code}`, raw);
      if (code !== state.source) {
        state.source = code;
        $<HTMLSelectElement>("source").value = code;
        save();
      }
    } else {
      alert(`${f.name} doesn't look like a Sony voice pack`);
    }
  }
  await loadSourcePack();
}

// ---------- sounds ----------

async function loadSounds() {
  const library: { file: string; name: string; size: number }[] = await fetch(asset("sounds/index.json")).then((r) => r.json());
  const sounds: Sound[] = library
    .map((s): Sound => ({ id: `library/${s.file}`, kind: "library", name: s.name, size: s.size, url: asset(`sounds/${s.file}`) }))
    .filter((s) => !state.hiddenLibrary.includes(s.id));
  for (const key of (await store.keys()).filter((k) => k.startsWith("sound:")).sort()) {
    const data = (await store.get(key))!;
    sounds.push({ id: `custom/${key.slice(6)}`, kind: "custom", name: key.slice(6), size: data.length, url: blobUrl(data), data });
  }
  state.sounds = sounds;
  const ids = new Set(sounds.map((s) => s.id));
  for (const [slot, id] of Object.entries(state.assignments)) {
    if (!ids.has(id)) {
      delete state.assignments[slot];
      state.built = undefined;
    }
  }
  save();
  renderSounds();
  renderSlots();
}

const PLAY_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.5v9l7.5-4.5z"/></svg>';
const EJECT_ICON = '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5 11 7H1zM1 8.5h10V10.5H1z"/></svg>';

function renderSounds() {
  const n = state.sounds.length;
  $("soundCount").textContent = $("bayCount").textContent = `${n} tape${n === 1 ? "" : "s"}`;
  $("sounds").replaceChildren(...state.sounds.map((s, i) => el("div", { className: `tape ${s.kind}`, title: s.name },
    el("span", { className: "tape-num", textContent: String(i + 1).padStart(2, "0") }),
    el("span", { className: "tape-name", textContent: s.name }),
    el("span", { className: "tape-len", textContent: `${mp3Seconds(s.size).toFixed(2)}s` }),
    el("button", { innerHTML: PLAY_ICON, ariaLabel: `Play ${s.name}`, onclick: () => play(s.url, { code: "SD", number: i + 1, title: s.name }) }),
    el("button", { className: "remove", innerHTML: EJECT_ICON, ariaLabel: `Remove ${s.name}`, onclick: () => void removeSound(s) }),
  )));
  if (!n) $("sounds").append(el("p", { className: "tapes-empty", textContent: "No tapes yet. Add some sounds to use them in your prompts." }));
  const hidden = state.hiddenLibrary.length;
  if (hidden) {
    $("sounds").append(el("button", {
      className: "restore-tapes",
      textContent: `Restore ${hidden} library tape${hidden === 1 ? "" : "s"}`,
      onclick: () => { state.hiddenLibrary = []; save(); void loadSounds(); },
    }));
  }
}

/** Your own tapes are deleted; library tapes are hidden and can be restored. Prompts using it go back to stock. */
async function removeSound(s: Sound) {
  const slots = Object.values(state.assignments).filter((id) => id === s.id).length;
  const note = slots ? ` It's assigned to ${slots} prompt${slots === 1 ? "" : "s"}, which will go back to stock.` : "";
  if (s.kind === "custom") {
    if (!confirm(`Delete your tape "${s.name}"? This can't be undone.${note}`)) return;
    await store.del(`sound:${s.name}`);
    URL.revokeObjectURL(s.url);
  } else {
    if (slots && !confirm(`Remove "${s.name}"?${note}`)) return;
    state.hiddenLibrary = [...state.hiddenLibrary, s.id];
    save();
  }
  await loadSounds();
}

async function uploadSounds(files: File[]) {
  const dock = $("dock");
  dock.classList.add("hold"); // keep the bay open while converting
  const add = $<HTMLButtonElement>("soundAdd");
  add.disabled = true;
  const zone = $("soundDrop");
  const original = zone.innerHTML;
  const taken = new Set(state.sounds.map((s) => s.name));
  for (const f of files) {
    zone.textContent = `Converting ${f.name}…`;
    try {
      const mp3 = await toSlotMp3(f);
      const stem = f.name.replace(/\.[^.]+$/, "").replace(/[^\w.\- ]+/g, "_").trim() || "sound";
      let name = stem;
      for (let n = 2; taken.has(name); n++) name = `${stem}_${n}`;
      taken.add(name);
      await store.set(`sound:${name}`, mp3);
    } catch (e) {
      alert(`${f.name}: couldn't convert (${(e as Error).message || "unsupported format"})`);
    }
  }
  zone.innerHTML = original;
  await loadSounds();
  add.disabled = false;
  dock.classList.remove("hold");
}

// ---------- slots ----------

const slotPager = stepScroll($("slotList"), $("slotRail"));

function slotSize(i: number): number {
  const id = state.assignments[i];
  const s = id ? state.sounds.find((x) => x.id === id) : undefined;
  return s ? s.size : state.pack!.slots[i].length;
}

function renderCapacity() {
  const pack = state.pack;
  const used = pack ? imageOverhead(pack.slots.length) + pack.slots.reduce((a, _, i) => a + slotSize(i), 0) : 0;
  const over = used > IMAGE_SIZE;
  if (over !== state.over) {
    setTransportStatus("btCheck", "off");
    setTransportStatus("btInstall", "off");
  }
  state.over = over;
  $("cap").className = "meter" + (over ? " over" : "");
  $("cap").style.setProperty("--level", Math.min(100, (100 * used) / IMAGE_SIZE) + "%");
  eq.storage(used / IMAGE_SIZE, over);
  $("capText").innerHTML = pack
    ? `Storage: <b>${kb(used)} / ${kb(IMAGE_SIZE)}</b>` + (over ? ' <span class="err">too big, use shorter sounds</span>' : "")
    : "";
  renderBluetooth();
}

function renderSlots() {
  const pack = state.pack;
  if (!pack) {
    slotPager.setRows(0, () => $("slots").replaceChildren(el("tr", {}, el("td", { colSpan: 6, className: state.sonyLoading ? "muted processing" : "muted", textContent: state.sonyLoading ? "Loading Sony's voice pack" : "Add Sony's voice pack above to see its prompts." }))));
    renderCapacity();
    return;
  }
  const entries = pack.slots.map((data, i) => ({ data, i }))
    .filter(({ i }) => state.showAll || COMMON.includes(i) || state.assignments[i]);
  slotPager.setRows(entries.length, (first, end) => {
    const rows = entries.slice(first, end).map(({ data, i }) => {
      const id = state.assignments[i];
      const sel = el("select", {},
        el("option", { value: "", textContent: "— stock —" }),
        ...state.sounds.map((s) => el("option", { value: s.id, textContent: (s.kind === "custom" ? "★ " : "") + s.name })));
      sel.value = id || "";
      sel.onchange = () => {
        if (sel.value) state.assignments[i] = sel.value;
        else delete state.assignments[i];
        state.built = undefined;
        save();
        renderSlots();
      };
      const assigned = id ? state.sounds.find((s) => s.id === id) : undefined;
      return el("tr", { className: id ? "changed" : "" },
        el("td", { className: "num", textContent: "#" + String(i).padStart(2, "0") }),
        el("td", {}, data.length
          ? el("button", { className: "icon", textContent: "▶", ariaLabel: `Play stock ${SLOT_LABELS[i] ?? `slot ${i}`}`, onclick: () => play(blobUrl(data), { code: "TR", number: i, title: `${SLOT_LABELS[i] ?? `Slot ${i}`} · stock` }) })
          : el("span", { className: "muted", textContent: "empty" })),
        el("td", { textContent: SLOT_LABELS[i] || "—" }),
        el("td", {}, sel),
        el("td", {}, assigned ? el("button", { className: "icon", textContent: "▶", ariaLabel: `Play replacement ${SLOT_LABELS[i] ?? `slot ${i}`}`, onclick: () => play(assigned.url, { code: "TR", number: i, title: `${SLOT_LABELS[i] ?? `Slot ${i}`} · ${assigned.name}` }) }) : null),
        el("td", { className: "num", textContent: kb(slotSize(i)) }));
    });
    $("slots").replaceChildren(...rows);
  });
  renderCapacity();
}

// ---------- build ----------

async function soundBytes(s: Sound): Promise<Uint8Array> {
  s.data ??= new Uint8Array(await (await fetch(s.url)).arrayBuffer());
  return s.data;
}

/** Build the pack from the current assignments, or reuse the last build if nothing changed. */
async function ensureBuilt(): Promise<Uint8Array> {
  if (state.built) return state.built;
  btLog("Building your voice pack…");
  await new Promise((r) => setTimeout(r, 30)); // let the UI paint before the synchronous LZMA pass
  const pack = state.pack!;
  const slots = [...pack.slots];
  for (const [slot, id] of Object.entries(state.assignments)) {
    const s = state.sounds.find((x) => x.id === id)!;
    slots[Number(slot)] = await soundBytes(s);
    btLog(`  slot ${slot} (${SLOT_LABELS[Number(slot)] ?? "?"}) ← ${s.name}`);
  }
  state.built = buildPack(pack, slots);
  btLog(`Built ${state.built.length.toLocaleString()} bytes.`);
  return state.built;
}

// ---------- direct Bluetooth install ----------

function setTransportStatus(buttonId: string, status: "off" | "on" | "progress" | "success" | "failed") {
  $<HTMLButtonElement>(buttonId).parentElement!.dataset.status = status;
}

function btLog(line: string, className = "") {
  const log = $("btLog");
  const lines = $("btLogLines");
  log.hidden = false;
  log.className = `lcd ${className}`;
  lines.textContent = (lines.textContent ? lines.textContent + "\n" : "") + line;
  log.scrollTop = log.scrollHeight;
}

function clearBtLog() {
  $("btLogLines").textContent = "";
  $("btTerminalProgress").hidden = true;
  $("btLog").className = "lcd";
}

function terminalProgress(fraction: number, remainingMs: number | undefined, phase: "TRANSFER" | "VERIFY" | "COMPLETE" | "FAILED") {
  const progress = $("btTerminalProgress");
  const percentage = Math.floor(100 * Math.max(0, Math.min(1, fraction)));
  const filled = Math.round(percentage * 16 / 100);
  const seconds = remainingMs === undefined ? undefined : Math.ceil(remainingMs / 1000);
  const eta = seconds === undefined ? "--:--" : `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const suffix = phase === "TRANSFER" ? `ETA ${eta}` : phase === "VERIFY" ? "VERIFYING" : phase === "COMPLETE" ? "DONE" : "FAILED";
  progress.textContent = `:: [${"█".repeat(filled)}${"░".repeat(16 - filled)}] ${String(percentage).padStart(3)}%  ${suffix}`;
  progress.setAttribute("aria-valuenow", String(percentage));
  progress.hidden = false;
  $("btLog").scrollTop = $("btLog").scrollHeight;
}

function renderBluetooth() {
  const supported = "serial" in navigator;
  const { mdr, race } = bt.transport;
  const channelsReady = !!mdr && !!race;
  const ready = supported && !bt.busy && channelsReady;
  $("btUnsupported").hidden = supported;
  $<HTMLButtonElement>("btMdr").disabled = !supported || bt.busy || !!mdr;
  $<HTMLButtonElement>("btRace").disabled = !supported || bt.busy || !!race;
  const canRun = ready && !!state.pack && !state.over;
  const canReturnToStepOne = state.over && !bt.busy;
  $<HTMLButtonElement>("btInstall").disabled = !canRun && !canReturnToStepOne;
  $<HTMLButtonElement>("btCheck").disabled = !canRun && !canReturnToStepOne;
  $<HTMLButtonElement>("btRestore").disabled = !ready || !state.pack;
  $("btMdr").classList.toggle("on", !!mdr);
  $("btRace").classList.toggle("on", !!race);
  $("btMdr").setAttribute("aria-label", mdr ? "Control channel linked" : "Connect control channel");
  $("btRace").setAttribute("aria-label", race ? "Update channel linked" : "Connect update channel");
  for (const buttonId of ["btMdr", "btRace", "btCheck", "btInstall"]) {
    const button = $<HTMLButtonElement>(buttonId);
    if (["off", "on"].includes(button.parentElement!.dataset.status!)) {
      const channelAction = buttonId === "btCheck" || buttonId === "btInstall";
      setTransportStatus(buttonId, button.disabled || (channelAction && !channelsReady) ? "off" : "on");
    }
  }
  const describeChannel = (name: string, linked: boolean, buttonId: string) => {
    if (linked) return `${name} channel linked`;
    const status = $<HTMLButtonElement>(buttonId).parentElement!.dataset.status;
    if (status === "progress") return `Connecting ${name.toLowerCase()} channel…`;
    if (status === "failed") return `${name} channel failed`;
    return supported ? `Awaiting ${name.toLowerCase()} channel` : `${name} channel unavailable`;
  };
  const connectionStatus = [describeChannel("Control", !!mdr, "btMdr"), describeChannel("Update", !!race, "btRace")]
    .map((line) => `:: ${line}`).join("\n");
  if ($("btConnectionStatus").textContent !== connectionStatus) $("btConnectionStatus").textContent = connectionStatus;
}

async function connectBluetooth(which: "mdr" | "race") {
  if (bt.busy) return;
  const buttonId = which === "mdr" ? "btMdr" : "btRace";
  setTransportStatus(buttonId, "progress");
  bt.busy = true;
  renderBluetooth();
  try {
    if (which === "mdr") await bt.transport.connectMdr();
    else await bt.transport.connectRace();
    setTransportStatus(buttonId, "success");
  } catch (e) {
    setTransportStatus(buttonId, "failed");
    btLog((e as Error).message, "err");
  } finally {
    bt.busy = false;
    renderBluetooth();
  }
}

function showCapacityIfOver(): boolean {
  if (!state.over) return false;
  $("capText").focus({ preventScroll: true });
  $("capText").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  return true;
}

/** Read-only run of every check the install does first; ends by cancelling the session. */
async function checkBluetooth() {
  if (bt.busy || showCapacityIfOver()) return;
  setTransportStatus("btCheck", "progress");
  bt.busy = true;
  renderBluetooth();
  clearBtLog();
  try {
    const bin = await ensureBuilt();
    const r = await Xm4DirectUpdater.fromTransport(bt.transport).preflight(bin, (m) => btLog(m));
    setTransportStatus("btCheck", "success");
    btLog(`✓ Ready to install (battery ${r.battery}%). Nothing was written.`, "ok");
  } catch (e) {
    setTransportStatus("btCheck", "failed");
    btLog(`✗ ${(e as Error).message}`, "err");
  } finally {
    bt.busy = false;
    renderBluetooth();
  }
}

const minutes = (ms: number) => Math.max(1, Math.round(ms / 60000));

async function installBuilt() {
  if (bt.busy || showCapacityIfOver()) return;
  setTransportStatus("btInstall", "progress");
  bt.busy = true;
  renderBluetooth();
  clearBtLog();
  let bin: Uint8Array;
  try {
    bin = await ensureBuilt();
  } catch (e) {
    setTransportStatus("btInstall", "failed");
    btLog(`✗ Build failed: ${(e as Error).message}`, "err");
    return;
  } finally {
    bt.busy = false;
    renderBluetooth();
  }
  await installBluetooth(bin, "your voice pack", false);
}

async function installBluetooth(bin: Uint8Array, what: string, clearLog = true) {
  if (!confirm(`Install ${what} on your headphones now?\n\nIt takes about 15 minutes. Keep the headphones on and near this computer. ` +
      "At the end they switch off to install it; then turn them back on.")) {
    setTransportStatus("btInstall", "on");
    return;
  }
  setTransportStatus("btInstall", "progress");
  bt.busy = true;
  renderBluetooth();
  if (clearLog) clearBtLog();
  const deck = $("btProgress");
  deck.hidden = false;
  deck.classList.add("running");
  const setFraction = (f: number) => {
    deck.style.setProperty("--p", String(f));
    $("btBar").style.setProperty("--level", `${(100 * f).toFixed(1)}%`);
  };
  const status = $("btStatus");
  setFraction(0);
  terminalProgress(0, undefined, "TRANSFER");
  status.textContent = "Starting…";
  let started = 0;
  let done = false;
  let fraction = 0;
  try {
    await Xm4DirectUpdater.fromTransport(bt.transport).install(bin, {
      progress: (m) => btLog(m),
      onFraction: (f) => {
        started ||= performance.now();
        fraction = f;
        setFraction(f);
        const remainingMs = f > 0.02 && f < 1 ? ((performance.now() - started) * (1 - f)) / f : undefined;
        const left = remainingMs === undefined ? "" : ` · about ${minutes(remainingMs)} min left`;
        status.textContent = `Transferring ${Math.floor(100 * f)}%${left}`;
        terminalProgress(f, remainingMs, f >= 1 ? "VERIFY" : "TRANSFER");
      },
    });
    done = true;
    terminalProgress(1, undefined, "COMPLETE");
    setTransportStatus("btInstall", "success");
    status.textContent = "Installing on the headphones…";
    btLog("✓ Sent and verified. The headphones are installing it and will switch off: when the light stops blinking, turn them on.", "ok");
  } catch (e) {
    terminalProgress(fraction, undefined, "FAILED");
    setTransportStatus("btInstall", "failed");
    status.textContent = "Stopped. Your current prompts are unchanged.";
    btLog(`✗ ${(e as Error).message}`, "err");
  } finally {
    deck.classList.remove("running");
    // After a commit the headphones drop both channels; reconnect from scratch next time.
    if (done) {
      await bt.transport.close();
      bt.transport = new Xm4Transport();
      setTransportStatus("btMdr", "off");
      setTransportStatus("btRace", "off");
    }
    bt.busy = false;
    renderBluetooth();
  }
}

async function restoreStock() {
  const raw = await store.get(`pack:${state.source}`);
  if (!raw) return btLog("The stock voice pack isn't loaded. Add it in step 1 first.", "err");
  await installBluetooth(raw, `Sony's stock ${cap(LANG_NAMES[state.source])} voice pack`);
}

// ---------- init ----------

// This site uses no service workers. A leftover one from another app served on the same origin
// (e.g. a COOP/COEP "coi-serviceworker" on localhost:4321) rewrites responses and breaks
// media/fetches here, so drop any registration and reload once without it.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.getRegistrations().then(async (regs) => {
    if (!regs.length) return;
    await Promise.all(regs.map((r) => r.unregister()));
    if (navigator.serviceWorker.controller) location.reload();
  });
}

initLanguages();
$<HTMLInputElement>("showAll").checked = state.showAll;
$<HTMLInputElement>("showAll").onchange = (e) => {
  state.showAll = (e.target as HTMLInputElement).checked;
  save();
  renderSlots();
};
$("reset").onclick = () => {
  state.assignments = {};
  state.built = undefined;
  save();
  renderSlots();
};
$("btMdr").onclick = () => void connectBluetooth("mdr");
$("btRace").onclick = () => void connectBluetooth("race");
$("btCheck").onclick = () => void checkBluetooth();
$("btInstall").onclick = () => void installBuilt();
$("btRestore").onclick = () => void restoreStock();
dropZone($("sonyDrop"), $<HTMLInputElement>("sonyFile"), (f) => void addSonyFiles(f));
dropZone($("soundDrop"), $<HTMLInputElement>("soundFile"), (f) => void uploadSounds(f));
// Hovering cracks the door open (CSS); clicking it, Enter, or Space drops it fully.
// Clicking outside or Escape closes it. Dragging files over the closed door opens it
// while the drag lasts; a drop anywhere in the dock counts.
{
  const dock = $("dock");
  const door = dock.querySelector<HTMLElement>(".dock-door")!;
  door.addEventListener("click", () => dock.classList.add("open"));
  $("soundAdd").onclick = () => $("soundFile").click();
  $("dockClose").onclick = () => { dock.classList.remove("open"); dock.focus(); };
  dock.addEventListener("keydown", (e) => {
    if (e.target !== dock) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); dock.classList.toggle("open"); }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dock.classList.contains("open")) { dock.classList.remove("open"); dock.focus(); }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!dock.contains(e.target as Node)) dock.classList.remove("open");
  });
  let depth = 0; // dragenter/dragleave fire for every child, so count them
  dock.addEventListener("dragenter", () => { depth++; dock.classList.add("hold"); });
  dock.addEventListener("dragover", (e) => e.preventDefault());
  dock.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; dock.classList.remove("hold"); } });
  dock.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    dock.classList.remove("hold");
    // The drop zone handles its own drops; this catches drops on the tapes or the bay edges.
    if (!(e.target as HTMLElement).closest("#soundDrop")) void uploadSounds([...(e.dataTransfer?.files ?? [])]);
  });
}
renderSony();
renderSlots();
renderBluetooth();
void store.persist();
void loadSounds().then(loadSourcePack);
