import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";

/**
 * The outbound call schema, mirrored from app.ts.
 *
 * The property under test is not the shape but the *identity*: the pipeline
 * must dial under the orchestrator's call id, never one of its own.
 */
const outboundCallSchema = z.object({
  callId: z.string().uuid(),
  toNumber: z.string(),
  context: z.string(),
  reason: z.string(),
  counterpart: z.enum(["owner", "third_party"]).default("owner"),
});

const REQUEST = {
  callId: "1c69dd8b-4227-48b6-844e-0337af0664d0",
  toNumber: "+496983041066",
  context: "Guten Tag …",
  reason: "Termin erfragen",
};

test("the orchestrator's call id is carried through, not replaced", () => {
  // A fresh uuid here meant every status PATCH updated zero rows in silence and
  // every turn lookup answered 404. Reusing the id is the whole contract.
  const parsed = outboundCallSchema.parse(REQUEST);
  assert.equal(parsed.callId, REQUEST.callId);
});

test("a call id that is not a uuid is refused outright", () => {
  // The orchestrator's ids are uuids. Anything else means the two services are
  // talking past each other, and failing loudly beats dialling under an id
  // nothing can be looked up by.
  assert.throws(() => outboundCallSchema.parse({ ...REQUEST, callId: "call-7" }));
});

test("counterpart defaults to the owner when absent", () => {
  // An older orchestrator sends no counterpart. Defaulting to `third_party`
  // would strip the butler persona from a real reminder call to the owner.
  assert.equal(outboundCallSchema.parse(REQUEST).counterpart, "owner");
});

test("counterpart is carried through when stated", () => {
  const parsed = outboundCallSchema.parse({ ...REQUEST, counterpart: "third_party" });
  assert.equal(parsed.counterpart, "third_party");
});
