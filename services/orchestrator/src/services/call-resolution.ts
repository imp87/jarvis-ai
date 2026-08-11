import type {
  CallMandateRow,
  CallRepository,
  ContactRepository,
  CandidateSlot,
  MandateRepository,
  TranscriptEntry,
} from "@jarvis/db";
import type { LlmRouter } from "@jarvis/llm";
import type { Logger } from "@jarvis/shared";
import type { AlertService } from "./alerts.js";
import type { CalDavService } from "./caldav.js";
import type { MandateService } from "./mandates.js";

/**
 * What happens after the line goes dead.
 *
 * This is the step that turns a conversation into a calendar entry, and it is
 * the one place where something a stranger said can affect the owner's data.
 * Everything here exists to bound that:
 *
 *   1. the model is asked *which of these slots*, never *what time* — a closed
 *      set, so a misheard sentence cannot invent an appointment;
 *   2. the answer is matched against the mandate's own frozen list in code;
 *   3. the slot is re-checked against the live calendar, because a call takes
 *      minutes and the day can change underneath it;
 *   4. anything that agreed but could not be recorded raises a `fatal` alert —
 *      a commitment exists in someone else's book and the owner does not know.
 */

export interface CallResolutionDeps {
  calls: CallRepository;
  contacts: ContactRepository;
  mandates: MandateRepository;
  mandateService: MandateService;
  caldav: CalDavService;
  router: LlmRouter;
  alerts: AlertService;
  logger: Logger;
  /** Routing profile for the classification. A small model is plenty. */
  profile?: string;
}

export class CallResolutionService {
  constructor(private readonly deps: CallResolutionDeps) {}

  /**
   * Called when the pipeline reports a call finished.
   *
   * Never throws: a failure here must not break the status callback, and the
   * interesting failures raise alerts of their own.
   */
  async onCallCompleted(callId: string): Promise<void> {
    try {
      const mandate = await this.deps.mandates.findByCall(callId);
      // No mandate means the call was an enquiry: nothing was authorised, so
      // there is nothing to record and nothing that can have drifted.
      if (!mandate || mandate.state !== "pending") return;

      if (mandate.expiresAt.getTime() < Date.now()) {
        await this.deps.mandates.resolve(mandate.id, { state: "expired" });
        return;
      }

      const transcript = await this.deps.calls.transcriptOf(callId);
      if (transcript.length === 0) {
        await this.deps.mandates.resolve(mandate.id, {
          state: "declined",
          note: "nobody spoke on this call",
        });
        return;
      }

      const slot = await this.classify(mandate, transcript);
      if (!slot) {
        // Either nothing was agreed, or it could not be told apart. Both are
        // reported rather than guessed at — but they are not the same as a
        // failure, because nothing was promised that we know of.
        await this.deps.mandates.resolve(mandate.id, {
          state: "unresolved",
          note: "no slot from the approved set was clearly agreed",
        });
        await this.deps.alerts.raise({
          userId: mandate.userId,
          event: "mandate_unresolved",
          severity: "warning",
          body:
            `Der Anruf wegen „${mandate.errand}" ist beendet, aber ich konnte keinen der ` +
            "freigegebenen Termine eindeutig als vereinbart erkennen. Bitte kurz selbst nachsehen.",
          context: { callId, mandateId: mandate.id },
          idempotencyKey: `mandate_unresolved:${mandate.id}`,
        });
        return;
      }

      await this.deps.mandates.resolve(mandate.id, {
        state: "agreed",
        agreedSlotId: slot.id,
      });
      await this.record(mandate, slot, callId);
    } catch (err) {
      this.deps.logger.error(
        { callId, err: String(err) },
        "call resolution failed",
      );
    }
  }

  /**
   * Asks which slot was agreed, and accepts only an id from the frozen list.
   *
   * The prompt is built here rather than by the agent loop: this must not be a
   * conversation, must not have tools, and must not be able to do anything but
   * name one of the options.
   */
  private async classify(
    mandate: CallMandateRow,
    transcript: TranscriptEntry[],
  ): Promise<CandidateSlot | undefined> {
    const slots = mandate.candidateSlots ?? [];
    if (slots.length === 0) return undefined;

    const options = slots
      .map((slot) => `${slot.id} = ${new Date(slot.startsAt).toISOString()}`)
      .join("\n");
    const dialogue = transcript
      .map((entry) => `${entry.speaker === "agent" ? "Assistent" : "Gegenüber"}: ${entry.text}`)
      .join("\n");

    const response = await this.deps.router.chat(this.deps.profile ?? "classify", {
      system:
        "You decide which of a fixed list of appointment slots was agreed in a phone call.\n" +
        "Answer with EXACTLY ONE token: the slot id, or `none`.\n" +
        "Answer `none` unless both sides clearly settled on that specific slot. A slot that was " +
        "merely offered, considered or asked about is not agreed. Never invent an id, never " +
        "explain, never output a date.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Freigegebene Termine:\n${options}\n\nGesprächsprotokoll:\n${dialogue}`,
            },
          ],
        },
      ],
    });

    const answer = response.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join(" ");
    const slot = this.deps.mandateService.matchAgreedSlot(mandate, answer);
    this.deps.logger.info(
      { mandateId: mandate.id, answer: answer.trim().slice(0, 40), matched: slot?.id ?? null },
      "call outcome classified",
    );
    return slot;
  }

  /**
   * Writes the agreed slot to the calendar.
   *
   * Authorised by the mandate, not by the transcript: consent was established
   * against a real user message before the call was placed, which is why this
   * may call `createEvent` directly rather than going through the calendar
   * tool's own gate.
   */
  private async record(
    mandate: CallMandateRow,
    slot: CandidateSlot,
    callId: string,
  ): Promise<void> {
    const start = new Date(slot.startsAt);
    const end = new Date(slot.endsAt);

    const fail = async (event: string, body: string, note: string): Promise<void> => {
      await this.deps.mandates.resolve(mandate.id, { state: "agreed", note });
      // Fatal: the appointment exists in somebody else's book and the owner's
      // calendar does not know. Only they can resolve that, and not knowing
      // means missing it — this is the one class allowed to break quiet hours.
      await this.deps.alerts.raise({
        userId: mandate.userId,
        event,
        severity: "fatal",
        body,
        context: { callId, mandateId: mandate.id, startsAt: slot.startsAt },
        idempotencyKey: `${event}:${mandate.id}`,
      });
    };

    const when = new Intl.DateTimeFormat("de-DE", {
      dateStyle: "full",
      timeStyle: "short",
    }).format(start);

    // Re-checked against the live calendar: a call takes minutes, and the slot
    // was frozen before it started.
    const { events } = await this.deps.caldav.listEvents(mandate.userId, start, end);
    if (events.length > 0) {
      await fail(
        "mandate_slot_conflict",
        `Beim Anruf wegen „${mandate.errand}" wurde ${when} vereinbart — inzwischen steht in ` +
          "deinem Kalender aber schon etwas anderes. Der Termin ist zugesagt und NICHT eingetragen.",
        "agreed slot was no longer free",
      );
      return;
    }

    const targets = await this.deps.caldav.writableCalendars(mandate.userId);
    const target = targets[0];
    if (!target) {
      await fail(
        "mandate_write_failed",
        `Beim Anruf wegen „${mandate.errand}" wurde ${when} vereinbart, aber es gibt keinen ` +
          "beschreibbaren Kalender. Der Termin ist zugesagt und NICHT eingetragen.",
        "no writable calendar",
      );
      return;
    }

    // Named after who it is with, not after why the call was made. `errand` is
    // the opening statement — a whole sentence, and a useless calendar entry
    // ("Nach einem Friseurtermin für Steven am 13. August 2026 fragen").
    const contact = mandate.contactId
      ? await this.deps.contacts.get(mandate.userId, mandate.contactId).catch(() => null)
      : null;
    const summary = contact ? `Termin: ${contact.name}` : "Telefonisch vereinbarter Termin";

    try {
      await this.deps.caldav.createEvent(target.account, target.calendar, {
        summary,
        location: null,
        description: `Telefonisch vereinbart.

${mandate.errand}`,
        start,
        end,
        allDay: false,
      });
    } catch (err) {
      await fail(
        "mandate_write_failed",
        `Beim Anruf wegen „${mandate.errand}" wurde ${when} vereinbart, aber der Kalender ` +
          `konnte nicht geschrieben werden (${String(err).slice(0, 120)}). Der Termin ist ` +
          "zugesagt und NICHT eingetragen.",
        "calendar write failed",
      );
      return;
    }

    await this.deps.mandates.resolve(mandate.id, { state: "recorded" });
    this.deps.logger.info(
      { mandateId: mandate.id, callId, startsAt: slot.startsAt },
      "call outcome recorded in the calendar",
    );
    await this.deps.alerts.raise({
      userId: mandate.userId,
      event: "mandate_recorded",
      severity: "info",
      body: `Termin vereinbart und eingetragen: ${when} — ${mandate.errand}.`,
      context: { callId, mandateId: mandate.id },
      idempotencyKey: `mandate_recorded:${mandate.id}`,
    });
  }
}
