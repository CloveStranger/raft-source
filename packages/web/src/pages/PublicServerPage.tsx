import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { BadgeInfo, BookOpenText, FileText, Hash, Languages, LogIn, MessageSquare, Type, User, UserPlus } from "lucide-react";
import { useIntl } from "react-intl";
import api from "../api/client";
import Banner from "../components/ui/Banner";
import { AppShellMainSlot, AppShellPanelSlot, AppShellRailSlot, AppShellRoot, AppShellSidebarSlot, Button, ConversationPanelContent, ConversationPanelRoot, Spinner } from "raft-ui";
import PanelHeader from "../components/ui/PanelHeader";
import PanelResizeHandle from "../components/ui/PanelResizeHandle";
import EmptyState from "../components/ui/EmptyState";
import type { ReadOnlySenderProjection } from "../components/message/MessageItem";
import type { OpenThreadRequest } from "../store/threadStore";
import { PublicMessageRow } from "./PublicMessageRow";
import MessageTimeline from "../components/message/MessageTimeline";
import type { MessageTimelineSource } from "../components/message/MessageTimeline";
import ThreadPanel from "../components/message/ThreadPanel";
import type { ReadOnlyThreadData } from "../components/message/ThreadPanel";
import { LeftRail } from "../components/layout/LeftRail";
import SettingsSidebarList from "../components/settings/SettingsSidebarList";
import SettingsPanel from "../components/settings/SettingsPanel";
import type { SettingsTabId } from "../components/settings/settingsNavigation";
import ConfirmDialog from "../components/ConfirmDialog";
import CommunityAgreementDialog from "../components/server/CommunityAgreementDialog";
import PublicServerChannelSidebar from "../components/server/PublicServerChannelSidebar";
import PublicServerSidebarFrame from "../components/server/PublicServerSidebarFrame";
import type { CommunityAgreement } from "../components/server/CommunityAgreementDialog";
import {
  getThreadPanelDynamicMax,
  SIDEBAR_PANEL_BOUNDS,
  THREAD_PANEL_DEFAULT_WIDTH,
  THREAD_PANEL_MIN_WIDTH,
} from "../lib/panelBounds";
import { useMediaQuery } from "../hooks/effectPrimitives";
import { useResizablePanel } from "../hooks/useResizablePanel";
import { getApiErrorResponse } from "../utils/apiErrorResponse";
import type { Channel } from "../store/channelStore";
import type { Message } from "../store/messageStore";
import { getServerSurfaceCapabilities } from "@botiverse/raft-shared";

const PUBLIC_PANEL_RESIZE_QUERY = "(min-width: 640px)";

const CHANNEL_HEADER_CONTAINER_PROPS = { "data-testid": "public-server-channel-header" };
const CHANNEL_SIDEBAR_NAV = <nav />;
const noopLoadNewer = () => undefined;
const SETTINGS_SIDEBAR_ASIDE = <aside />;
const EMPTY_PUBLIC_CHANNELS: PublicChannel[] = [];
const ReleaseNotesPanel = lazy(() => import("../components/settings/ReleaseNotesPanel"));
type PublicSettingsView = SettingsTabId | "release-notes";

interface PublicChannel {
  id: string;
  name: string;
  description: string | null;
}

interface PublicServerReadback {
  server: { id: string; name: string; slug: string; avatarUrl: string | null };
  channels: PublicChannel[];
  canJoinAsGuest: boolean;
}

export interface PublicMessage {
  id: string;
  senderType: "user" | "agent" | "external_projection";
  sender: ReadOnlySenderProjection;
  messageType: "chat" | "system";
  content: string;
  createdAt: string;
  threadId: string | null;
  replyCount: number;
}

interface OpenPublicThread {
  threadChannelId: string;
  parentChannelId: string;
  parentMessageId: string;
}

function toReadOnlyMessage(message: PublicMessage, channelId: string): Message {
  return {
    id: message.id,
    channelId,
    senderType: message.senderType,
    // This key is display-local only. Public DTOs intentionally expose no
    // authority-bearing user/agent identifier.
    senderId: `public:${message.senderType}:${message.sender.displayName}:${message.sender.avatarUrl ?? ""}`,
    senderName: message.sender.displayName,
    senderDescription: message.sender.description,
    messageType: message.messageType,
    content: message.content,
    threadId: message.threadId,
    createdAt: message.createdAt,
  };
}

interface PublicPageState {
  readback: PublicServerReadback | null;
  selectedChannelId: string | null;
  messages: PublicMessage[];
  loadingMessages: boolean;
  hasOlder: boolean;
  error: string;
}

type PublicPageAction =
  | { type: "loadServer" }
  | { type: "serverLoaded"; readback: PublicServerReadback; initialChannelId?: string | null }
  | { type: "selectChannel"; channelId: string }
  | { type: "loadMessages" }
  | { type: "messagesLoaded"; messages: PublicMessage[] }
  | { type: "olderLoaded"; channelId: string; messages: PublicMessage[] }
  | { type: "failed"; error: string };

function publicPageReducer(state: PublicPageState, action: PublicPageAction): PublicPageState {
  switch (action.type) {
    case "loadServer": return {
      readback: null,
      selectedChannelId: null,
      messages: [],
      loadingMessages: false,
      hasOlder: false,
      error: "",
    };
    case "serverLoaded": return {
      ...state,
      readback: action.readback,
      selectedChannelId: action.readback.channels.find((channel) => channel.id === action.initialChannelId)?.id
        ?? action.readback.channels[0]?.id
        ?? null,
    };
    case "selectChannel": return { ...state, selectedChannelId: action.channelId, messages: [], hasOlder: false };
    case "loadMessages": return { ...state, loadingMessages: true, error: "" };
    case "messagesLoaded": return { ...state, loadingMessages: false, messages: action.messages, hasOlder: action.messages.length === 50 };
    case "olderLoaded": return state.selectedChannelId === action.channelId
      ? { ...state, loadingMessages: false, messages: [...action.messages, ...state.messages], hasOlder: action.messages.length === 50 }
      : state;
    case "failed": return { ...state, loadingMessages: false, error: action.error };
  }
}

export default function PublicServerPage({
  slug,
  initialChannelId = null,
  onSignIn,
  onRegister,
  onUnavailable,
  authenticated = false,
  onJoined,
}: {
  slug: string;
  /** Channel from a `/s/<slug>/channel/<id>` link; ignored unless it is public. */
  initialChannelId?: string | null;
  onSignIn: () => void;
  onRegister: () => void;
  onUnavailable: () => void;
  authenticated?: boolean;
  onJoined?: () => Promise<void> | void;
}) {
  const { formatMessage } = useIntl();
  const [state, dispatch] = useReducer(publicPageReducer, {
    readback: null,
    selectedChannelId: null,
    messages: [],
    loadingMessages: false,
    hasOlder: false,
    error: "",
  });
  const { readback, selectedChannelId, messages, loadingMessages, hasOlder, error } = state;
  const [joinConfirmOpen, setJoinConfirmOpen] = useState(false);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState("");
  const [agreement, setAgreement] = useState<CommunityAgreement | null>(null);
  const [surfaceMode, setSurfaceMode] = useState<"chat" | "settings">("chat");
  const [settingsTab, setSettingsTab] = useState<PublicSettingsView>(authenticated ? "account" : "about");
  const [serverSelectionNotice, setServerSelectionNotice] = useState(false);

  // The public page sizes its columns purely in Tailwind (`w-36` below sm, fixed px at sm+). The drag handles and the
  // persisted width therefore apply only at sm and above, where the columns actually sit side by side — below it the
  // thread panel is a full-screen overlay, so a width would be meaningless. matchMedia mirrors MainLayout's own
  // isLg gate rather than introducing a second breakpoint idiom.
  const isSmUp = useMediaQuery(PUBLIC_PANEL_RESIZE_QUERY);

  // Same hook, same bounds and same persistence shape as the signed-in shell — the bounds now come from the shared
  // panelBounds module so the two surfaces cannot drift apart again (they had: this page allowed wider sidebars and a
  // narrower thread panel, so the same control behaved differently depending on whether you were signed in).
  // Keys stay namespaced to this page so a width set here never bleeds into the signed-in widths.
  const {
    width: channelSidebarWidth,
    handleResizeStart: handleChannelSidebarResizeStart,
    handleResizeMove: handleChannelSidebarResizeMove,
    handleResizeEnd: handleChannelSidebarResizeEnd,
  } = useResizablePanel({ storageKey: "slock:publicServer:channelSidebarWidth", ...SIDEBAR_PANEL_BOUNDS });
  const {
    width: settingsSidebarWidth,
    handleResizeStart: handleSettingsSidebarResizeStart,
    handleResizeMove: handleSettingsSidebarResizeMove,
    handleResizeEnd: handleSettingsSidebarResizeEnd,
  } = useResizablePanel({ storageKey: "slock:publicServer:settingsSidebarWidth", ...SIDEBAR_PANEL_BOUNDS });
  // The thread column mirrors the signed-in one exactly, including the viewport-derived max recomputed at drag start
  // and the live width measurement — matching only the numbers would still drift in behaviour.
  const threadPanelRef = useRef<HTMLElement | null>(null);
  const [threadPanelDynamicMax, setThreadPanelDynamicMax] = useState(() => getThreadPanelDynamicMax());
  const getThreadPanelDragStartWidth = useCallback(() => {
    const measured = threadPanelRef.current?.getBoundingClientRect().width;
    return measured && measured > 0 ? measured : undefined;
  }, []);
  const {
    width: threadPanelWidth,
    handleResizeStart: beginThreadPanelResize,
    handleResizeMove: handleThreadPanelResizeMove,
    handleResizeEnd: handleThreadPanelResizeEnd,
  } = useResizablePanel({
    storageKey: "slock:publicServer:threadPanelWidth",
    min: THREAD_PANEL_MIN_WIDTH,
    max: threadPanelDynamicMax,
    defaultWidth: THREAD_PANEL_DEFAULT_WIDTH,
    direction: "left",
    getDragStartWidth: getThreadPanelDragStartWidth,
  });
  const handleThreadPanelResizeStart = useCallback((event: React.PointerEvent) => {
    setThreadPanelDynamicMax(getThreadPanelDynamicMax());
    beginThreadPanelResize(event);
  }, [beginThreadPanelResize]);
  const [openThread, setOpenThread] = useState<OpenPublicThread | null>(null);
  const [threadMessages, setThreadMessages] = useState<PublicMessage[]>([]);
  const [threadLoading, setThreadLoading] = useState(false);
  const [threadError, setThreadError] = useState("");
  const [threadHasOlder, setThreadHasOlder] = useState(false);
  const threadRequestGeneration = useRef(0);
  const surfaceCapabilities = useMemo(
    () => getServerSurfaceCapabilities(authenticated ? "public-authenticated-nonmember" : "public-anonymous"),
    [authenticated],
  );

  useEffect(() => {
    let active = true;
    dispatch({ type: "loadServer" });
    api.get<PublicServerReadback>(`/public/servers/${encodeURIComponent(slug)}`)
      .then(({ data }) => {
        if (!active) return;
        dispatch({ type: "serverLoaded", readback: data, initialChannelId });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const response = getApiErrorResponse(err);
        if (response?.status === 404) {
          onUnavailable();
          return;
        }
        dispatch({ type: "failed", error: response?.error || formatMessage({ id: "pages.publicServer.failedLoad" }) });
      });
    return () => {
      active = false;
    };
  }, [formatMessage, initialChannelId, onUnavailable, slug]);

  useEffect(() => {
    if (!selectedChannelId) {
      return;
    }
    let active = true;
    dispatch({ type: "loadMessages" });
    api.get<{ messages: PublicMessage[] }>(`/public/servers/${encodeURIComponent(slug)}/channels/${selectedChannelId}/messages`)
      .then(({ data }) => {
        if (!active) return;
        dispatch({ type: "messagesLoaded", messages: data.messages });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const response = getApiErrorResponse(err);
        dispatch({ type: "failed", error: response?.status === 404
          ? formatMessage({ id: "pages.publicServer.noLongerPublic" })
          : response?.error || formatMessage({ id: "pages.publicServer.failedMessages" }) });
      });
    return () => {
      active = false;
    };
  }, [formatMessage, selectedChannelId, slug]);

  const loadOlder = useCallback(async () => {
    if (!selectedChannelId || messages.length === 0) return;
    dispatch({ type: "loadMessages" });
    try {
      const beforeMessageId = messages[0]!.id;
      const { data } = await api.get<{ messages: PublicMessage[] }>(
        `/public/servers/${encodeURIComponent(slug)}/channels/${selectedChannelId}/messages?beforeMessageId=${encodeURIComponent(beforeMessageId)}`,
      );
      dispatch({ type: "olderLoaded", channelId: selectedChannelId, messages: data.messages });
    } catch (err: unknown) {
      const response = getApiErrorResponse(err);
      dispatch({ type: "failed", error: response?.status === 404
        ? formatMessage({ id: "pages.publicServer.noLongerPublic" })
        : response?.error || formatMessage({ id: "pages.publicServer.failedMessages" }) });
    }
  }, [formatMessage, messages, selectedChannelId, slug]);

  const joinAsGuest = useCallback(async (agreementId?: string) => {
    setJoining(true);
    setJoinError("");
    try {
      await api.post(`/public/servers/${encodeURIComponent(slug)}/join-as-guest`, {
        agreementId: agreementId ?? null,
      });
      setJoinConfirmOpen(false);
      setAgreement(null);
    } catch (err: unknown) {
      const response = getApiErrorResponse(err);
      const raw = (err as { response?: { data?: { error?: string; agreement?: CommunityAgreement } } })?.response?.data;
      if ((raw?.error === "agreement_required" || raw?.error === "agreement_changed") && raw.agreement) {
        setJoinConfirmOpen(false);
        setAgreement(raw.agreement);
        setJoining(false);
        return;
      }
      setJoinError(response?.error || formatMessage({ id: "pages.publicServer.failedJoin" }));
      setJoining(false);
      throw err;
    }

    try {
      await onJoined?.();
    } catch {
      // Membership is already durable. Do not tell the visitor the join failed
      // and invite an unsafe retry just because the local server-list refresh
      // or route transition failed.
      setJoinError(formatMessage({ id: "pages.publicServer.joinedRefresh" }));
    } finally {
      setJoining(false);
    }
  }, [formatMessage, onJoined, slug]);
  const confirmJoinAsGuest = useCallback(() => joinAsGuest(), [joinAsGuest]);
  const openJoinConfirm = useCallback(() => setJoinConfirmOpen(true), []);
  const closeJoinConfirm = useCallback(() => setJoinConfirmOpen(false), []);
  const closeAgreement = useCallback(() => setAgreement(null), []);

  const selected = readback?.channels.find((channel) => channel.id === selectedChannelId) ?? null;
  const displayChannels = useMemo<Channel[]>(() => (readback?.channels ?? []).map((channel) => ({
    ...channel,
    serverId: readback?.server.id,
    type: "channel",
    createdAt: "",
    joined: false,
    guestVisible: true,
  })), [readback?.channels, readback?.server.id]);
  const selectPublicChannel = useCallback((channel: Channel) => {
    dispatch({ type: "selectChannel", channelId: channel.id });
    setOpenThread(null);
    setSurfaceMode("chat");
  }, []);
  const selectPublicChannelById = useCallback((channelId: string) => {
    const channel = displayChannels.find((item) => item.id === channelId);
    if (channel) selectPublicChannel(channel);
  }, [displayChannels, selectPublicChannel]);
  const openPublicThread = useCallback(async (request: OpenPublicThread) => {
    const generation = ++threadRequestGeneration.current;
    setOpenThread(request);
    setThreadMessages([]);
    setThreadError("");
    setThreadHasOlder(false);
    setThreadLoading(true);
    try {
      const { data } = await api.get<{ messages: PublicMessage[] }>(
        `/public/servers/${encodeURIComponent(slug)}/threads/${encodeURIComponent(request.threadChannelId)}/messages?limit=50`,
      );
      if (generation !== threadRequestGeneration.current) return;
      setThreadMessages(data.messages);
      setThreadHasOlder(data.messages.length === 50);
    } catch (err: unknown) {
      if (generation !== threadRequestGeneration.current) return;
      const response = getApiErrorResponse(err);
      setThreadError(response?.status === 404
        ? formatMessage({ id: "pages.publicServer.noLongerPublic" })
        : response?.error || formatMessage({ id: "message.threadPanel.loadFailedTitle" }));
    } finally {
      if (generation === threadRequestGeneration.current) setThreadLoading(false);
    }
  }, [formatMessage, slug]);
  const handleOpenThread = useCallback((request: OpenThreadRequest) => {
    const threadChannelId = request.initialThreadChannelId ?? request.threadChannelId;
    if (threadChannelId) {
      void openPublicThread({
        threadChannelId,
        parentChannelId: request.parentChannelId,
        parentMessageId: request.parentMessageId,
      });
    }
  }, [openPublicThread]);
  const closeThread = useCallback(() => {
    threadRequestGeneration.current += 1;
    setOpenThread(null);
  }, []);
  const selectSettingsTabFromRail = useCallback((tab: PublicSettingsView) => {
    setSettingsTab(tab);
    setSurfaceMode("settings");
  }, []);
  const showServerSelectionNotice = useCallback(() => setServerSelectionNotice(true), []);
  const readbackServer = readback?.server;
  const publicProjection = useMemo(() => (readbackServer ? {
    server: readbackServer,
    authenticated,
    showHelp: surfaceCapabilities.showHelp,
    activeMode: surfaceMode,
    onSelectMode: setSurfaceMode,
    onSelectSettingsTab: selectSettingsTabFromRail,
    onAnonymousServerSelection: showServerSelectionNotice,
  } : null), [
    authenticated,
    readbackServer,
    selectSettingsTabFromRail,
    showServerSelectionNotice,
    surfaceCapabilities.showHelp,
    surfaceMode,
  ]);
  // Column widths apply only where the columns sit side by side (sm and up).
  const channelSidebarStyle = useMemo(
    () => (isSmUp ? { width: channelSidebarWidth } : undefined),
    [channelSidebarWidth, isSmUp],
  );
  const settingsLoadingFallback = useMemo(
    () => (
      <div className="flex justify-center p-6">
        <Spinner size="md" aria-label={formatMessage({ id: "common.loadingLabel" })} />
      </div>
    ),
    [formatMessage],
  );
  const settingsSidebarStyle = useMemo(
    () => (isSmUp ? { width: settingsSidebarWidth } : undefined),
    [isSmUp, settingsSidebarWidth],
  );
  const threadPanelStyle = useMemo(
    () => (isSmUp ? { width: threadPanelWidth } : undefined),
    [isSmUp, threadPanelWidth],
  );
  const loadOlderThreadMessages = useCallback(async () => {
    if (!openThread || threadLoading || threadMessages.length === 0) return;
    const generation = threadRequestGeneration.current;
    setThreadLoading(true);
    try {
      const beforeMessageId = threadMessages[0]!.id;
      const { data } = await api.get<{ messages: PublicMessage[] }>(
        `/public/servers/${encodeURIComponent(slug)}/threads/${encodeURIComponent(openThread.threadChannelId)}/messages?limit=50&beforeMessageId=${encodeURIComponent(beforeMessageId)}`,
      );
      if (generation !== threadRequestGeneration.current) return;
      setThreadMessages((current) => [...data.messages, ...current]);
      setThreadHasOlder(data.messages.length === 50);
    } catch (err: unknown) {
      if (generation !== threadRequestGeneration.current) return;
      const response = getApiErrorResponse(err);
      setThreadError(response?.status === 404
        ? formatMessage({ id: "pages.publicServer.noLongerPublic" })
        : response?.error || formatMessage({ id: "message.threadPanel.loadFailedTitle" }));
    } finally {
      if (generation === threadRequestGeneration.current) setThreadLoading(false);
    }
  }, [formatMessage, openThread, slug, threadLoading, threadMessages]);

  const adaptedMessages = useMemo(
    () => messages.map((message) => toReadOnlyMessage(message, selectedChannelId ?? "")),
    [messages, selectedChannelId],
  );
  const publicSenderByMessageId = useMemo(
    () => new Map(messages.map((message) => [message.id, message.sender] as const)),
    [messages],
  );
  const publicMessageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  // The same scroll and pagination primitive the signed-in ChatPanel and the
  // read-only thread panel use. It takes plain data, so no member store is read.
  const messageSource = useMemo<MessageTimelineSource>(() => ({
    messages: adaptedMessages,
    hasOlder,
    hasNewer: false,
    loading: loadingMessages,
    loadOlder,
    loadNewer: noopLoadNewer,
  }), [adaptedMessages, hasOlder, loadOlder, loadingMessages]);
  const selectedId = selected?.id ?? "";
  const renderPublicMessage = useCallback((adaptedMessage: Message) => {
    const message = publicMessageById.get(adaptedMessage.id);
    if (!message) return null;
    return (
      <PublicMessageRow
        message={message}
        adaptedMessage={adaptedMessage}
        channels={displayChannels}
        parentChannelId={selectedId}
        sender={publicSenderByMessageId.get(adaptedMessage.id)}
        onNavigateChannel={selectPublicChannel}
        onOpenThread={handleOpenThread}
      />
    );
  }, [displayChannels, handleOpenThread, publicMessageById, publicSenderByMessageId, selectPublicChannel, selectedId]);
  const threadSenderByMessageId = useMemo(() => {
    const pairs = threadMessages.map((message) => [message.id, message.sender] as const);
    const parent = openThread ? messages.find((message) => message.id === openThread.parentMessageId) : null;
    if (parent) pairs.push([parent.id, parent.sender]);
    return new Map(pairs);
  }, [messages, openThread, threadMessages]);
  const readOnlyThreadData = useMemo<ReadOnlyThreadData | null>(() => {
    if (!openThread) return null;
    const parent = adaptedMessages.find((message) => message.id === openThread.parentMessageId);
    if (!parent) return null;
    return {
      threadChannelId: openThread.threadChannelId,
      parentChannelId: openThread.parentChannelId,
      parentMessage: parent,
      replies: threadMessages.map((message) => toReadOnlyMessage(message, openThread.threadChannelId)),
      senderByMessageId: threadSenderByMessageId,
      channels: displayChannels,
      loading: threadLoading,
      error: threadError,
      hasOlder: threadHasOlder,
      loadOlder: loadOlderThreadMessages,
    };
  }, [adaptedMessages, displayChannels, loadOlderThreadMessages, openThread, threadError, threadHasOlder, threadLoading, threadMessages, threadSenderByMessageId]);
  const publicSettingsGroups = useMemo(() => [
    ...(surfaceCapabilities.settingsScope === "account-and-resources" ? [{
      label: formatMessage({ id: "layout.sidebar.settingsGroupPersonal" }),
      items: [
        { id: "account", label: formatMessage({ id: "settings.tabs.account" }), icon: <User size={14} className="shrink-0" />, onClick: () => setSettingsTab("account"), testId: "workspace-settings-nav-account" },
        { id: "language-region", label: formatMessage({ id: "settings.tabs.languageRegion" }), icon: <Languages size={14} className="shrink-0" />, onClick: () => setSettingsTab("language-region"), testId: "workspace-settings-nav-language-region" },
        { id: "appearance", label: formatMessage({ id: "settings.tabs.appearance" }), icon: <Type size={14} className="shrink-0" />, onClick: () => setSettingsTab("appearance"), testId: "workspace-settings-nav-appearance" },
      ],
    }] : []),
    {
      label: formatMessage({ id: "layout.sidebar.settingsGroupAbout" }),
      items: [
        { id: "about", label: formatMessage({ id: "layout.sidebar.settingsAbout" }), icon: <BadgeInfo size={14} className="shrink-0" />, onClick: () => setSettingsTab("about"), testId: "workspace-settings-nav-about" },
        { id: "documentation", label: formatMessage({ id: "layout.sidebar.settingsDocumentation" }), icon: <BookOpenText size={14} className="shrink-0" />, href: "https://docs.raft.build", testId: "workspace-settings-nav-documentation" },
        ...(surfaceCapabilities.settingsScope === "account-and-resources" ? [
          { id: "feedback", label: formatMessage({ id: "settings.about.feedbackTitle" }), icon: <MessageSquare size={14} className="shrink-0" />, onClick: () => setSettingsTab("feedback"), testId: "workspace-settings-nav-feedback" },
          { id: "release-notes", label: formatMessage({ id: "layout.sidebar.settingsReleaseNotes" }), icon: <FileText size={14} className="shrink-0" />, onClick: () => setSettingsTab("release-notes"), testId: "workspace-settings-nav-release-notes" },
        ] : []),
      ],
    },
  ], [formatMessage, surfaceCapabilities.settingsScope]);
  const joinable = readback?.canJoinAsGuest === true;
  const bottomBannerMessageId = authenticated
    ? joinable ? "pages.publicServer.joinableAuthenticatedBanner" : "pages.publicServer.viewOnlyAuthenticatedBanner"
    : joinable ? "pages.publicServer.joinableAnonymousBanner" : "pages.publicServer.viewOnlyAnonymousBanner";

  // Rendered as the last row of everything right of the rail, NOT inside the
  // channel column. Its `w-full` used to mean "100% of the middle column",
  // which squeezed the copy to one character per line (Cindy, #wg-rbac task
  // #116). Living outside the chat/settings fork also means the settings
  // surface gets it without a second copy.
  const bottomBanner = (
  <Banner
    intent="info"
    density="sm"
    // The Banner is a CSS grid: copy at
    // col-start-1 row-start-1, actions at col-start-2 row-start-1. Its own rule
    // already stacks them below roughly 400px, so the gap this closes is the
    // ~424-640 band, where the actions still hold the right column and squeeze
    // the sentence to ~130px (measured, @gzj's review).
    //
    // Targets the recipe's published `data-slot` hook rather than :last-child,
    // and pins justify-self so the actions stay right-aligned across the band
    // boundary — below it the recipe's own fallback right-aligns them.
    //
    // Why a grid at all: #7347 replaced slock's own hand-rolled flex Banner
    // wrapper with a delegation to raft-ui's Banner, whose recipe is a grid. The
    // raft-ui 0.5.11 -> 0.5.14 bump rode along in the same PR and is NOT the
    // cause — the recipe's banner layout is identical across those two versions.
    // A revert of #7347 therefore returns the wrapper to flex and makes every
    // rule below inert, with no test turning red.
    //
    // NOT here on purpose: `max-sm:grid-cols-1`. The recipe declares its columns
    // via `…:has(>[data-slot=banner-action])`, specificity (0,2,0); a plain
    // utility is (0,1,0) and a media query adds none, so it loses regardless of
    // order. It was in an earlier revision doing nothing at all.
    className="z-10 w-full shrink-0 !items-center rounded-none border-x-0 border-b-0 !px-5 max-sm:gap-2 max-sm:[&>[data-slot=banner-action]]:col-start-1 max-sm:[&>[data-slot=banner-action]]:row-start-2 max-sm:[&>[data-slot=banner-action]]:col-end-3 max-sm:[&>[data-slot=banner-action]]:justify-self-end"
    data-testid="public-server-bottom-action"
    actions={authenticated ? (
      joinable ? (
        <Button size="md" variant="accent" onClick={openJoinConfirm} disabled={joining} data-testid="public-server-join-guest">
          <UserPlus className="size-4" />{formatMessage({ id: "pages.publicServer.joinAsGuest" })}
        </Button>
      ) : null
    ) : joinable ? (
      <div className="flex items-center gap-2">
        <Button size="md" variant="accent" onClick={onSignIn}><LogIn className="size-4" />{formatMessage({ id: "pages.publicServer.signIn" })}</Button>
        <Button size="md" variant="outline" onClick={onRegister}><UserPlus className="size-4" />{formatMessage({ id: "pages.publicServer.join" })}</Button>
      </div>
    ) : (
      <div className="flex items-center gap-2">
        <Button size="md" variant="accent" onClick={onRegister}><UserPlus className="size-4" />{formatMessage({ id: "pages.publicServer.join" })}</Button>
        <Button size="md" variant="outline" onClick={onSignIn}><LogIn className="size-4" />{formatMessage({ id: "pages.publicServer.signIn" })}</Button>
      </div>
    )}
  >
    <span className="text-sm font-bold" data-testid="public-server-bottom-action-copy">
      {formatMessage({ id: bottomBannerMessageId }, { server: readback?.server.name ?? slug })}
    </span>
  </Banner>
  );

  if (!readback && !error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-layer-canvas-muted theme-brutal:bg-brutal-cream" data-testid="public-server-loading">
        <Spinner size="lg" aria-label={formatMessage({ id: "common.loadingLabel" })} />
      </div>
    );
  }

  return (
    // Same rui shell root as the signed-in MainLayout. It is what sets
    // --shell-header-height (56px Elegant / 62px Brutal, 48px on short
    // viewports), so every `h-panel-header` row below lines up with the shared
    // PanelHeader and rail header instead of falling back to 62px in every theme.
    // The slots default to `hidden md:flex`; this page keeps its channel column
    // and full-screen thread overlay on phones, so those two opt back in.
    <AppShellRoot className="h-dvh min-h-screen flex-col overflow-hidden font-display" data-testid="public-server-page">
      <div className="relative flex min-h-0 flex-1" data-testid="public-server-app-shell">
        {publicProjection ? (
          <AppShellRailSlot>
            <LeftRail publicProjection={publicProjection} />
          </AppShellRailSlot>
        ) : null}

        <div className="relative flex min-w-0 flex-1 flex-col" data-testid="public-server-surface-stack">
        <div className="relative flex min-h-0 flex-1" data-testid="public-server-columns">

        {surfaceMode === "chat" ? <AppShellSidebarSlot render={CHANNEL_SIDEBAR_NAV} className="relative flex w-36 shrink-0 flex-col sm:w-[240px]" style={channelSidebarStyle} aria-label={formatMessage({ id: "pages.publicServer.channelsLabel" })} data-testid="public-server-channel-sidebar">
          <PanelResizeHandle
            side="right"
            visibleFrom="sm"
            onPointerDown={handleChannelSidebarResizeStart}
            onPointerMove={handleChannelSidebarResizeMove}
            onPointerUp={handleChannelSidebarResizeEnd}
            onPointerCancel={handleChannelSidebarResizeEnd}
            data-testid="public-server-channel-sidebar-resize-handle"
          />
          {/* The scroll lives INSIDE the column: an overflow container clips an absolutely positioned handle that
              straddles its edge, so the divider existed but could not be grabbed (caught in a real browser —
              elementFromPoint at the handle's own centre returned the nav). */}
          <PublicServerChannelSidebar
            serverName={readback?.server.name ?? ""}
            channelsLabel={formatMessage({ id: "pages.publicServer.channelsLabel" })}
            channels={readback?.channels ?? EMPTY_PUBLIC_CHANNELS}
            selectedChannelId={selectedChannelId}
            onSelectChannel={selectPublicChannelById}
          />
        </AppShellSidebarSlot> : null}

        {surfaceMode === "chat" ? <AppShellMainSlot className="bg-layer-canvas theme-brutal:bg-white" data-testid="public-server-channel-panel">
          {selected ? (
            <ConversationPanelRoot edge="attached" className="relative border-l-0">
              <PanelHeader
                title={selected.name}
                subtitle={selected.description}
                icon={<Hash size={18} />}
                containerProps={CHANNEL_HEADER_CONTAINER_PROPS}
              />
              <ConversationPanelContent>
              {error ? <Banner intent="warning" className="m-3 shrink-0">{error}</Banner> : null}
              <div className="relative min-h-0 flex-1 overflow-hidden" aria-live="polite">
                {messages.length > 0 ? (
                  <MessageTimeline
                    key={selected.id}
                    source={messageSource}
                    renderItem={renderPublicMessage}
                    className="h-full"
                    testId="public-server-message-timeline"
                    persistKey={`public-channel:${selected.id}`}
                    sparseAnchor="bottom"
                  />
                ) : null}
                {!loadingMessages && messages.length === 0 ? (
                  <EmptyState
                    className="flex h-full flex-col items-center justify-center"
                    icon={<MessageSquare size={36} />}
                    title={formatMessage({ id: "pages.publicServer.emptyMessages" })}
                    data-testid="public-server-empty-messages"
                  />
                ) : null}
                {loadingMessages && messages.length === 0 ? (
                  <div className="flex justify-center p-6" data-testid="public-server-messages-loading">
                    <Spinner size="md" aria-label={formatMessage({ id: "common.loadingLabel" })} />
                  </div>
                ) : null}
              </div>
              </ConversationPanelContent>
            </ConversationPanelRoot>
          ) : (
            <EmptyState
              className="flex h-full flex-col items-center justify-center"
              icon={<Hash size={36} />}
              title={formatMessage({ id: "pages.publicServer.emptyChannels" })}
              data-testid="public-server-empty-channels"
            />
          )}
        </AppShellMainSlot> : (
          <>
            <AppShellSidebarSlot render={SETTINGS_SIDEBAR_ASIDE} className="relative flex w-36 shrink-0 flex-col sm:w-[240px]" style={settingsSidebarStyle} data-testid="public-server-settings-sidebar">
              <PanelResizeHandle
                side="right"
                visibleFrom="sm"
                onPointerDown={handleSettingsSidebarResizeStart}
                onPointerMove={handleSettingsSidebarResizeMove}
                onPointerUp={handleSettingsSidebarResizeEnd}
                onPointerCancel={handleSettingsSidebarResizeEnd}
                data-testid="public-server-settings-sidebar-resize-handle"
              />
              <PublicServerSidebarFrame
                title={formatMessage({ id: "layout.sidebar.headerSettings" })}
                testIdPrefix="public-server-settings-sidebar"
                scrollTestId="public-server-settings-list"
              >
                <nav aria-label={formatMessage({ id: "settings.tabs.navAriaLabel" })}>
                  <SettingsSidebarList groups={publicSettingsGroups} activeId={settingsTab} />
                </nav>
              </PublicServerSidebarFrame>
            </AppShellSidebarSlot>
            <AppShellMainSlot className="bg-layer-canvas theme-brutal:bg-white" data-testid="public-server-settings-surface">
              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
                {settingsTab === "release-notes" ? (
                  <Suspense fallback={settingsLoadingFallback}>
                    <ReleaseNotesPanel />
                  </Suspense>
                ) : <SettingsPanel tab={settingsTab} showAboutWorkspace={false} />}
              </div>
            </AppShellMainSlot>
          </>
        )}
        {/* `sm:relative` (not `sm:static`) gives the resize handle below its positioning context. Side effect worth
            knowing: it also makes the `z-20` — previously mobile-only, when this panel was a full-screen overlay —
            apply at sm and above, so this column now stacks above the main column. That is what the -left-1 handle
            needs, but a future floating element on the main column's right edge would collide here
            (@Bugen, review of PR #7983). */}
        {readOnlyThreadData ? (
          <AppShellPanelSlot ref={threadPanelRef} className="absolute inset-0 z-20 flex bg-layer-canvas sm:relative sm:w-[380px] sm:border-l sm:border-line-hairline theme-brutal:bg-white theme-brutal:sm:border-l-2 theme-brutal:sm:border-black" style={threadPanelStyle} data-testid="public-server-thread-panel">            <PanelResizeHandle
              side="left"
              visibleFrom="sm"
              onPointerDown={handleThreadPanelResizeStart}
              onPointerMove={handleThreadPanelResizeMove}
              onPointerUp={handleThreadPanelResizeEnd}
              onPointerCancel={handleThreadPanelResizeEnd}
              data-testid="public-server-thread-panel-resize-handle"
            />
            <ThreadPanel
              presentation="side"
              onClose={closeThread}
              showComposer={false}
              readOnlyData={readOnlyThreadData}
            />
          </AppShellPanelSlot>
        ) : null}
        </div>
        {bottomBanner}
        </div>
      </div>

      {serverSelectionNotice ? (
        <Banner intent="info" density="sm" className="fixed left-1/2 top-4 z-50 -translate-x-1/2" data-testid="public-server-selection-notice" actions={<Button size="xs" variant="outline" onClick={onSignIn}>{formatMessage({ id: "pages.publicServer.signIn" })}</Button>}>
          {formatMessage({ id: "pages.publicServer.banner" })}
        </Banner>
      ) : null}

      {joinError ? <Banner intent="warning" density="sm" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 font-bold">{joinError}</Banner> : null}
      {joinConfirmOpen ? (
        <ConfirmDialog
          title={formatMessage({ id: "pages.publicServer.joinConfirmTitle" })}
          message={formatMessage({ id: "pages.publicServer.joinConfirmDescription" }, { server: readback?.server.name ?? slug })}
          confirmLabel={formatMessage({ id: "pages.publicServer.joinAsGuest" })}
          loadingLabel={formatMessage({ id: "server.communityAgreement.joining" })}
          confirmColor="bg-brutal-pink"
          onConfirm={confirmJoinAsGuest}
          onClose={closeJoinConfirm}
        />
      ) : null}
      {agreement ? (
        <CommunityAgreementDialog
          agreement={agreement}
          onAgree={joinAsGuest}
          onClose={closeAgreement}
        />
      ) : null}
    </AppShellRoot>
  );
}
