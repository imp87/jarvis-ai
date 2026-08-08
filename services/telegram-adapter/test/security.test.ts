import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTelegramIp } from "../src/security.js";

describe("isTelegramIp", () => {
  it("accepts addresses inside Telegram's published ranges", () => {
    // 149.154.160.0/20 spans .160.0 – .175.255
    assert.equal(isTelegramIp("149.154.160.0"), true);
    assert.equal(isTelegramIp("149.154.167.41"), true);
    assert.equal(isTelegramIp("149.154.175.255"), true);
    // 91.108.4.0/22 spans .4.0 – .7.255
    assert.equal(isTelegramIp("91.108.4.0"), true);
    assert.equal(isTelegramIp("91.108.7.255"), true);
  });

  it("rejects addresses just outside the ranges", () => {
    assert.equal(isTelegramIp("149.154.159.255"), false);
    assert.equal(isTelegramIp("149.154.176.0"), false);
    assert.equal(isTelegramIp("91.108.3.255"), false);
    assert.equal(isTelegramIp("91.108.8.0"), false);
  });

  it("rejects unrelated and private addresses", () => {
    assert.equal(isTelegramIp("8.8.8.8"), false);
    assert.equal(isTelegramIp("192.168.1.10"), false);
    assert.equal(isTelegramIp("127.0.0.1"), false);
  });

  it("unwraps IPv4-mapped IPv6, which is what Express reports on a dual-stack listener", () => {
    assert.equal(isTelegramIp("::ffff:149.154.167.41"), true);
    assert.equal(isTelegramIp("::ffff:8.8.8.8"), false);
  });

  it("rejects malformed input rather than throwing", () => {
    // A real IPv6 delivery would land here — it fails closed, which is why the
    // secret token and not this check is the primary authenticity gate.
    assert.equal(isTelegramIp("2001:db8::1"), false);
    assert.equal(isTelegramIp(""), false);
    assert.equal(isTelegramIp("999.999.999.999"), false);
    assert.equal(isTelegramIp("149.154.167"), false);
    assert.equal(isTelegramIp("not-an-ip"), false);
  });
});
