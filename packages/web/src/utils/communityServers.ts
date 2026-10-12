import type { CommunityServerSlug } from "../store/serverStore";

export const DEFAULT_COMMUNITY_SERVER_SLUG: CommunityServerSlug = "community";
export const CHINESE_COMMUNITY_SERVER_SLUG: CommunityServerSlug = "community-cn";
export const CHINESE_COMMUNITY_PAGE_PATH = "/community/chinese";

export function hasJoinedCommunity(servers: Array<{ slug: string }>, slug: CommunityServerSlug) {
  return servers.some((server) => server.slug === slug);
}

export function shouldShowChineseCommunityEntry(displayLocale: string) {
  return displayLocale === "zh-cn";
}

export function recommendedCommunitySlug(_servers: Array<{ slug: string }>) {
  return DEFAULT_COMMUNITY_SERVER_SLUG;
}
