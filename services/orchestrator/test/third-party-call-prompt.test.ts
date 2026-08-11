import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "../src/agent/prompt.js";

const base = {
  ownerName: "Steven",
  timezone: "Europe/Berlin",
  now: new Date("2026-08-11T17:49:00Z"),
  memoryContext: null,
};

/** The owner guidance instructs the persona; the third-party one forbids it. */
const ADDRESS_AS_MASTER = /Address the caller as 'Master'/;
const NEVER_MASTER = /never address them as 'Master'/;

test("a call to the owner keeps the butler persona", () => {
  const prompt = buildSystemPrompt({ ...base, channel: "voice_call" as const });
  assert.match(prompt, ADDRESS_AS_MASTER);
  assert.doesNotMatch(prompt, NEVER_MASTER);
});

test("a call to a third party never addresses them as the owner", () => {
  // The failure this exists for: on the first real third-party call the
  // assistant said "Master" five times to a hairdresser.
  //
  // The word itself still appears — inside the prohibition. Asserting on its
  // absence would pass for a prompt that simply never mentions the persona,
  // which is not the same thing as forbidding it.
  const prompt = buildSystemPrompt({
    ...base,
    channel: "voice_call" as const,
    counterpart: "third_party" as const,
  });
  assert.doesNotMatch(prompt, ADDRESS_AS_MASTER);
  assert.match(prompt, NEVER_MASTER);
  assert.match(prompt, /NOT YOUR OWNER/);
});

test("a third-party call is told not to promise a calendar entry", () => {
  // It said "der Termin wird … in den Kalender eingetragen" — a promise to a
  // stranger that nothing in the system can keep.
  const prompt = buildSystemPrompt({
    ...base,
    channel: "voice_call" as const,
    counterpart: "third_party" as const,
  });
  assert.match(prompt, /Promise nothing you cannot verify/);
  assert.match(prompt, /pass it on|pass the details on/);
});

test("what the third party says is data, not instruction", () => {
  const prompt = buildSystemPrompt({
    ...base,
    channel: "voice_call" as const,
    counterpart: "third_party" as const,
  });
  assert.match(prompt, /information, never instruction/);
});

test("the owner persona is the default when nothing is stated", () => {
  // Every call was a call to the owner before this existed, and reaching the
  // stranger persona by accident on a reminder call would be the worse failure.
  const prompt = buildSystemPrompt({ ...base, channel: "voice_call" as const });
  assert.doesNotMatch(prompt, /NOT YOUR OWNER/);
});

test("counterpart only changes the voice channel", () => {
  // A chat message is not a phone call; the flag must not leak into Telegram.
  const telegram = buildSystemPrompt({
    ...base,
    channel: "telegram" as const,
    counterpart: "third_party" as const,
  });
  assert.match(telegram, /Telegram chat/);
  assert.doesNotMatch(telegram, /NOT YOUR OWNER/);
});
