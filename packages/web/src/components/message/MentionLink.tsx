import { useContext, useRef, useCallback } from "react";
import type { ReactNode } from "react";
import { IntlContext } from "react-intl";
import { MessageReferenceText, PreviewCard, PreviewCardContent, PreviewCardTrigger } from "raft-ui";
import type { ExternalMessageAuthorProjection } from "@botiverse/raft-shared";
import { en } from "../../i18n/messages/en";
import { useAuthStore } from "../../store/authStore";
import type { Agent } from "../../store/agentStore";
import { useReadReceiptStore } from "../../store/readReceiptStore";
import { projectAgentReadReceipt } from "../../store/readReceiptDomain";
import type { ServerMember } from "../../store/serverStore";
import type { ChannelExternalMember } from "../../hooks/useChannelMembers";
import ProfilePreviewCardContent from "./ProfilePreviewCardContent";
import { ExternalIdentityPreviewBody } from "./ExternalIdentityPreviewCard";
import Tooltip from "../ui/Tooltip";
import { useMessageReadReceiptScope } from "./messageReadReceiptScope";

interface MentionLinkProps {
  mentionType: "agent" | "user" | "external";
  mentionId: string;
  /** Zero-arg legacy navigation. Prefer the typed pair below so callers can
   *  pass stable references instead of per-item closures. */
  onNavigate?: () => void;
  /** Typed navigation pair — used (by mentionType) when `onNavigate` is absent. */
  onNavigateAgent?: (agentId: string) => void;
  onNavigateHuman?: (userId: string) => void;
  children: ReactNode;
  /** Handle from the mention token, so the hover card can render a graceful
   *  non-empty state when the entity is not in the local store. */
  fallbackLabel?: string;
  fallbackAgent?: Agent | null;
  fallbackMember?: ServerMember | null;
  /** Linked-provider member (Slack) for `type:"external"` mentions. */
  fallbackExternal?: ChannelExternalMember | null;
  /** Click handler for external mentions — opens the external-identity
   *  panel via `useProfileStore.openExternalProfile` (same flow a Slack-
   *  authored message avatar uses). */
  onNavigateExternal?: (profile: ExternalMessageAuthorProjection) => void;
}

export default function MentionLink({ mentionType, mentionId, onNavigate, onNavigateAgent, onNavigateHuman, onNavigateExternal, children, fallbackLabel, fallbackAgent, fallbackMember, fallbackExternal }: MentionLinkProps) {
  const viewerUserId = useAuthStore((s) => s.user?.id ?? null);
  const isSelfMention = mentionType === "user" && viewerUserId === mentionId;
  const previewActionsRef = useRef<{ close: () => void; unmount: () => void } | null>(null);
  const handleNavigate = useCallback(() => {
    if (onNavigate) {
      onNavigate();
      return;
    }
    if (mentionType === "agent") onNavigateAgent?.(mentionId);
    else if (mentionType === "user") onNavigateHuman?.(mentionId);
    // `external` has no Raft principal — render as plain text, no navigation.
  }, [onNavigate, onNavigateAgent, onNavigateHuman, mentionType, mentionId]);
  const handleTriggerClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    previewActionsRef.current?.close();
    handleNavigate();
  }, [handleNavigate]);

  // MentionLink is mounted standalone by some seams (e.g. mentionFirstPaint)
  // with no IntlProvider, so an unconditional useIntl() throws there. Same
  // context+catalog fallback CollapsibleMessageContent uses.
  const intl = useContext(IntlContext);

  // #693: read state for THIS agent on THIS message. Only agent mentions carry
  // a badge; human read state is deliberately not surfaced (artin 2026-07-27).
  const readScope = useMessageReadReceiptScope();
  const agentReadEligible = mentionType === "agent" && !!readScope?.enabled;
  // Select a PRIMITIVE: returning `{read}` here would hand useSyncExternalStore a
  // fresh object every render and loop forever ("Maximum update depth exceeded").
  const agentReadState = useReadReceiptStore((state): "read" | "unread" | "unknown" => {
    if (!agentReadEligible || !readScope) return "unknown";
    const projected = projectAgentReadReceipt(
      state.scopes[readScope.channelId],
      mentionId,
      readScope.messageSeq,
    );
    if (projected === null) return "unknown";
    return projected.read ? "read" : "unread";
  });
  // "unknown" = summary-only scope, not hydrated, or not a peer. Render nothing
  // rather than implying "unread".
  const readLabelId = agentReadState === "read"
    ? "message.mention.agentRead"
    : "message.mention.agentUnread";
  const readLabel = intl?.formatMessage({ id: readLabelId }) ?? en[readLabelId];
  const readBadge = agentReadState === "unknown"
    ? null
    : (
      <Tooltip content={readLabel}>
      <span
        data-mention-read-state={agentReadState}
        data-testid={`mention-read-${mentionId}`}
        aria-label={readLabel}
        // The mention is inline text, so the span's box top sits well above the
        // glyphs (line-height), which made a `-top-1` badge read as floating
        // above the row rather than sitting on the mention's corner. Anchor it
        // down onto the corner and slightly further right (artin, 7-28).
        className={`pointer-events-none absolute -right-1.5 top-0 size-2 shrink-0 rounded-full border border-black ${
 agentReadState === "read" ? "bg-brutal-lime" : "bg-white"
 }`}
      />
      </Tooltip>
    );

  // External (provider-side) mentions carry no Raft principal, but hover and
  // click follow the same affordances as @human/@agent (yezizp): hover shows
  // the shared ExternalIdentityPreviewBody, click opens the external-identity
  // panel via `onNavigateExternal` (same flow a Slack-authored avatar uses).
  const handleExternalClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    previewActionsRef.current?.close();
    if (!fallbackExternal) return;
    onNavigateExternal?.({
      projectionId: fallbackExternal.id,
      provider: fallbackExternal.provider,
      appRegistrationId: "", // members endpoint intentionally omits provider-side ids
      installId: "",
      workspaceId: "",
      externalActorId: "",
      workspaceName: fallbackExternal.workspaceName,
      externalConversationId: "",
      externalMessageId: "",
      displayName: fallbackExternal.displayName,
      actorKind: fallbackExternal.actorKind,
      avatarUrl: fallbackExternal.avatarUrl,
      avatarDigest: null,
      actorProjectionRevision: 0,
    });
  }, [fallbackExternal, onNavigateExternal]);

  if (mentionType === "external") {
    return (
      <PreviewCard actionsRef={previewActionsRef}>
        <PreviewCardTrigger
          delay={200}
          closeDelay={120}
          render={(
            <MessageReferenceText
              variant="secondary"
              render={<a href="#">{children}</a>}
            />
          )}
          onClick={handleExternalClick}
        >
          {children}
        </PreviewCardTrigger>
        <PreviewCardContent sideOffset={6} collisionPadding={6} className="w-[280px]">
          <ExternalIdentityPreviewBody
            displayName={fallbackExternal?.displayName ?? fallbackLabel ?? ""}
            provider={fallbackExternal?.provider}
            workspaceName={fallbackExternal?.workspaceName}
            actorKind={fallbackExternal?.actorKind}
            avatarUrl={fallbackExternal?.avatarUrl}
          />
        </PreviewCardContent>
      </PreviewCard>
    );
  }

  const trigger = (
    <PreviewCard actionsRef={previewActionsRef}>
      <PreviewCardTrigger
        delay={200}
        closeDelay={120}
        render={(
          <MessageReferenceText
            variant={isSelfMention ? "primary" : "secondary"}
            className="cursor-default"
            render={<a href="#">{children}</a>}
          />
        )}
        onClick={handleTriggerClick}
      >
        {children}
      </PreviewCardTrigger>
      <PreviewCardContent sideOffset={6} collisionPadding={6} className="w-[280px]">
        <ProfilePreviewCardContent
          mentionType={mentionType}
          mentionId={mentionId}
          fallbackLabel={fallbackLabel}
          fallbackAgent={fallbackAgent}
          fallbackMember={fallbackMember}
        />
      </PreviewCardContent>
    </PreviewCard>
  );

  if (!readBadge) return trigger;

  // The badge hangs off the mention's own top-right corner, so it travels with
  // the token as the markdown line wraps.
  return (
    // `mr-2` reserves the badge's own width. The badge is absolutely positioned
    // so it contributes no layout, and without this the following word collides
    // with it. This wrapper only renders when a badge exists, so unbadged
    // mentions keep their natural spacing.
    <span className="relative mr-2 inline-block align-baseline">
      {trigger}
      {readBadge}
    </span>
  );
}
