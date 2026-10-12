import { describe, it, expect } from "vitest";
import { validateAnnouncementPresentation } from "./index";
describe("announcement presentation", () => {
  it("retains localized label, deep link and asset metadata", () => {
    const input = { label: "New", cta: { label: "Create", href: "/?dialog=create-joint-channel" }, image: { assetId: "00000000-0000-0000-0000-000000000001", alt: "Channel diagram" } };
    expect(validateAnnouncementPresentation(input)).toEqual(input);
  });
  it("accepts old content with no extra presentation", () => {
    expect(validateAnnouncementPresentation({ title: "Old", pages: [{ body: "Old" }] })).toEqual({});
  });
  it.each(["javascript:alert(1)", "//evil.example", "/\\evil.example", "http://example.com", "https://user:pass@example.com", "/x\n"])("rejects unsafe destination %s", (href) => {
    expect(() => validateAnnouncementPresentation({ cta: { label: "Open", href } })).toThrow();
  });
});
