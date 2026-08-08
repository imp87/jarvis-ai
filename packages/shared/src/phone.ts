/**
 * Phone number normalisation.
 *
 * Caller IDs arrive in whatever shape the network hands over: `015561049738`
 * from a German mobile, `+4915561049738` from another carrier, `0049…` from
 * some PBXs, and often wrapped in a SIP URI. The identity gate looks numbers up
 * by exact string match, so every one of those has to collapse to the same
 * value or an authorised caller gets rejected — or, far worse, a stored number
 * silently never matches and the allowlist quietly lets nobody through.
 *
 * Everything is normalised to E.164 (`+49…`).
 */

const DEFAULT_COUNTRY_CODE = "49";

export class PhoneNumberError extends Error {
  constructor(readonly input: string, message: string) {
    super(message);
    this.name = "PhoneNumberError";
  }
}

/**
 * Pulls the user part out of a SIP URI. `"Steve" <sip:015561049738@fritz.box>`
 * and `sip:+49155…@10.0.0.1;user=phone` both yield the bare number.
 * Anything that is not a URI is returned unchanged.
 */
export function extractSipUser(value: string): string {
  const match = /sips?:([^@;>\s]+)/i.exec(value);
  return match?.[1] ?? value;
}

/**
 * Normalises to E.164. `defaultCountryCode` is applied to national numbers
 * (those starting with a single 0).
 */
export function normalisePhoneNumber(
  input: string,
  defaultCountryCode: string = DEFAULT_COUNTRY_CODE,
): string {
  const raw = extractSipUser(String(input ?? "")).trim();
  if (raw.length === 0) throw new PhoneNumberError(input, "empty phone number");

  // Keep a leading +, drop every other separator humans and PBXs insert.
  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 0) throw new PhoneNumberError(input, "no digits in phone number");

  let national: string;
  if (hasPlus) {
    national = digits;
  } else if (digits.startsWith("00")) {
    // International prefix: 0049… -> 49…
    national = digits.slice(2);
  } else if (digits.startsWith("0")) {
    // National trunk prefix: 0155… -> 49155…
    national = `${defaultCountryCode}${digits.slice(1)}`;
  } else {
    // Bare digits with no prefix at all. Treating these as already carrying a
    // country code is the only safe reading — guessing would silently map a
    // short internal extension onto a real mobile number.
    national = digits;
  }

  // E.164 allows at most 15 digits; below ~7 it cannot be a routable number and
  // is much more likely an internal extension we must not treat as a caller.
  if (national.length < 7 || national.length > 15) {
    throw new PhoneNumberError(
      input,
      `normalised to ${national.length} digits, which is not a valid E.164 number`,
    );
  }

  return `+${national}`;
}

/** Non-throwing variant for untrusted input such as an inbound caller ID. */
export function tryNormalisePhoneNumber(
  input: string,
  defaultCountryCode?: string,
): string | null {
  try {
    return normalisePhoneNumber(input, defaultCountryCode);
  } catch {
    return null;
  }
}

/** Never write a full number into a log line. */
export function maskPhoneNumber(value: string): string {
  return value.length <= 6 ? "***" : `${value.slice(0, 5)}***${value.slice(-2)}`;
}
