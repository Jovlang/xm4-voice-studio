/**
 * Dot-matrix stereo spectrum analyser for step 1 (see .stereo in global.css).
 * Driven by a Web Audio AnalyserNode on the page's preview <audio> element, so the
 * bars show whatever stock prompt or sound is playing. Both banks show the same
 * (mono) signal. RANGE columns: left = playback position, right = voice storage used.
 */
const ROWS = 16;
const PEAK_HOLD_MS = 700;
const PEAK_FALL_MS = 60;
/** Band centres in Hz, matching the labels in index.astro. */
const BANDS = [63, 160, 400, 1000, 2500, 6300, 16000];

interface Band { el: HTMLElement; rows: number; peak: number; peakAt: number; fallAt: number }

export class StereoEq {
  private bands: Band[];
  private analyser?: AnalyserNode;
  private bins?: Uint8Array<ArrayBuffer>;
  private frame = 0;
  private readonly reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(private root: HTMLElement, private audio: HTMLAudioElement, private vfd: { text: HTMLElement; time: HTMLElement }) {
    this.bands = [...root.querySelectorAll<HTMLElement>(".col")].map((el) => ({ el, rows: 0, peak: 0, peakAt: 0, fallAt: 0 }));
    audio.addEventListener("play", () => this.start());
    audio.addEventListener("ended", () => this.standby());
    audio.addEventListener("pause", () => this.root.classList.remove("active"));
    // Keep the elapsed-time display and position bar tied to the media element's
    // clock, including metadata loading, seeks, and browsers that throttle RAF.
    for (const event of ["timeupdate", "loadedmetadata", "durationchange", "seeked"] as const) {
      audio.addEventListener(event, () => this.drawClock());
    }
    this.standby();
  }

  /** Call from the click that starts playback: AudioContext needs a user gesture. */
  connect(): void {
    if (this.analyser) return;
    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(this.audio);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.8;
    source.connect(this.analyser).connect(ctx.destination);
    this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    if (ctx.state === "suspended") void ctx.resume();
  }

  /** What's in the deck: readout code (e.g. "TR" + slot number) and the VFD title. */
  load(code: string, number: number | undefined, title: string): void {
    this.readout(code, number === undefined ? "--" : String(number).padStart(2, "0"));
    this.vfd.text.textContent = title;
    this.vfd.time.textContent = "00:00:00";
    this.setRange("L", 0);
  }

  storage(fraction: number, over: boolean): void {
    this.setRange("R", fraction);
    this.root.querySelector<HTMLElement>('.range[data-ch="R"]')!.classList.toggle("over", over);
  }

  private standby(): void {
    this.root.classList.remove("active");
    if (this.audio.ended || !this.audio.currentSrc) {
      this.readout("XM", "04");
      this.vfd.text.textContent = "Standby · press ▶ on a prompt or sound";
      this.vfd.time.textContent = "00:00:00";
      this.setRange("L", 0);
    }
  }

  private readout(top: string, bottom: string): void {
    this.root.querySelector<HTMLElement>(".seg-top")!.textContent = top.slice(0, 2);
    this.root.querySelector<HTMLElement>(".seg-bottom")!.textContent = bottom.slice(0, 2);
  }

  private setRange(channel: "L" | "R", fraction: number): void {
    const rows = Math.round(Math.max(0, Math.min(1, fraction)) * ROWS);
    this.root.querySelector<HTMLElement>(`.range[data-ch="${channel}"]`)!.style.setProperty("--h", String(rows));
  }

  private start(): void {
    this.root.classList.add("active");
    if (this.frame) return;
    let last = 0;
    const draw = (now: number) => {
      // Keep animating until every bar and peak has fallen back to zero.
      const playing = !this.audio.paused && !this.audio.ended;
      if (!this.reduced || now - last > 400) {
        last = now;
        this.drawBands(now, playing);
        this.drawClock();
      }
      const settled = this.bands.every((b) => b.rows === 0 && b.peak === 0);
      this.frame = playing || !settled ? requestAnimationFrame(draw) : 0;
    };
    this.frame = requestAnimationFrame(draw);
  }

  private drawBands(now: number, playing: boolean): void {
    const levels = playing && this.analyser && this.bins ? this.bandLevels() : BANDS.map(() => 0);
    this.bands.forEach((b, i) => {
      const target = Math.round(levels[i % BANDS.length] * ROWS);
      // Fast attack, one row per frame release, like a real analyser.
      b.rows = target >= b.rows ? target : Math.max(target, b.rows - 1);
      if (b.rows >= b.peak) { b.peak = b.rows; b.peakAt = now; }
      else if (now - b.peakAt > PEAK_HOLD_MS && now - b.fallAt > PEAK_FALL_MS) { b.peak--; b.fallAt = now; }
      b.el.style.setProperty("--h", String(b.rows));
      b.el.style.setProperty("--pk", String(b.peak));
      b.el.classList.toggle("peaked", b.peak > 0);
    });
  }

  /** Loudest bin in a third-octave-ish window around each band centre, 0..1. */
  private bandLevels(): number[] {
    const analyser = this.analyser!;
    const bins = this.bins!;
    analyser.getByteFrequencyData(bins);
    const hzPerBin = analyser.context.sampleRate / analyser.fftSize;
    return BANDS.map((f) => {
      const lo = Math.max(1, Math.floor(f / 1.4 / hzPerBin));
      const hi = Math.min(bins.length - 1, Math.ceil(f * 1.4 / hzPerBin));
      let max = 0;
      for (let k = lo; k <= hi; k++) max = Math.max(max, bins[k]);
      return max / 255;
    });
  }

  private drawClock(): void {
    const t = this.audio.currentTime || 0;
    const mm = String(Math.floor(t / 60)).padStart(2, "0");
    const ss = String(Math.floor(t) % 60).padStart(2, "0");
    const cs = String(Math.floor((t % 1) * 100)).padStart(2, "0");
    this.vfd.time.textContent = `${mm}:${ss}:${cs}`;
    if (this.audio.duration > 0) this.setRange("L", t / this.audio.duration);
  }
}
