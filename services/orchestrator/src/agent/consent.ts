/**
 * Shared mechanics for the "did the user's current message actually ask for
 * this?" gates that sit in front of every side-effecting tool.
 *
 * Three tools need this — hanging up a call, sending a mail draft, writing to
 * the calendar — and all three defend against the same threat: mail bodies,
 * event descriptions and web pages are attacker-controlled text that the read
 * tools feed straight to the model. The model's own judgement is the first
 * filter; these gates are the backstop that keeps untrusted text from reaching
 * a write at all.
 *
 * What lives here is the machinery: normalisation, Unicode-safe word
 * boundaries, and the match-then-veto evaluation. The *vocabulary* deliberately
 * stays with the tool that owns it — "leg auf" and "lösch den Termin" have
 * nothing to say to each other, and a single shared word list would be edited
 * for one tool and silently change another.
 */

/**
 * Lower-cases and strips punctuation, so a trailing "ab." still reads as its
 * own word and "Schick's" does not hide the verb.
 */
export function normalizeUtterance(value: string): string {
  return value.toLocaleLowerCase("de-DE").replace(/[^\p{L}\p{N}\s]/gu, " ");
}

/**
 * Word boundaries that understand German.
 *
 * `\b` is defined in terms of `\w`, which is ASCII-only, so there is no word
 * boundary before the "ä" in "ändere" and `\bänder` can never match. Every stem
 * built here is anchored with a Unicode-aware lookaround instead. `\w*` is
 * likewise avoided as a suffix wildcard: it stops dead at the first umlaut.
 */
export const WORD_START = "(?<![\\p{L}\\p{N}])";
export const WORD_END = "(?![\\p{L}\\p{N}])";

/** Any letters continuing a stem — the umlaut-safe replacement for `\w*`. */
export const STEM_REST = "[\\p{L}]*";

/**
 * How far a separable prefix may drift from its verb.
 *
 * German routinely puts a whole clause between the two, and a date with a time
 * in it is long. Measured against real utterances:
 *
 *     "trag mir am Montag um zehn den Zahnarzt ein"              36
 *     "zieh meinen Zahnarzt Termin auf den 17 August vor"        42
 *     "sag den Zahnarzt am Dienstag um 14 Uhr bitte ab"          42
 *     "leg mir am Mittwoch um 9 Uhr einen Termin … an"           58
 *
 * This was 40, which refused the last three outright. Widening it costs little:
 * the stem *and* its particle must both appear, and this gate only ever reads
 * the user's own utterance — `lastUserText`, never tool output — so a mail body
 * cannot reach it however it is phrased. The model's own judgement remains the
 * first filter; this is the backstop.
 */
export const GAP = "[\\s\\S]{0,80}";

/**
 * How far ahead of a verb a refusal still counts as one.
 *
 * Deliberately its own constant rather than reusing `GAP`: widening the window
 * for separable prefixes must not silently widen the veto too, or "nicht am
 * 18., sondern verschieb ihn auf den 17." starts reading as a refusal.
 */
export const NEGATION_WINDOW = "[\\s\\S]{0,40}";

/** A pattern matching any of these stems at the start of a word. */
export function verb(...stems: string[]): RegExp {
  return new RegExp(`${WORD_START}(?:${stems.join("|")})`, "u");
}

/** Source for any of these words, as whole words, anywhere in the clause. */
export function particle(...words: string[]): string {
  return `${WORD_START}(?:${words.join("|")})${WORD_END}`;
}

/**
 * A gate's vocabulary: the phrasings that count as a request, and what vetoes
 * one.
 */
export interface ConsentGate {
  /** Affirmative phrasings. The first that matches without a veto wins. */
  patterns: readonly RegExp[];
  /**
   * Vetoes a match — a refusal such as "sende das bitte nicht".
   *
   * @param text  The whole normalised utterance.
   * @param before The part preceding the match, for gates that only accept a
   * refusal ahead of the verb.
   */
  vetoes(text: string, before: string): boolean;
}

/**
 * True when the utterance carries an unambiguous, affirmative request.
 *
 * Match-then-veto rather than veto-then-match: the veto is evaluated per match,
 * so a gate can decide based on where the refusal sits relative to the verb.
 */
export function isExplicitRequest(utterance: string, gate: ConsentGate): boolean {
  const text = normalizeUtterance(utterance);
  for (const pattern of gate.patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    if (gate.vetoes(text, text.slice(0, match.index))) continue;
    return true;
  }
  return false;
}
