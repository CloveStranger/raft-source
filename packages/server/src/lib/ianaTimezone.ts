// IANA time zone validation shared by the profile/auth routes (strict: they
// reject bad input with a 400) and the message send route (lenient: a bad
// browser-reported zone is dropped to null so it never fails a send).

export const MAX_IANA_TIMEZONE_LENGTH = 128;

/** Trims and validates an IANA time zone id; throws a field-named error. */
export function parseIanaTimezone(raw: string, fieldName: string): string {
  const value = raw.trim();
  if (!value) {
    throw new Error(`${fieldName} must be a non-empty IANA timezone`);
  }
  if (value.length > MAX_IANA_TIMEZONE_LENGTH) {
    throw new Error(`${fieldName} must be at most ${MAX_IANA_TIMEZONE_LENGTH} characters`);
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch {
    throw new Error(`${fieldName} must be an IANA timezone`);
  }
  return value;
}

/**
 * Validates a zone reported by a browser (`Intl...resolvedOptions().timeZone`)
 * and returns its canonical id. Rejects abbreviations and offsets ("EST",
 * "+05:00") that Intl accepts but are not Area/Location ids.
 */
export function parseCanonicalBrowserTimezone(raw: string): string {
  const timezone = parseIanaTimezone(raw, "timezone");
  if (timezone !== "UTC" && !timezone.includes("/")) {
    throw new Error("timezone must be a canonical IANA timezone");
  }
  const canonical = new Intl.DateTimeFormat("en-US", { timeZone: timezone })
    .resolvedOptions().timeZone;
  if (canonical !== "UTC" && !canonical.includes("/")) {
    throw new Error("timezone must be a canonical IANA timezone");
  }
  return canonical;
}

/**
 * Lenient form of `parseCanonicalBrowserTimezone` for optional, best-effort
 * fields: returns the canonical zone, or null for anything missing, non-string,
 * empty, overlong or not a canonical IANA zone. Never throws.
 */
export function parseOptionalIanaTimezone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    return parseCanonicalBrowserTimezone(value);
  } catch {
    return null;
  }
}
