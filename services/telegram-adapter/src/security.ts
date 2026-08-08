import type { NextFunction, Request, Response } from "express";
import { safeEqual, type Logger } from "@jarvis/shared";

/**
 * Telegram's published webhook source ranges. The endpoint is exposed to the
 * open internet once DynDNS and a port forward are in place, so this is the
 * cheapest way to drop scanner traffic before it reaches any parsing.
 *
 * Source: Telegram Bot API docs, "Marking webhooks". Verify these before
 * relying on them — Telegram has changed them before.
 */
export const TELEGRAM_IP_RANGES = ["149.154.160.0/20", "91.108.4.0/22"] as const;

interface Cidr {
  base: number;
  mask: number;
}

function parseCidr(cidr: string): Cidr {
  const [address, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const octets = address!.split(".").map(Number);
  const base =
    ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

const RANGES = TELEGRAM_IP_RANGES.map(parseCidr);

export function isTelegramIp(ip: string): boolean {
  // Express reports IPv4-mapped IPv6 for dual-stack listeners.
  const normalised = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  const octets = normalised.split(".");
  if (octets.length !== 4) return false;

  const numbers = octets.map(Number);
  if (numbers.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const value =
    ((numbers[0]! << 24) | (numbers[1]! << 16) | (numbers[2]! << 8) | numbers[3]!) >>> 0;
  return RANGES.some((range) => ((value & range.mask) >>> 0) === range.base);
}

/**
 * Verifies the secret token Telegram echoes on every delivery. This is the
 * primary authenticity check — the IP allowlist is defence in depth, since
 * source addresses can change and IPv6 deliveries would fail the check.
 */
export function requireTelegramSecret(secret: string, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = req.header("x-telegram-bot-api-secret-token") ?? "";
    if (!safeEqual(presented, secret)) {
      logger.warn({ ip: req.ip, path: req.path }, "webhook delivery with bad secret token");
      // 401 rather than 403: no detail, nothing to probe.
      res.status(401).json({ ok: false });
      return;
    }
    next();
  };
}

export function requireTelegramSourceIp(enabled: boolean, logger: Logger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled) {
      next();
      return;
    }
    const ip = req.ip ?? "";
    if (!isTelegramIp(ip)) {
      logger.warn({ ip }, "webhook delivery from a non-Telegram address");
      res.status(403).json({ ok: false });
      return;
    }
    next();
  };
}
