import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractSipUser,
  maskPhoneNumber,
  normalisePhoneNumber,
  tryNormalisePhoneNumber,
} from "../src/phone.js";

const OWNER = "+4915561049738";

describe("normalisePhoneNumber", () => {
  it("maps every shape the owner's number can arrive in to one value", () => {
    // If any of these diverge, the caller allowlist rejects a number that is
    // registered — the failure this function exists to prevent.
    for (const input of [
      "015561049738",
      "+4915561049738",
      "004915561049738",
      "0155 610 497 38",
      "0155-61049738",
      "0155/61049738",
      "+49 155 61049738",
      "<sip:015561049738@fritz.box>",
      '"Steve" <sip:+4915561049738@10.0.0.1>',
      "sip:004915561049738@fritz.box;user=phone",
    ]) {
      assert.equal(normalisePhoneNumber(input), OWNER, `failed for ${input}`);
    }
  });

  it("leaves an already-normalised number alone", () => {
    assert.equal(normalisePhoneNumber(OWNER), OWNER);
  });

  it("honours a different default country code", () => {
    assert.equal(normalisePhoneNumber("06612345678", "43"), "+436612345678");
  });

  it("rejects internal extensions rather than turning them into real numbers", () => {
    // **620 is a FritzBox internal extension. Mapping it onto +49620… would
    // both fail to match and, if ever dialled, reach a stranger.
    assert.throws(() => normalisePhoneNumber("**620"), /not a valid E.164/);
    assert.throws(() => normalisePhoneNumber("620"), /not a valid E.164/);
  });

  it("rejects empty or digitless input", () => {
    assert.throws(() => normalisePhoneNumber(""), /empty/);
    assert.throws(() => normalisePhoneNumber("anonymous"), /no digits/);
  });

  it("rejects absurdly long input", () => {
    assert.throws(() => normalisePhoneNumber(`+${"1".repeat(20)}`), /not a valid E.164/);
  });
});

describe("tryNormalisePhoneNumber", () => {
  it("returns null instead of throwing, for untrusted caller IDs", () => {
    assert.equal(tryNormalisePhoneNumber("anonymous"), null);
    assert.equal(tryNormalisePhoneNumber("015561049738"), OWNER);
  });
});

describe("extractSipUser", () => {
  it("pulls the user part out of a URI and passes plain numbers through", () => {
    assert.equal(extractSipUser("<sip:0155@fritz.box>"), "0155");
    assert.equal(extractSipUser("sips:+4915561049738@host;transport=tls"), "+4915561049738");
    assert.equal(extractSipUser("015561049738"), "015561049738");
  });
});

describe("maskPhoneNumber", () => {
  it("never reveals the full number", () => {
    const masked = maskPhoneNumber(OWNER);
    assert.ok(!masked.includes("61049"), masked);
    assert.match(masked, /\*\*\*/);
  });
});
