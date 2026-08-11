# Outbound appointment calls

Status: **design**, nothing below is implemented.
Written 2026-08-11, after the live test that produced the log in `call_logs`
`453b7ba3`.

The goal, in the owner's words:

> „Ruf bei meinem Friseur an und vereinbare einen Termin zu einer Zeit, an der
> ich verfügbar bin."

and afterwards the appointment is in his calendar, without him typing anything.

## Why this is not just another tool

Everything the agent does today changes state the owner controls. A calendar
event can be deleted, a draft is not a mail until it is sent, a call to the
owner's own phone is at worst annoying.

An agreement spoken to a third party is different in kind:

| Action | Reversible | Whose system |
| --- | --- | --- |
| `create_event` / `update_event` | yes, `delete_event` | the owner's CalDAV |
| mail reply draft | yes, until sent | local |
| `place_phone_call` (today) | rings the owner's own phone | local |
| **"Dienstag 14 Uhr, ja" on the phone** | **no** | **a stranger's booking system** |

Once said, a slot is blocked for other customers, someone expects the owner to
show up, and some businesses charge for a no-show. We cannot see that record,
cannot change it, cannot delete it — only call again and ask.

The operationally nasty part is **drift**: agreeing on the phone and writing the
calendar are two systems with no shared transaction. If the write fails, the
appointment still exists — only at the hairdresser. Of the two sides, the
binding one is the one we do not control. That is the failure this whole design
is shaped around, and it is why `severity = 'fatal'` in the notification outbox
exists (migration `013`).

## What the live test showed

The test on 2026-08-11 16:19 exercised the current code end to end. Three
things it established, all of them by design rather than by bug:

1. **The number in the message was never used.** `place_phone_call` hardcodes
   `toNumber: deps.ownerPhoneNumber` and its `inputSchema` has no number field.
   The call went to the owner. It looked like it worked only because the owner
   deliberately gave his own number.
2. **The confirmation was invented.** The tool returns `Call placed (id …)`
   after 27 ms; the line was answered seven seconds later. "Ich habe den Friseur
   angerufen und deine freien Zeiträume genannt" was produced with no
   information whatsoever.
3. **There is no return path.** `PATCH /v1/calls/:id/status` writes a status and
   calls `mailDelivery.onCallStatus()`. No transcript, no result, nothing that
   reaches the agent. `call_logs.transcript` exists and has never been written.

## Scope

The owner's framing: *"dem Assistenten möglichst viel abgeben um selbst Zeit zu
sparen"* — the errands he does not want to make himself.

| The agent may | |
| --- | --- |
| ask questions | "ob mein Auto fertig ist", "ob sie glutenfrei haben" |
| agree an appointment | within slots pre-approved from his own calendar |
| cancel a named appointment | one specific event, identified in advance |
| **commit money or contracts** | **no** |

Money and contracts are out, and not out of caution for its own sake: there is
no closed set to construct. "These five obligations are fine in advance" is not
a thing anyone can write down. A spending ceiling would formally be one, but
that is a separate design and nothing here needs it.

### Asking and booking are the same call

An early draft split these into separate errand types. That was wrong, and the
owner said so: if the Bürgeramt answers "ja, brauchen Sie einen Termin, Dienstag
10 Uhr wäre frei", an agent that may only ask has to hang up and call back — by
which time the slot is gone. That is exactly the round trip this feature is
meant to remove.

Real calls become bookings mid-conversation. So the closed set is not attached
to an errand type; it is attached to **the mandate**, and the booking authority
travels with the call from the start.

## The central idea: a mandate

The authorisation for the calendar write comes from **the owner's instruction,
issued before the call, and it is bounded**. Not from the transcript.

When the owner says "ruf an und vereinbare einen Termin", the system:

1. checks that his *current* message really says so (the existing consent-gate
   machinery in `agent/consent.ts`),
2. reads the calendar and computes **concrete candidate slots**,
3. writes a `call_mandates` row holding those slots,
4. only then places the call.

During and after the call, the other party can only **select** one of those
slots. They can never introduce a value.

| | without a mandate | with a mandate |
| --- | --- | --- |
| Who determines the time | the stranger on the phone | the owner, in advance |
| What the stranger can do | set an arbitrary value | pick one of N |
| What the model can do | interpret and write | identify which one |
| Untrusted input reaches | the calendar | a closed-set choice |

This is the same shape as everything else that already works here: the dangerous
value never originates from the untrusted source. The calendar gate keeps mail
bodies out of writes; contacts keep model-supplied numbers out of the dialler;
the mandate keeps a stranger's speech out of the calendar.

## Data model

Three additions. Two tables and one column.

### `contacts`

```sql
CREATE TABLE contacts (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         text NOT NULL,              -- "Friseur", "Salon Meier"
    phone_e164   text NOT NULL,              -- normalisePhoneNumber() on write
    note         text,
    -- Knowing a number is not permission to dial it.
    allow_calls  boolean NOT NULL DEFAULT false,
    -- Set in code, never asserted by the model.
    created_by   text NOT NULL CHECK (created_by IN ('user', 'agent')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);
```

Deliberately **not** `memories`: that table is model-writable through
`memory_save`, so a number read out of a mail body could become a "contact",
and its retrieval is vector similarity — right for "what did he say about the
holiday", wrong for a value that triggers an irreversible call.

The agent may **create** contacts (`contact_create`), which land with
`allow_calls = false`. It may not update or delete them. That restriction is the
important one: if the model could edit an existing row, an injected "unsere neue
Nummer lautet …" would inherit the approval already granted to that name. On a
name collision the tool reports the conflict and changes nothing.

This mirrors the mail flow exactly — `create_reply_draft` is free, sending needs
the owner.

### `call_mandates`

```sql
CREATE TABLE call_mandates (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    contact_id     uuid NOT NULL REFERENCES contacts (id) ON DELETE RESTRICT,
    call_log_id    uuid REFERENCES call_logs (id) ON DELETE SET NULL,

    -- The errand, in the owner's own words. Drives the opening sentence only —
    -- it grants nothing. Everything the agent may *do* is in the authorities
    -- below, so a rephrasing cannot widen the errand.
    errand         text NOT NULL,              -- "ob ich für die Ummeldung einen Termin brauche"

    -- Asking is always allowed; it commits nothing.
    -- Booking is allowed only when `candidate_slots` is present. The set is
    -- computed from the calendar BEFORE dialling and frozen here, so an
    -- agreement can only ever be one of these — and it travels with the call
    -- from the start, so a question that turns into a booking needs no
    -- second call.
    candidate_slots jsonb,                     -- [{id, startsAt, endsAt}] or null
    duration_minutes integer,
    -- Cancelling is allowed only for this one event, named in advance.
    cancel_event_uid text,

    -- After this the mandate is dead, so a queued call that never went out
    -- cannot be resolved into an appointment days later.
    expires_at     timestamptz NOT NULL,

    state          text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','calling','agreed','recorded',
                         'declined','unresolved','failed','expired')),
    -- Which slot was agreed. Always one of candidate_slots, or null.
    agreed_slot_id text,
    event_uid      text,                        -- once written to CalDAV
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
```

### `call_logs.transcript`

Already exists, never written. The return path fills it. It is the audit trail
for a commitment made in the owner's name, so it is the one part of this that
must not be optional.

### When booking authority is granted

From the owner's own words, decided in code by the `agent/consent.ts`
machinery — never by the model's reading of intent:

| His message | matched | authorities |
| --- | --- | --- |
| "…ob ich für die Ummeldung einen **Termin** brauche" | `termin` | ask **+ book** |
| "Ruf bei der Werkstatt an, ob mein Auto fertig ist" | — | ask only |
| "Frag im Restaurant, ob sie glutenfrei haben" | — | ask only |
| "Frag ob sie glutenfrei haben und **reservier** gleich" | `reservier` | ask **+ book** |

Mentioning anything appointment-shaped costs one CalDAV read and carries the
slots along — cheaper than a second call. Mentioning nothing means the agent
cannot agree to anything, and an appointment offered by the other side is
reported back instead of accepted.

The alternative — always attaching slots — was considered and rejected: "frag
mal ob die überhaupt Termine vergeben" should not end with a booked
appointment. This is one function and a word list, so it is cheap to revisit if
it proves annoying in practice.

## Flow

```
owner: "Frag beim Bürgeramt, ob ich für die Ummeldung einen Termin brauche"
   │
   ├─ 1. consent gate on the CURRENT message  (isExplicitCallRequest)
   │       no → ask, stop.  This is the only place consent is checked,
   │            and it is the only place a current user message exists.
   │
   ├─ 2. resolve the number                    two provable sources only:
   │       a) contacts, allow_calls = true, by NAME
   │       b) literally present in his current message (normalisePhoneNumber
   │          over ctx.lastUserText — never a value the model supplied)
   │       ambiguous → ask which one (same shape as resolveEvent)
   │
   ├─ 3. grant authorities from his own words
   │       appointment-shaped word?  → compute free slots from CalDAV
   │                                    and attach them
   │       otherwise                 → ask only; nothing may be agreed
   │       (no free slots at all)    → still call, ask only, say so
   │
   ├─ 4. write call_mandates row (state=pending), freeze the authorities
   │
   ├─ 5. place the call     place_phone_call(mandateId)   state=calling
   │
   ├─ 6. the conversation   voice-pipeline, script bounded by the mandate
   │
   ├─ 7. return path        transcript + outcome → orchestrator
   │       ask only        → report the answer as untrusted text. Done.
   │       booking allowed → classify against the CLOSED SET:
   │                         which slot id, or none / unclear
   │
   ├─ 8. verify in code     slot ∈ candidate_slots?     still free?
   │                        mandate open?  not expired?
   │
   └─ 9. write the calendar, authorised by the MANDATE, not the transcript
           state=recorded, tell the owner
```

Steps 7–9 only run for a mandate that carried booking authority. An ask-only
call ends at step 7 with an answer and no state anywhere else — which is why it
has no fatal failure mode: nothing was committed, so nothing can drift.

### Step 7 is a classification, not an extraction

The model is asked *which of these slots was agreed*, and may answer only with
one of the slot ids or `none` / `unclear`. It is never asked to produce a date.
An STT error on "vierzehn Uhr" versus "vierzig" cannot invent a time that was
not already approved — the worst case is picking the wrong one of the owner's
own free slots, which step 8 then re-verifies.

### Step 9 does not weaken the calendar consent gate

`isExplicitCalendarRequest` lives in the **tool** (`agent/tools/calendar.ts`),
not in `CalDavService`. The mandate resolver calls `caldav.createEvent()`
directly, exactly as the tool does after its gate passes. Consent was already
established at step 1, against a real user message. The gate is not bypassed;
it is checked earlier, once, where it is meaningful.

This is the part to be most careful with in review. The rule is: **nothing may
reach `createEvent` except through a mandate whose step 1 passed.**

## What the agent may say on the phone

Enforced by the call script, which is built from the mandate in code — not
composed by the model:

- **Announce itself.** "Guten Tag, ich bin der digitale Assistent von
  Steven Dautrich und rufe in seinem Auftrag an." Not optional: legally advisable,
  and the other party deserves to know.
- **Never commit money or a contract.** No deposits, no cancellation terms, no
  orders, no other services. This holds regardless of what the mandate grants,
  because no mandate can grant it.
- **Give no personal data beyond the owner's name** and what the errand needs.

With booking authority:

- **Propose only slots from the mandate.** Nothing else may be offered.
- **When none of them fit**, the answer is "ich melde mich noch einmal", then
  hang up with no commitment. Never improvise a time.

Ask-only:

- **Agree to nothing at all.** If the other side offers an appointment — "soll
  ich Ihnen gleich einen Termin geben?" — the answer is "ich halte Rücksprache",
  and it is reported back.

The "never improvise" rule is what keeps the closed set closed. An agent that
may say "dann eben Donnerstag" has re-opened everything this design closes.

## Failure modes

Each maps onto the notification outbox from migration `013`.

| What happened | State | Alert | Severity |
| --- | --- | --- | --- |
| Agreed, calendar write failed | `agreed` | `mandate_write_failed` | **fatal** |
| Agreed a slot no longer free | `agreed` | `mandate_slot_conflict` | **fatal** |
| Agreed something outside the set | `agreed` | `mandate_out_of_scope` | **fatal** |
| Call happened, outcome unclear | `unresolved` | `mandate_unresolved` | warning |
| Nobody answered / declined | `declined` | `mandate_declined` | info |
| Contact not callable | — | `contact_not_callable` | info |
| Ask-only call, answer obtained | `recorded` | — (reported in chat) | — |

The three fatals are all the same underlying event: **a commitment exists out
there and the owner does not know about it.** Only he can resolve that, and not
knowing means missing it, so those are the ones allowed to break quiet hours on
their own small budget (`SYSTEM_ALERT_CALLS_PER_HOUR/_PER_DAY`).

Note that "agreed something outside the set" is *not* written to the calendar.
The commitment is real, but recording it would mean the untrusted side chose the
value after all. The owner is told and decides.

## Testing without calling a stranger

The owner's constraint: *"ich teste ihn sehr ausgiebig bevor er irgendwo anrufen
soll"*. This shapes the build order rather than being a caveat on it — the whole
feature can be exercised end to end against his own phone, which the 2026-08-11
test already proved works.

| Phase | What is testable | Strangers called |
| --- | --- | --- |
| 1 Contacts | name → number resolution, `allow_calls` blocking, `contact_create` refusing to overwrite | **none** |
| 2 Mandate (dry run) | `POST /v1/mandates/preview` returns contact, slots, authorities and the opening line without dialling — dozens of phrasings, no calls | **none** |
| 3 Return path | call his own number, he plays the other party, transcript lands in `call_logs.transcript` | **none** |
| 4 Resolution | he plays the other party, agrees a slot, checks the calendar entry appears — complete end to end | **none** |

Phase 2 holds the interesting bugs and costs no calls at all.

**The test harness already exists**: a `contacts` row named "Friseur" pointing at
his own number, with `allow_calls = true`, and nothing else enabled. Per-contact
approval *is* the switch; no separate test mode is needed.

On top of that, a global `OUTBOUND_CALLS_ENABLED`, defaulting to `false`. After
a deploy the system dials nowhere until two separate things are deliberately
switched on.

## Phases

Each is independently useful and independently reviewable.

1. **Contacts.** Table, repository, admin UI, `contact_create` tool.
   `place_phone_call` takes a contact *name*, or a number taken in code from the
   owner's own message, instead of always dialling him.
   *Testable without any call: does the right number resolve?*
2. **Mandate, without dialling.** Consent gate, authority granting, slot
   computation, mandate row, and a dry-run endpoint returning what *would*
   happen.
   *This is where the interesting bugs are, and none of them cost a phone call.*
3. **Return path.** Voice pipeline sends transcript and outcome; orchestrator
   stores it in `call_logs.transcript`. Still no calendar write.
4. **Resolution.** Closed-set classification, step-8 verification, calendar
   write, alert wiring.
5. **Hardening.** Retry of an unresolved mandate, admin UI for open mandates,
   expiry sweep.

Phase 1 and 2 remove every failure the live test exposed, without the system
ever placing a call to a stranger.

## Open questions and honest risks

- **The other party did not agree to talk to a machine.** Announcing it is the
  minimum. Some will hang up; that is their right and the design must treat it
  as a normal outcome, not an error.
- **Storing a stranger's words.** `call_logs.transcript` is personal data
  belonging to someone who is not a user of this system. It is needed for audit,
  so it needs a retention limit — not yet designed.
- **The model is still in the loop** at step 7. The closed set bounds the damage
  to "wrong slot among the owner's own free ones", and step 8 re-verifies, but it
  does not eliminate misclassification.
- **Slot staleness.** A call takes minutes. Between mandate and write, the
  calendar can change. Step 8 re-checks; a conflict becomes a fatal alert rather
  than an overwrite.
- **The errand is free text; the authorities are not.** `errand` only shapes the
  opening sentence. Everything the agent may *cause* lives in the authority
  fields, each of which is a closed set fixed before dialling. A cleverer
  phrasing cannot widen what may be agreed, because phrasing is not what grants
  it.
- **Money and contracts stay out** until someone can write down the closed set
  for them. A spending ceiling is formally one, and would be the obvious first
  extension — but it is its own design, not a field to add quietly.
