import type {
  CallMandateRow,
  CandidateSlot,
  MandateRepository,
} from "@jarvis/db";
import type { Logger } from "@jarvis/shared";
import { GAP, STEM_REST, isExplicitRequest, particle, verb } from "../agent/consent.js";
import { computeFreeSlots, describeSlots } from "./free-slots.js";
import type { CalDavService } from "./caldav.js";

/**
 * The mandate: what the agent was allowed to agree to, decided before it dialled.
 *
 * The whole design turns on one property — **the far end never supplies a
 * value**. It selects from a set computed out of the owner's own calendar and
 * frozen before the call. A misheard sentence can at worst pick the wrong one
 * of the owner's own free slots; it cannot invent a time, and it cannot reach
 * the calendar by saying something.
 */

/**
 * Does the owner's own message contemplate an appointment?
 *
 * Grants the booking authority, so it reads the owner's words and nothing else
 * — the same rule as every other gate here. Mentioning anything
 * appointment-shaped costs one CalDAV read and carries the slots along, which is
 * far cheaper than a second phone call; mentioning nothing means the agent may
 * ask but may agree to nothing.
 */
const APPOINTMENT_WORDS: readonly RegExp[] = [
  verb(`termin${STEM_REST}`),
  verb(`reservier${STEM_REST}`, `buch${STEM_REST}`),
  verb(`anmeld${STEM_REST}`, `vereinbar${STEM_REST}`),
  verb(`(?:ein)?trag${STEM_REST}${GAP}${particle("kalender", "ein")}`),
  verb(`kalender${STEM_REST}`),
];

export function grantsBookingAuthority(utterance: string): boolean {
  return isExplicitRequest(utterance, { patterns: APPOINTMENT_WORDS, vetoes: () => false });
}

export interface MandateServiceDeps {
  mandates: MandateRepository;
  caldav: CalDavService;
  logger: Logger;
  timezone: string;
  /** How far ahead slots may be offered. */
  horizonDays?: number;
  defaultDurationMinutes?: number;
}

export class MandateService {
  constructor(private readonly deps: MandateServiceDeps) {}

  /**
   * Freezes what this call may agree to.
   *
   * Returns undefined when the errand grants no booking authority — the call
   * still happens, the agent may still ask, but nothing it hears can become an
   * appointment.
   */
  async createForCall(input: {
    userId: string;
    callLogId: string;
    contactId?: string | null;
    errand: string;
    /** The owner's own message. Decides whether booking is authorised at all. */
    ownerUtterance: string;
    now?: Date;
  }): Promise<CallMandateRow | undefined> {
    const now = input.now ?? new Date();

    // A mandate is always written, even when nothing may be agreed: it is the
    // record of *what this call is for*, and the booking authority is only an
    // optional extra on top.
    //
    // Without this, a call that merely carries a message stored its errand
    // nowhere, and the first delegated turn arrived knowing only that a call
    // was in progress. It then told the person it had rung that it did not know
    // why it was calling.
    if (!grantsBookingAuthority(input.ownerUtterance)) {
      return this.deps.mandates.create({
        userId: input.userId,
        callLogId: input.callLogId,
        contactId: input.contactId ?? null,
        errand: input.errand,
        candidateSlots: null,
        durationMinutes: null,
        expiresAt: new Date(now.getTime() + 6 * 3_600_000),
      });
    }

    const horizonDays = this.deps.horizonDays ?? 14;
    const durationMinutes = this.deps.defaultDurationMinutes ?? 60;
    // A slot must be far enough out that the business can still take it — and
    // that the owner is not committed to something starting in ten minutes.
    const from = new Date(now.getTime() + 2 * 3_600_000);
    const to = new Date(now.getTime() + horizonDays * 86_400_000);

    let slots: CandidateSlot[] = [];
    try {
      const timezone = await this.deps.caldav.timezoneFor(input.userId);
      const { events } = await this.deps.caldav.listEvents(input.userId, from, to);
      slots = computeFreeSlots(
        events.map((view) => ({ start: view.event.start, end: view.event.end })),
        { from, to, durationMinutes, timezone },
      );
    } catch (err) {
      // A calendar that cannot be read means no closed set, which means no
      // booking authority. The call still goes ahead as an enquiry rather than
      // being cancelled — but nothing it hears can be agreed to.
      this.deps.logger.warn(
        { userId: input.userId, err: String(err) },
        "could not read the calendar for a call mandate; the call may ask but not agree",
      );
      return undefined;
    }

    if (slots.length === 0) {
      this.deps.logger.info(
        { userId: input.userId },
        "no free slots in the horizon; the call may ask but not agree",
      );
      return undefined;
    }

    const mandate = await this.deps.mandates.create({
      userId: input.userId,
      callLogId: input.callLogId,
      contactId: input.contactId ?? null,
      errand: input.errand,
      candidateSlots: slots,
      durationMinutes,
      // Dead well before the first slot could be reached, so a call file stuck
      // in the spool cannot turn into an appointment days later.
      expiresAt: new Date(now.getTime() + 6 * 3_600_000),
    });
    this.deps.logger.info(
      { mandateId: mandate.id, callId: input.callLogId, slots: slots.length },
      "call mandate created",
    );
    return mandate;
  }

  /**
   * What the agent is told about its own authority during the call.
   *
   * Injected per turn from the database rather than carried in the model's
   * context: the set has to be the frozen one, not a remembered one.
   */
  briefingFor(mandate: CallMandateRow | null, timezone: string): string {
    if (!mandate?.candidateSlots?.length) {
      return (
        "Du darfst in diesem Gespräch NUR fragen. Du darfst keinen Termin zusagen und nichts " +
        "vereinbaren. Bietet die Gegenseite einen Termin an, sag, dass du das weitergibst."
      );
    }
    return [
      "Freigegebene Termine — du darfst AUSSCHLIESSLICH einen davon zusagen:",
      describeSlots(mandate.candidateSlots, timezone),
      "",
      "Passt keiner davon, sag höflich, dass du dich noch einmal meldest, und sage NICHTS zu. " +
        "Erfinde niemals eine andere Uhrzeit. Wenn ihr euch auf einen dieser Termine einigt, " +
        "wiederhole Tag und Uhrzeit deutlich, damit es im Protokoll steht.",
    ].join("\n");
  }

  /**
   * Which of the frozen slots was agreed — the only question asked of the model.
   *
   * A classification over a closed set, never an extraction. The model may
   * answer with one of the ids or `none`; it is never asked to produce a date,
   * so an STT error on "vierzehn" versus "vierzig" cannot invent a time that
   * was not already approved.
   */
  matchAgreedSlot(mandate: CallMandateRow, answer: string): CandidateSlot | undefined {
    const cleaned = answer.trim().toLowerCase();
    // Anchored to the whole answer: a model that replies "none of s1, s2" must
    // not be read as having picked s1.
    const match = /^\s*(s\d+)\s*$/.exec(cleaned);
    if (!match) return undefined;
    return mandate.candidateSlots?.find((slot) => slot.id === match[1]);
  }
}
