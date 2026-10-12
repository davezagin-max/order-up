/**
 * Cuts a stream of text deltas into sentences, so each one can be spoken the
 * moment it is complete instead of waiting for the whole reply.
 *
 * The hard part is that a token stream splits text anywhere: "$8." can arrive
 * before "50", and "Dr." before "Pepper". So a full stop only ends a sentence
 * once the text after it has arrived and looks like the start of a new one.
 */

/** Abbreviations that are followed by a name or a number, never by a new sentence. */
const NEVER_ENDS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "st",
  "vs",
  "e.g",
  "i.e",
  "approx",
  "est",
  "ft",
  "mt",
]);

const TERMINATORS = ".!?…";
const CLOSERS = "\"'”’)]*_";
/** Past this many characters with no sentence end, cut at a clause break so speech can start. */
const SOFT_LIMIT = 220;
const SOFT_MIN = 60;

interface Cut {
  /** Exclusive end of the sentence. */
  end: number;
  /** Where the next sentence starts. */
  next: number;
}

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char);
}

function wordBefore(text: string, index: number): string {
  let start = index;
  while (start > 0 && !isSpace(text[start - 1])) start--;
  return text.slice(start, index).replace(/^[("'“‘[]+/, "");
}

/**
 * Finds the first sentence end in `text`. Returns null when there is none yet,
 * including when a terminator sits at the very end and the next characters
 * could still turn it into a decimal or an abbreviation.
 */
function findCut(text: string, final: boolean): Cut | null {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === "\n") {
      let next = i;
      while (isSpace(text[next])) next++;
      return { end: i, next };
    }
    if (!TERMINATORS.includes(char)) continue;

    let run = i;
    while (run < text.length && TERMINATORS.includes(text[run])) run++;
    let close = run;
    while (close < text.length && CLOSERS.includes(text[close])) close++;

    if (close === text.length) {
      if (final) return { end: close, next: close };
      return null; // Not decidable until more text arrives.
    }
    if (!isSpace(text[close])) {
      // "8.50", "e.g.", "U.S." in the middle of a word: keep going after it.
      i = close - 1;
      continue;
    }
    let next = close;
    let sawNewline = false;
    while (isSpace(text[next])) {
      if (text[next] === "\n") sawNewline = true;
      next++;
    }
    if (next === text.length && !sawNewline) {
      if (final) return { end: close, next };
      return null;
    }

    const stops = text.slice(i, run);
    const questionOrBang = /[!?]/.test(stops);
    if (!questionOrBang && !sawNewline) {
      const word = wordBefore(text, i);
      const following = text[next];
      const abbreviation = stops === "." && NEVER_ENDS.has(word.toLowerCase());
      // "No. 5" is a number, "Oh no. We" is two sentences.
      const numbered = stops === "." && word === "No" && /\d/.test(following ?? "");
      // "J. Smith" is a name. "So do I. Anyway" is not.
      const initial = stops === "." && /^\p{Lu}$/u.test(word) && word !== "I";
      const continues = following !== undefined && /\p{Ll}/u.test(following);
      if (abbreviation || numbered || initial || continues) {
        i = close - 1;
        continue;
      }
    }
    return { end: close, next };
  }
  return null;
}

function softCut(text: string): Cut | null {
  if (text.length <= SOFT_LIMIT) return null;
  const window = text.slice(0, SOFT_LIMIT);
  const clause = Math.max(
    window.lastIndexOf(", "),
    window.lastIndexOf("; "),
    window.lastIndexOf(": "),
    window.lastIndexOf(" — "),
    window.lastIndexOf(" - "),
  );
  if (clause >= SOFT_MIN) {
    const end = text[clause] === " " ? clause : clause + 1;
    return { end, next: clause + (text[clause] === " " ? 3 : 2) };
  }
  const space = window.lastIndexOf(" ");
  return space >= SOFT_MIN ? { end: space, next: space + 1 } : null;
}

export class SentenceChunker {
  private buffer = "";

  /** Text received that is not part of a finished sentence yet. */
  get pending(): string {
    return this.buffer;
  }

  /** Adds streamed text and returns every sentence it completed, in order. */
  push(delta: string): string[] {
    this.buffer += delta;
    return this.drain(false);
  }

  /** The stream ended (or paused for a tool call): whatever is left is a sentence. */
  flush(): string[] {
    const sentences = this.drain(true);
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [...sentences, rest] : sentences;
  }

  private drain(final: boolean): string[] {
    const sentences: string[] = [];
    for (;;) {
      const cut = findCut(this.buffer, final) ?? (final ? null : softCut(this.buffer));
      if (!cut) break;
      const sentence = this.buffer.slice(0, cut.end).trim();
      this.buffer = this.buffer.slice(cut.next);
      if (sentence) sentences.push(sentence);
      if (cut.end === 0 && cut.next === 0) break;
    }
    return sentences;
  }
}

/** Splits a complete text into sentences. Used for scripted lines and tests. */
export function splitSentences(text: string): string[] {
  const chunker = new SentenceChunker();
  return [...chunker.push(text), ...chunker.flush()];
}
