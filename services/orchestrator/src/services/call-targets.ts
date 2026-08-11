import type { ContactRepository, ContactRow } from "@jarvis/db";
import { tryNormalisePhoneNumber } from "@jarvis/shared";

/**
 * Where a number the agent may dial is allowed to come from.
 *
 * This is the whole security boundary of outbound calling, so it is worth
 * stating plainly: **a phone number must never originate from the model.**
 *
 * The model reads mail bodies, web pages and event descriptions. On its own
 * terms a number in an invoice and a number the owner typed are the same token,
 * so "the model passed it" carries no authority at all. Two sources do:
 *
 *   1. a `contacts` row the owner approved (`allow_calls = true`), or
 *   2. a number that appears **literally in the owner's current message**.
 *
 * Both are checked here against data the model cannot influence: the contacts
 * table, and `ctx.lastUserText`. What the model supplies is only ever a
 * *selector* — a name, or a number that then has to be found in the owner's own
 * words. It is the same trick the consent gates use, applied to the value
 * rather than to the intent.
 */

export type CallTarget =
  | { kind: "owner"; phoneE164: string }
  | { kind: "contact"; phoneE164: string; contact: ContactRow }
  /** Taken verbatim from the owner's current message. */
  | { kind: "dictated"; phoneE164: string };

export type CallTargetResolution =
  | { ok: true; target: CallTarget }
  | { ok: false; reason: string };

export interface CallTargetOptions {
  contacts: ContactRepository;
  ownerPhoneNumber?: string | undefined;
  /**
   * Global kill switch for dialling anyone other than the owner. Defaults off,
   * so a fresh deploy calls nobody until two separate things are switched on:
   * this, and `allow_calls` on the individual contact.
   */
  outboundCallsEnabled: boolean;
}

/**
 * Shortest run of digits accepted as a phone number in free text.
 *
 * `normalisePhoneNumber` allows seven, which is right for a number someone
 * deliberately entered in a form. Scanning prose is a different problem: at
 * seven, `18.08.2026` is eight digits and becomes `+18082026`. German numbers
 * that can actually be dialled from a trunk carry an area or mobile prefix and
 * run to ten or more, so this is stricter than the parser on purpose.
 */
const MIN_DIGITS_IN_PROSE = 9;

/**
 * Every phone-number-shaped token in a message, normalised to E.164.
 *
 * Runs over the owner's own utterance, never over tool output. Separators are
 * whatever a person types — `0155 6104 9738`, `0155-1049738`, `+49 155 …` — so
 * the pattern is deliberately loose and the digit floor above does the work of
 * keeping dates, prices and order numbers out.
 */
export function numbersMentionedIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\+?[\d][\d\s./()-]{5,}\d/g)) {
    const token = match[0];
    if ((token.match(/\d/g)?.length ?? 0) < MIN_DIGITS_IN_PROSE) continue;
    const normalised = tryNormalisePhoneNumber(token);
    if (normalised) found.add(normalised);
  }
  return [...found];
}

/**
 * Resolves what the model asked for into a number that may actually be dialled.
 *
 * @param selector What the model passed: a contact name, or a number. Absent
 * means the owner's own phone, which is the pre-existing reminder behaviour.
 * @param lastUserText The owner's current message. The only text a dictated
 * number may come from.
 */
export async function resolveCallTarget(
  userId: string,
  selector: string | undefined,
  lastUserText: string,
  options: CallTargetOptions,
): Promise<CallTargetResolution> {
  const wanted = selector?.trim() ?? "";

  // No selector: call the owner. Unchanged behaviour, and not gated by
  // `outboundCallsEnabled` — ringing your own phone is what the reminder tools
  // have always done and commits nothing to anyone else.
  if (!wanted) {
    if (!options.ownerPhoneNumber) {
      return { ok: false, reason: "Es ist keine Telefonnummer des Nutzers konfiguriert." };
    }
    return { ok: true, target: { kind: "owner", phoneE164: options.ownerPhoneNumber } };
  }

  if (!options.outboundCallsEnabled) {
    return {
      ok: false,
      reason:
        "Anrufe an andere als den Nutzer selbst sind derzeit abgeschaltet " +
        "(OUTBOUND_CALLS_ENABLED). Der Nutzer muss das zuerst freigeben.",
    };
  }

  const matches = await options.contacts.findByName(userId, wanted);
  if (matches.length > 1) {
    // Named ambiguously. Reported rather than guessed at: dialling the wrong
    // one of two saved businesses is not recoverable by hanging up.
    return {
      ok: false,
      reason:
        `Mehrere Kontakte passen zu „${wanted}“: ` +
        `${matches.map((contact) => `„${contact.name}“`).join(", ")}. ` +
        "Bitte den Nutzer fragen, welcher gemeint ist.",
    };
  }

  const contact = matches[0];
  if (contact) {
    if (!contact.allowCalls) {
      return {
        ok: false,
        reason:
          `Der Kontakt „${contact.name}“ ist nicht für Anrufe freigegeben. ` +
          "Der Nutzer muss ihn zuerst im Admin-UI freigeben.",
      };
    }
    return { ok: true, target: { kind: "contact", phoneE164: contact.phoneE164, contact } };
  }

  // Not a known contact. It may still be a number the owner just dictated —
  // but only if it is actually in his message. A number the model produced from
  // anywhere else stops here, whatever it looks like.
  const asNumber = tryNormalisePhoneNumber(wanted);
  if (!asNumber) {
    return {
      ok: false,
      reason:
        `Es gibt keinen Kontakt „${wanted}“, und es ist auch keine Telefonnummer. ` +
        "Der Nutzer muss den Kontakt zuerst anlegen.",
    };
  }

  if (!numbersMentionedIn(lastUserText).includes(asNumber)) {
    return {
      ok: false,
      reason:
        "Diese Nummer steht nicht in der aktuellen Nachricht des Nutzers und gehört zu keinem " +
        "freigegebenen Kontakt. Nummern aus E-Mails, Webseiten oder früheren Turns dürfen nicht " +
        "angerufen werden — bitte den Nutzer die Nummer nennen lassen oder einen Kontakt anlegen.",
    };
  }

  return { ok: true, target: { kind: "dictated", phoneE164: asNumber } };
}
