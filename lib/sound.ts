// Sound engine for Country Pool. Everything is synthesised at runtime with Web Audio -
// the sound EFFECTS (cue, clicks, rail, pocket, scratch, win) and the background music
// (an original slow-jazz trio, one progression per stage). No audio files, no CDN, no
// licensing; the CSP stays 'self'. Every call is wrapped so audio can never throw or
// break play, and the mute toggle silences both.

const STORE_KEY = "cp-muted";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
let lastShotPower = 0; // power (0..1) of the most recent shot, boosts knock/rail SFX
const listeners = new Set<(m: boolean) => void>();

if (typeof window !== "undefined") {
  muted = window.localStorage?.getItem(STORE_KEY) === "1";
}

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  try {
    if (!ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      ctx = new AC({ latencyHint: "interactive" }); // lowest output latency for snappy SFX
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(o: {
  type: OscillatorType;
  from: number;
  to?: number;
  dur: number;
  gain: number;
  delay?: number;
}) {
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime + (o.delay ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type;
  osc.frequency.setValueAtTime(o.from, t0);
  if (o.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.to), t0 + o.dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.02);
}

// A short filtered noise burst - the "knock" body of a ball impact.
function knock(dur: number, gain: number, freq: number) {
  const c = ensure();
  if (!c || !master) return;
  const t0 = c.currentTime;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filt = c.createBiquadFilter();
  filt.type = "bandpass";
  filt.frequency.value = freq;
  filt.Q.value = 1.4;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt);
  filt.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

// --- Background music: an original slow-jazz trio (soft piano comp + upright walking
// bass), fully synthesised - no audio files, no CDN, no licensing. Each stage gets its
// own jazz progression + tempo; setStage() switches it on the next bar. Routed through
// `master`, so the existing mute toggle silences it too.
let musicGain: GainNode | null = null;
let musicTimer: ReturnType<typeof setInterval> | null = null;
let musicStep = 0;
let musicNextT = 0;

// 7th/9th chord voicings (Hz), comfy piano range.
const CH: Record<string, number[]> = {
  Cmaj7: [261.63, 329.63, 392.0, 493.88],
  Dm7: [293.66, 349.23, 440.0, 523.25],
  G7: [196.0, 246.94, 293.66, 349.23],
  Am7: [220.0, 261.63, 329.63, 392.0],
  A7: [220.0, 277.18, 329.63, 392.0],
  Fmaj7: [174.61, 220.0, 261.63, 329.63],
  Gm7: [196.0, 233.08, 293.66, 349.23],
  C7: [261.63, 329.63, 392.0, 466.16],
  F7: [174.61, 220.0, 261.63, 311.13],
  Bbmaj7: [233.08, 293.66, 349.23, 440.0],
  Cm7: [261.63, 311.13, 392.0, 466.16],
  Gmaj7: [196.0, 246.94, 293.66, 369.99],
  Em7: [164.81, 196.0, 246.94, 293.66],
  D7: [146.83, 185.0, 220.0, 261.63],
  E7: [164.81, 207.65, 246.94, 293.66],
  Dmaj9: [146.83, 185.0, 220.0, 277.18, 329.63],
  Amaj9: [110.0, 138.59, 164.81, 207.65, 246.94],
};

type Tune = { bpm: number; prog: string[] };
const TUNES: Record<string, Tune> = {
  pool: { bpm: 82, prog: ["Dm7", "G7", "Cmaj7", "Am7"] }, // smoky lounge ii-V-I
  soccer: { bpm: 96, prog: ["Cmaj7", "A7", "Dm7", "G7"] },
  football: { bpm: 88, prog: ["Fmaj7", "Dm7", "Gm7", "C7"] },
  basketball: { bpm: 100, prog: ["C7", "F7", "C7", "G7"] }, // bluesy
  baseball: { bpm: 78, prog: ["Bbmaj7", "Gm7", "Cm7", "F7"] },
  tennis: { bpm: 92, prog: ["Gmaj7", "Em7", "Am7", "D7"] },
  pingpong: { bpm: 110, prog: ["Am7", "D7", "Gmaj7", "E7"] },
  swim: { bpm: 68, prog: ["Dmaj9", "Amaj9", "Dmaj9", "Amaj9"] }, // dreamy
};
let currentTune: Tune = TUNES.pool;

// A struck-piano voice: sharp attack, exponential decay, a couple of soft partials.
function piano(freq: number, t: number, dur: number, gain: number) {
  if (!ctx || !musicGain) return;
  for (const [mult, g] of [[1, gain], [2, gain * 0.32], [3, gain * 0.1]] as const) {
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq * mult;
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, g), t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env);
    env.connect(musicGain);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}

// Rounded upright-bass voice.
function bass(freq: number, t: number, dur: number, gain: number) {
  if (!ctx || !musicGain) return;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = freq;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.exponentialRampToValueAtTime(gain, t + 0.02);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(env);
  env.connect(musicGain);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function scheduleMusic() {
  if (!ctx || !musicGain) return;
  while (musicNextT < ctx.currentTime + 0.3) {
    const beat = 60 / currentTune.bpm;
    const bar = Math.floor(musicStep / 4) % currentTune.prog.length;
    const beatIdx = musicStep % 4;
    const chord = CH[currentTune.prog[bar]] ?? CH.Cmaj7;
    const t = musicNextT;
    const root = chord[0] / 2;
    const fifth = chord[Math.min(2, chord.length - 1)] / 2;
    // Walking bass: root, up a step, fifth, back - laid-back quarter notes.
    const walk = [root, root * 1.122, fifth, fifth * 0.944][beatIdx];
    bass(walk, t, beat * 0.92, 0.1);
    if (beatIdx === 0) {
      // Full chord comped with a tiny roll (piano feel).
      chord.forEach((f, i) => piano(f, t + i * 0.012, beat * 2.4, Math.max(0.012, 0.05 - i * 0.006)));
    } else if (beatIdx === 2) {
      // Soft upper-voice stab on the backbeat.
      chord.slice(1).forEach((f) => piano(f, t + 0.02, beat * 1.1, 0.026));
    }
    musicStep++;
    musicNextT += beat;
  }
}

function startMusic() {
  const c = ensure();
  if (!c || !master || musicTimer) return;
  if (!musicGain) {
    musicGain = c.createGain();
    musicGain.gain.value = 0.5; // sits under the sound effects
    musicGain.connect(master);
  }
  musicStep = 0;
  musicNextT = c.currentTime + 0.15;
  scheduleMusic();
  musicTimer = setInterval(scheduleMusic, 60);
}

export const sound = {
  unlock() {
    ensure();
    startMusic(); // begin the jazz trio on the first user interaction
  },
  // Switch the background progression to match the current stage (next bar).
  setStage(key: string) {
    if (TUNES[key]) currentTune = TUNES[key];
  },
  // Stop the looping background music (e.g. on Game Over).
  stopMusic() {
    if (musicTimer) {
      clearInterval(musicTimer);
      musicTimer = null;
    }
  },
  // Game over: cut the jazz and play a somber descending motif.
  gameOver() {
    this.stopMusic();
    const notes = [392.0, 349.23, 293.66, 220.0]; // a slow descent
    notes.forEach((f, i) =>
      tone({ type: "triangle", from: f, to: f * 0.97, dur: 0.5, gain: 0.24, delay: i * 0.3 }),
    );
    tone({ type: "sine", from: 110, to: 78, dur: 1.3, gain: 0.22, delay: 1.05 }); // low final thud
  },
  // Speak the country name when its ball is potted (skipped while muted).
  announce(name: string) {
    if (muted || typeof window === "undefined" || !window.speechSynthesis) return;
    try {
      const u = new SpeechSynthesisUtterance(name);
      u.rate = 1.05;
      u.volume = 0.9;
      window.speechSynthesis.cancel(); // announce the latest, not a backlog on a fast break
      window.speechSynthesis.speak(u);
    } catch {
      /* speech unavailable - ignore */
    }
  },
  // The cue striking the ball - sharp crack, power 0..1 shapes it. Loudness rises on a
  // steep (quadratic) curve so a soft tap is quiet and a full shot cracks hard; above
  // 90% (fire mode) a deep boom + whoosh layer on so max power is unmistakably louder.
  cue(power = 1) {
    const p = Math.max(0, Math.min(1, power));
    lastShotPower = p; // makes the resulting ball knocks + rail thuds scale with the shot
    const v = 0.18 + p * p * 1.05; // ~0.18 soft -> ~1.2 at full
    knock(0.05, 0.5 * v, 2200 + p * 900);
    tone({ type: "triangle", from: 180, to: 90, dur: 0.06, gain: 0.16 * v });
    const fire = Math.max(0, (p - 0.9) / 0.1);
    if (fire > 0) {
      knock(0.12, 0.55 * fire, 140); // low thud
      tone({ type: "sawtooth", from: 95, to: 40, dur: 0.24, gain: 0.32 * fire }); // boom
      tone({ type: "square", from: 820, to: 200, dur: 0.14, gain: 0.12 * fire, delay: 0.01 }); // whoosh
    }
  },
  // Ball-on-ball click. Loudness + pitch scale with impact speed AND the power of the
  // shot that caused it - so a hard break cracks loud and a fire-mode shot is loudest.
  click(impact: number) {
    const v = Math.max(0.06, Math.min(1, impact));
    const boost = 0.7 + lastShotPower * lastShotPower * 1.7; // ~0.7x soft -> ~2.4x at full power
    knock(0.04, Math.min(0.9, 0.28 * v * boost), 1500 + v * 2200);
  },
  // A cushion thud - duller and lower than a ball click; also swells with shot power.
  rail() {
    const boost = 0.7 + lastShotPower * lastShotPower * 1.7;
    knock(0.06, Math.min(0.6, 0.16 * boost), 320);
  },
  // A ball dropping into a pocket: click, then a hollow wooden roll-away.
  pocket() {
    knock(0.05, 0.3, 900);
    tone({ type: "sine", from: 300, to: 90, dur: 0.32, gain: 0.2, delay: 0.03 });
    tone({ type: "sine", from: 150, to: 60, dur: 0.4, gain: 0.14, delay: 0.06 });
  },
  // Table cleared - a warm little fanfare.
  win() {
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((f, i) =>
      tone({ type: "triangle", from: f, dur: 0.2, gain: 0.22, delay: i * 0.13 }),
    );
  },
  // Scratch (cue ball pocketed) - a short descending "aww".
  scratch() {
    tone({ type: "sawtooth", from: 440, to: 150, dur: 0.32, gain: 0.16 });
  },

  isMuted() {
    return muted;
  },
  setMuted(m: boolean) {
    muted = m;
    if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, 0.01);
    if (typeof window !== "undefined") window.localStorage?.setItem(STORE_KEY, m ? "1" : "0");
    listeners.forEach((fn) => fn(m));
  },
  toggle() {
    ensure();
    this.setMuted(!muted);
    return muted;
  },
  subscribe(fn: (m: boolean) => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};
