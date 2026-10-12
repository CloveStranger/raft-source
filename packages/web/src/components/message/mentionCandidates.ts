import type { Message } from "../../store/messageStore";
import { rankComposerSuggestions } from "../../utils/composerSuggestionSearch";
import type { ComposerSuggestionSearchEntry } from "../../utils/composerSuggestionSearch";

export interface MentionCandidate {
  id: string;
  serverId?: string | null;
  serverName?: string | null;
  serverSlug?: string | null;
  /** Joint rosters (RFC 075 phase 1): every server label of a person who
   *  participates through more than the viewer's server, viewed server
   *  first. Takes precedence over serverName/serverSlug when present. */
  serverLabels?: string[] | null;
  name: string;
  displayName: string | null;
  /**
   * `external` = a linked provider member (Slack participant) — id is the
   * projection id, name is the outbound handle. Never wakes a Raft actor;
   * it mints an `external_mention_facts` row for the Slack renderer.
   */
  type: "agent" | "user" | "computer" | "app" | "external";
  avatarUrl: string | null;
  gravatarHash?: string | null;
  email?: string | null;
  description?: string | null;
}

interface BuildMentionCandidateGroupsOptions {
  candidates: MentionCandidate[];
  query: string;
  channelMemberIds: Set<string>;
  threadMessages?: Message[];
  prioritizeThreadParticipants?: boolean;
}

interface BuildMentionCandidateGroupsFromRankedOptions {
  rankedCandidates: MentionCandidate[];
  channelMemberIds: Set<string>;
  threadMessages?: Message[];
  prioritizeThreadParticipants?: boolean;
}

interface MentionCandidateGroups {
  inChannel: MentionCandidate[];
  notInChannel: MentionCandidate[];
  /** Linked provider members (e.g. Slack) — always channel-scoped. */
  externals: MentionCandidate[];
  computers: MentionCandidate[];
  apps: MentionCandidate[];
  flat: MentionCandidate[];
}

interface MentionScopeChannel {
  type?: string | null;
}

export function isMemberScopedMentionChannel(channel: MentionScopeChannel | null | undefined): boolean {
  if (!channel) return false;
  return channel.type === "private" || channel.type === "joint";
}

export function getMentionCandidateDescription(candidate: MentionCandidate): string | null {
  const description = candidate.description?.trim().replace(/\s+/g, " ");
  return description || null;
}

export function getMentionCandidateServerLabel(candidate: MentionCandidate): string | null {
  if (candidate.serverLabels?.length) return candidate.serverLabels.join(", ");
  return candidate.serverName || candidate.serverSlug || null;
}

export function createMentionCandidateSearchEntries(candidates: MentionCandidate[]): ComposerSuggestionSearchEntry<MentionCandidate>[] {
  return candidates.map((candidate, index) => ({
    index,
    suggestion: candidate,
    fields: [
      { raw: candidate.name, priority: 0 },
      { raw: candidate.displayName ?? "", priority: 1 },
      { raw: candidate.description ?? "", priority: 3 },
      { raw: getMentionCandidateServerLabel(candidate) ?? "", priority: 4 },
    ],
  }));
}

function buildRecentParticipantRanks(threadMessages: Message[]): Map<string, number> {
  const ranks = new Map<string, number>();
  let nextRank = 0;

  for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
    const senderId = threadMessages[i]?.senderId;
    if (!senderId || ranks.has(senderId)) continue;
    ranks.set(senderId, nextRank);
    nextRank += 1;
  }

  return ranks;
}

function sortByThreadRecency(
  candidates: MentionCandidate[],
  originalOrder: Map<string, number>,
  recentParticipantRanks: Map<string, number>,
): MentionCandidate[] {
  return [...candidates].sort((a, b) => {
    const aRank = recentParticipantRanks.get(a.id) ?? Number.POSITIVE_INFINITY;
    const bRank = recentParticipantRanks.get(b.id) ?? Number.POSITIVE_INFINITY;
    if (aRank !== bRank) return aRank - bRank;

    const aOrder = originalOrder.get(a.id) ?? Number.POSITIVE_INFINITY;
    const bOrder = originalOrder.get(b.id) ?? Number.POSITIVE_INFINITY;
    return aOrder - bOrder;
  });
}

export function buildMentionCandidateGroups({
  candidates,
  query,
  channelMemberIds,
  threadMessages = [],
  prioritizeThreadParticipants = false,
}: BuildMentionCandidateGroupsOptions): MentionCandidateGroups {
  const entries = createMentionCandidateSearchEntries(candidates);
  const queryFiltered = rankComposerSuggestions(query, entries);
  return buildMentionCandidateGroupsFromRankedCandidates({
    rankedCandidates: queryFiltered,
    channelMemberIds,
    threadMessages,
    prioritizeThreadParticipants,
  });
}

export function buildMentionCandidateGroupsFromRankedCandidates({
  rankedCandidates,
  channelMemberIds,
  // Stryker disable next-line ArrayDeclaration: a synthetic non-empty default only changes recency for an impossible omitted-message caller state; explicit empty and populated message behavior are covered.
  threadMessages = [],
  prioritizeThreadParticipants,
}: BuildMentionCandidateGroupsFromRankedOptions): MentionCandidateGroups {
  const people = rankedCandidates.filter((candidate) => candidate.type === "agent" || candidate.type === "user");
  const externals = rankedCandidates.filter((candidate) => candidate.type === "external");
  const computers = rankedCandidates.filter((candidate) => candidate.type === "computer");
  const apps = rankedCandidates.filter((candidate) => candidate.type === "app");
  const inChannel = people.filter((candidate) => channelMemberIds.has(candidate.id));
  const notInChannel = people.filter((candidate) => !channelMemberIds.has(candidate.id));

  if (prioritizeThreadParticipants !== true) {
    // Externals sit inside the in-channel group in the UI (Slack badge marks
    // them), so they land after inChannel in flat index order.
    return { inChannel, notInChannel, externals, computers, apps, flat: [...inChannel, ...externals, ...notInChannel, ...computers, ...apps] };
  }

  // Stryker disable next-line ArrayDeclaration: empty original-order tuples are equivalent under stable sort for this tie-breaker; query order preservation is covered by non-thread and recency tests.
  const originalOrder = new Map(rankedCandidates.map((candidate, index) => [candidate.id, index]));
  const recentParticipantRanks = buildRecentParticipantRanks(threadMessages);
  const sortedInChannel = sortByThreadRecency(inChannel, originalOrder, recentParticipantRanks);
  const sortedNotInChannel = sortByThreadRecency(notInChannel, originalOrder, recentParticipantRanks);

  return {
    inChannel: sortedInChannel,
    notInChannel: sortedNotInChannel,
    externals,
    computers,
    apps,
    flat: [...sortedInChannel, ...externals, ...sortedNotInChannel, ...computers, ...apps],
  };
}
