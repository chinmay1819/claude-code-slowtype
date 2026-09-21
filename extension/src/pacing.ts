/**
 * A model of how a person actually types code.
 *
 * The first version of this paced at a near-constant rate with small pauses at
 * punctuation, and it read as a teleprinter rather than a person. Real typing
 * doesn't vary smoothly — it is **bursty**. Familiar tokens come out as single
 * fast motor chunks, and then there is a real, long pause at the points where
 * the typist had to decide something. The pauses carry almost all of the
 * humanity; the fast runs between them just need to not be uniform.
 *
 * Four effects, in rough order of how much they matter:
 *
 *  1. **Token bursts.** An identifier the typist "knows" is one gesture, ~1.6x
 *     faster than the nominal rate. Boundaries between tokens get a pause.
 *  2. **Decision pauses.** Long dwells (200-600ms) before a new statement, a
 *     string literal, or an argument list — the places you stop to think.
 *  3. **Keystroke difficulty.** Shifted symbols and digits are slower than home
 *     row letters; repeating the same finger is slower than alternating hands.
 *  4. **Drift.** A slow random walk over the whole file, so the typist warms up
 *     and tires rather than holding a metronomic average.
 *
 * Indentation is deliberately instant: in a real editor it arrives from
 * auto-indent or one tab press, never as N separate space keystrokes.
 *
 * Randomness is seeded so that tests are deterministic and a given file always
 * types the same way.
 */

export interface PacingOptions {
  charsPerSecond: number;
  /** Scales every pause. 0 gives a flat, mechanical rate. */
  expressiveness: number;
}

export interface Tick {
  /** Characters to emit now. */
  chunk: number;
  /** Delay after emitting them, in ms. */
  delayMs: number;
}

/** Timer granularity we can actually honour in the extension host. */
const MIN_TICK_MS = 16;

/* ------------------------------------------------------------------ keyboard */

const LEFT = new Set('`12345qwertasdfgzxcvb');
const RIGHT = new Set('67890-=yuiop[]\\hjkl;\'nm,./');

/** Characters that need shift, and so cost an extra motion. */
const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?ABCDEFGHIJKLMNOPQRSTUVWXYZ');

function hand(ch: string): 'L' | 'R' | null {
  const c = ch.toLowerCase();
  if (LEFT.has(c)) return 'L';
  if (RIGHT.has(c)) return 'R';
  return null;
}

/**
 * Per-keystroke multiplier on the nominal interval. Alternating hands is the
 * fast case; same hand twice in a row is slower; shifted symbols slower still.
 */
function keystrokeCost(ch: string, prev: string | undefined): number {
  let cost = 1;

  if (SHIFTED.has(ch)) cost *= 1.45;
  else if (ch >= '0' && ch <= '9') cost *= 1.3;

  if (prev) {
    const a = hand(prev);
    const b = hand(ch);
    if (a && b) cost *= a === b ? 1.18 : 0.88;
    if (prev === ch) cost *= 1.1; // same key twice: no alternation to hide behind
  }

  return cost;
}

/* --------------------------------------------------------------- tokenising */

type TokenKind = 'indent' | 'word' | 'string' | 'symbol' | 'newline' | 'space';

interface Token {
  kind: TokenKind;
  start: number;
  end: number;
}

const WORD = /[A-Za-z0-9_$]/;

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let atLineStart = true;

  while (i < text.length) {
    const c = text[i];

    if (c === '\n') {
      out.push({ kind: 'newline', start: i, end: ++i });
      atLineStart = true;
      continue;
    }

    if (atLineStart && (c === ' ' || c === '\t')) {
      const start = i;
      while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
      out.push({ kind: 'indent', start, end: i });
      atLineStart = false;
      continue;
    }
    atLineStart = false;

    if (c === '"' || c === "'" || c === '`') {
      // Consume the whole literal as one token: you type a string as a phrase,
      // and the pause lands before it, while you decide what it says.
      const quote = c;
      const start = i++;
      while (i < text.length && text[i] !== quote && text[i] !== '\n') {
        if (text[i] === '\\') i++;
        i++;
      }
      if (i < text.length && text[i] === quote) i++;
      out.push({ kind: 'string', start, end: i });
      continue;
    }

    if (WORD.test(c)) {
      const start = i;
      while (i < text.length && WORD.test(text[i])) i++;
      out.push({ kind: 'word', start, end: i });
      continue;
    }

    if (c === ' ') {
      const start = i;
      while (i < text.length && text[i] === ' ') i++;
      out.push({ kind: 'space', start, end: i });
      continue;
    }

    out.push({ kind: 'symbol', start: i, end: ++i });
  }

  return out;
}

/* ------------------------------------------------------------------- pauses */

/** Dwell time *before* a token begins, in ms at expressiveness 1. */
function pauseBefore(tok: Token, prev: Token | undefined, text: string, rnd: () => number): number {
  if (!prev) return 0;

  const lead = text[tok.start];

  switch (tok.kind) {
    case 'newline':
      // End of a line: brief, unless the line was blank (a deliberate break).
      return prev.kind === 'newline' ? 240 : 90;

    case 'indent':
      // Auto-indent: the pause here is "what does this line say?", and it is the
      // single most human moment in the whole animation.
      return 170 + rnd() * 260;

    case 'string':
      return 120 + rnd() * 200; // deciding on the literal

    case 'word': {
      // A long identifier usually means a deliberate name.
      const len = tok.end - tok.start;
      if (prev.kind === 'symbol' && (text[prev.start] === '.' || text[prev.start] === '(')) {
        return 60 + rnd() * 120; // recalling an API member or an argument
      }
      return (len > 8 ? 55 : 25) + rnd() * 60;
    }

    case 'symbol':
      if (lead === '{') return 70;
      if (lead === '(' || lead === '[') return 45;
      if (lead === '=' || lead === '>') return 50;
      return 20 + rnd() * 30;

    default:
      return 10;
  }
}

/** Within-token speed multiplier. Lower is faster. */
function burstFactor(kind: TokenKind): number {
  switch (kind) {
    case 'word': return 0.62;   // known word: one motor gesture
    case 'string': return 0.8;
    case 'indent': return 0;    // emitted instantly
    case 'space': return 0.9;
    default: return 1;
  }
}

/* -------------------------------------------------------------------- typist */

/**
 * Walks a piece of text and yields the cadence for each step. Stateful because
 * drift and token context both depend on where we've been.
 */
export class Typist {
  private readonly tokens: Token[];
  private readonly rnd: () => number;
  private index = 0;
  private tokenAt = 0;
  private drift = 1;

  /**
   * Scales every delay so that the *effective* rate matches charsPerSecond.
   *
   * Without this, pauses silently halve the speed and the setting means nothing
   * you can predict. Calibrated, the two knobs are orthogonal: charsPerSecond
   * decides how long the file takes, expressiveness decides how unevenly that
   * time is distributed.
   */
  private scale = 1;

  constructor(
    private readonly text: string,
    private readonly opts: PacingOptions,
    seed = 0x5105,
    calibrate = true
  ) {
    this.tokens = tokenize(text);
    this.rnd = mulberry32(seed ^ hashString(text));

    if (calibrate && text.length > 0) {
      const dry = new Typist(text, opts, seed, false);
      let raw = 0;
      let guard = text.length * 2 + 16;
      while (!dry.done && guard-- > 0) raw += dry.next().delayMs;

      const desired = (text.length / Math.max(1, opts.charsPerSecond)) * 1000;
      if (raw > 0) this.scale = clamp(desired / raw, 0.3, 3);
    }
  }

  get done(): boolean {
    return this.index >= this.text.length;
  }

  get position(): number {
    return this.index;
  }

  next(): Tick {
    const nominal = 1000 / Math.max(1, this.opts.charsPerSecond);
    const expr = Math.max(0, this.opts.expressiveness);

    // Advance the token cursor to cover the current character.
    while (
      this.tokenAt < this.tokens.length - 1 &&
      this.tokens[this.tokenAt].end <= this.index
    ) {
      this.tokenAt++;
    }
    const tok = this.tokens[this.tokenAt];
    const starting = tok !== undefined && tok.start === this.index;

    // Slow random walk: warming up and tiring, rather than a fixed average.
    this.drift = clamp(this.drift + (this.rnd() - 0.5) * 0.12, 0.78, 1.3);

    // Indentation arrives in one motion, as auto-indent or a single tab.
    if (tok?.kind === 'indent' && starting) {
      const chunk = tok.end - tok.start;
      this.index += chunk;
      return { chunk, delayMs: Math.max(MIN_TICK_MS, 30 * expr * this.scale) };
    }

    const prev = this.index > 0 ? this.text[this.index - 1] : undefined;
    const ch = this.text[this.index];

    let delay = nominal * this.drift * burstFactor(tok?.kind ?? 'symbol');
    delay *= keystrokeCost(ch, prev);

    if (starting && expr > 0) {
      delay += pauseBefore(tok, this.tokens[this.tokenAt - 1], this.text, this.rnd) * expr;
    }

    // At very high speeds a single character per tick is below the timer floor,
    // so widen the chunk rather than lie about the delay.
    delay *= this.scale;

    let chunk = 1;
    if (delay < MIN_TICK_MS) {
      chunk = Math.max(1, Math.round(MIN_TICK_MS / Math.max(delay, 1)));
      chunk = Math.min(chunk, (tok?.end ?? this.index + 1) - this.index);
      delay = MIN_TICK_MS;
    }

    this.index += chunk;
    return { chunk, delayMs: delay };
  }
}

/** Wall-clock estimate, used to decide whether a change is too big to sit through. */
export function estimateMs(text: string, opts: PacingOptions): number {
  const t = new Typist(text, opts);
  let total = 0;
  let guard = text.length * 2 + 16;
  while (!t.done && guard-- > 0) total += t.next().delayMs;
  return total;
}

/* ------------------------------------------------------------------- helpers */

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Small deterministic PRNG, so a given file always types the same way. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
