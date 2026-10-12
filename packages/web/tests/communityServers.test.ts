import assert from "node:assert/strict";
import {
  DEFAULT_COMMUNITY_SERVER_SLUG,
  recommendedCommunitySlug,
  shouldShowChineseCommunityEntry,
} from "../src/utils/communityServers";

test("Chinese community entry is gated by the active display locale", () => {
  assert.equal(shouldShowChineseCommunityEntry("zh-cn"), true);
  assert.equal(shouldShowChineseCommunityEntry("en"), false);
});

test("community recommendation keeps the default internal community server", () => {
  assert.equal(recommendedCommunitySlug([]), DEFAULT_COMMUNITY_SERVER_SLUG);
  assert.equal(recommendedCommunitySlug([{ slug: "community-cn" }]), DEFAULT_COMMUNITY_SERVER_SLUG);
});
