import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decryptSecret,
  encryptSecret,
  generateToken,
  parseMasterKey,
  safeEqual,
} from "../src/crypto.js";

const key = parseMasterKey(generateToken(32));

describe("secret envelopes", () => {
  it("round-trips a credential", () => {
    const secret = "sk_live_abc123:with:colons and spaces";
    assert.equal(decryptSecret(encryptSecret(secret, key), key), secret);
  });

  it("uses a fresh IV per call so identical secrets differ on disk", () => {
    assert.notEqual(encryptSecret("same", key), encryptSecret("same", key));
  });

  it("is versioned", () => {
    assert.ok(encryptSecret("x", key).startsWith("v1."));
  });

  it("rejects a tampered ciphertext instead of returning garbage", () => {
    const envelope = encryptSecret("secret", key);
    const tampered = `${envelope.slice(0, -3)}aaa`;
    assert.throws(() => decryptSecret(tampered, key));
  });

  it("rejects a malformed envelope", () => {
    assert.throws(() => decryptSecret("not-an-envelope", key), /malformed/);
  });

  it("cannot be decrypted with a different key", () => {
    const other = parseMasterKey(generateToken(32));
    assert.throws(() => decryptSecret(encryptSecret("secret", key), other));
  });
});

describe("parseMasterKey", () => {
  it("rejects a key of the wrong length", () => {
    assert.throws(() => parseMasterKey("deadbeef"), /32 bytes hex/);
  });
});

describe("safeEqual", () => {
  it("compares equal and unequal strings", () => {
    assert.equal(safeEqual("abc", "abc"), true);
    assert.equal(safeEqual("abc", "abd"), false);
  });

  it("handles differing lengths without throwing", () => {
    assert.equal(safeEqual("abc", "abcd"), false);
    assert.equal(safeEqual("", "x"), false);
  });
});
