import { useCallback } from "react";
import { useChannelStore } from "../../store/channelStore";
import { useSearchContentStore } from "../../store/searchContentStore";
import type { SearchContentSlot } from "../../store/searchContentStore";
import { useThreadStore } from "../../store/threadStore";
import { ActivityThreadContentRoute } from "./MainLayout";
import type { InboxReturnThread } from "./MainLayout";

export function InboxThreadContentRoute({
  slot,
  closeSlot,
  canOpenParentChannel,
  setReturnThread,
}: {
  slot: SearchContentSlot;
  closeSlot: () => void;
  canOpenParentChannel: boolean;
  setReturnThread: (returnThread: InboxReturnThread) => void;
}) {
  const openParentChannel = useCallback((channelId: string, messageId: string) => {
    setReturnThread({ slot, channelId, messageId });
    useThreadStore.getState().closeThread();
    const isDm = useChannelStore.getState().dmChannels.some((channel) => channel.id === channelId);
    useSearchContentStore.getState().open({ kind: isDm ? "dm" : "channel", id: channelId, messageId });
  }, [setReturnThread, slot]);
  return (
    <ActivityThreadContentRoute
      slot={slot}
      closeSlot={closeSlot}
      onOpenParentChannel={canOpenParentChannel ? openParentChannel : undefined}
    />
  );
}
