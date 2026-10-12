import { useEffect, useMemo, useState } from "react";
import type { ParsedRaftPermalink } from "@botiverse/raft-shared";
import api from "../../api/client";
import { useAgentStore } from "../../store/agentStore";
import { useAuthStore } from "../../store/authStore";
import { useChannelStore } from "../../store/channelStore";
import type { Message } from "../../store/messageStore";
import { useServerStore } from "../../store/serverStore";
import { buildQuotedMessageContextRequest } from "./messageContextRequest";
import { QuoteCardContent } from "./QuoteCardContent";

type PreviewState =
  | { status: "loading" }
  | { status: "loaded"; target: Message; channelArchived: boolean }
  | { status: "unavailable" };

export default function QuotedMessagePermalinkPreview({
  permalink,
  onOpen,
  onUnavailable,
}: {
  permalink: ParsedRaftPermalink;
  onOpen: (permalink: ParsedRaftPermalink) => void;
  onUnavailable?: () => void;
}) {
  const [state, setState] = useState<PreviewState>({ status: "loading" });
  const channels = useChannelStore((s) => s.channels);
  const dmChannels = useChannelStore((s) => s.dmChannels);
  const agents = useAgentStore((s) => s.agents);
  const members = useServerStore((s) => s.members);
  const currentUser = useAuthStore((s) => s.user);

  // Async-loader: re-fetch message context when `permalink` changes. The
  // reset-to-loading + async-fetch is intended — a different permalink is a
  // different message to preview. Same family as PR #2530's async-loader FPs.
  // oxlint-disable-next-line react-doctor/no-cascading-set-state
  useEffect(() => {
    let cancelled = false;
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setState({ status: "loading" });

    void api.get(`/messages/context/${permalink.messageId}`, buildQuotedMessageContextRequest(permalink.channelId))
      .then(({ data }) => {
        if (cancelled) return;
        const payload = data as { messages?: Message[]; channelArchived?: boolean; targetMessageId?: string };
        const messages = payload.messages ?? [];
        const targetMessageId = payload.targetMessageId ?? permalink.messageId;
        const target = messages.find((message) => message.id === targetMessageId);
        if (target) {
          setState({ status: "loaded", target, channelArchived: !!payload.channelArchived });
        } else {
          setState({ status: "unavailable" });
          onUnavailable?.();
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: "unavailable" });
          onUnavailable?.();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [onUnavailable, permalink.channelId, permalink.messageId, permalink.threadParentMessageId]);

  const channel = useMemo(
    () => channels.find((entry) => entry.id === permalink.channelId) ?? dmChannels.find((entry) => entry.id === permalink.channelId),
    [channels, dmChannels, permalink.channelId],
  );

  if (state.status === "loading") {
    return (
      <div className="w-full animate-pulse border-2 border-black bg-white">
        <div className="h-[34px] border-b-2 border-black bg-white/60" />
        <div className="flex gap-3 px-3 py-2.5">
          <div className="size-7 shrink-0 border-2 border-black bg-black/5" />
          <div className="flex-1 space-y-2">
            <div className="h-3 w-32 bg-black/10" />
            <div className="h-3 w-full bg-black/10" />
            <div className="h-3 w-3/4 bg-black/10" />
          </div>
        </div>
      </div>
    );
  }

  if (state.status === "unavailable") {
    return null;
  }

  return (
    <QuoteCardContent
      target={state.target}
      channelArchived={state.channelArchived}
      channel={channel}
      permalink={permalink}
      agents={agents}
      members={members}
      currentUser={currentUser}
      onOpen={onOpen}
    />
  );
}
