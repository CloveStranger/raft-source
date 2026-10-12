import assert from "node:assert/strict";

import {
  MAX_IANA_TIMEZONE_LENGTH,
  parseCanonicalBrowserTimezone,
  parseIanaTimezone,
  parseOptionalIanaTimezone,
} from "./ianaTimezone";

test("parseIanaTimezone trims valid zones and throws field-named errors", () => {
  assert.equal(parseIanaTimezone(" Asia/Shanghai ", "preferredTimezone"), "Asia/Shanghai");
  assert.throws(() => parseIanaTimezone("   ", "preferredTimezone"), /preferredTimezone must be a non-empty IANA timezone/);
  assert.throws(
    () => parseIanaTimezone(`Asia/${"x".repeat(MAX_IANA_TIMEZONE_LENGTH)}`, "preferredTimezone"),
    /preferredTimezone must be at most 128 characters/,
  );
  assert.throws(() => parseIanaTimezone("Mars/Olympus_Mons", "preferredTimezone"), /preferredTimezone must be an IANA timezone/);
});

test("parseCanonicalBrowserTimezone rejects abbreviations and offsets", () => {
  assert.equal(parseCanonicalBrowserTimezone("Europe/Berlin"), "Europe/Berlin");
  assert.equal(parseCanonicalBrowserTimezone("UTC"), "UTC");
  assert.throws(() => parseCanonicalBrowserTimezone("EST"), /canonical IANA timezone/);
  assert.throws(() => parseCanonicalBrowserTimezone("+05:00"));
});

test("parseOptionalIanaTimezone returns the canonical zone or null and never throws", () => {
  assert.equal(parseOptionalIanaTimezone("Asia/Shanghai"), "Asia/Shanghai");
  assert.equal(parseOptionalIanaTimezone(" America/New_York "), "America/New_York");
  assert.equal(parseOptionalIanaTimezone("UTC"), "UTC");
  for (const value of [
    undefined,
    null,
    480,
    true,
    {},
    ["Asia/Shanghai"],
    "",
    "   ",
    "EST",
    "+05:00",
    "Mars/Olympus_Mons",
    `Asia/${"x".repeat(MAX_IANA_TIMEZONE_LENGTH)}`,
  ]) {
    assert.equal(parseOptionalIanaTimezone(value), null, JSON.stringify(value));
  }
});
