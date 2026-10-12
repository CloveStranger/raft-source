import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isHostShell } from "../../embed";
import { useIntl } from "react-intl";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  ArrowUpRight,
  BookOpenText,
  CheckSquare,
  CircleHelp,
  MessageSquare,
  Monitor,
  Search,
  Settings,
  Users,
  UsersRound,
  Smartphone,
} from "lucide-react";
import { useFeedbackUnread } from "../../feedback/useFeedbackUnread";
import { useAuthStore } from "../../store/authStore";
import { useServerStore } from "../../store/serverStore";
import type { Server } from "../../store/serverStore";
import { useMessageStore } from "../../store/messageStore";
import { useInboxStore } from "../../store/inboxStore";
import { useChannelStore } from "../../store/channelStore";
import { useMachineStore } from "../../store/machineStore";
import { SERVER_NOTIFICATION_PREFS_UPDATED_EVENT } from "../../store/events/notificationPrefsEvents";
import { useRailMode } from "../../hooks/useSidebarTab";
import { trackActivityOpen } from "../../analytics/activity";
import {
  hasCurrentServerActivityUnread,
  hasOtherServerActivityUnread,
} from "../../utils/serverUnreadSummary";
import { countMachinesNeedingAttention } from "../../utils/computerUpgradeIndicator";
import AttentionDot from "../ui/AttentionDot";
import AvatarSlot from "../ui/AvatarSlot";
import MenuItem from "../ui/MenuItem";
import SectionEyebrow from "../ui/SectionEyebrow";
import ServerSwitcherMenu from "../ui/ServerSwitcherMenu";
import {
  AppRailFooter,
  AppRailHeader,
  AppRailItem,
  AppRailItemAttention,
  AppRailItemIcon,
  AppRailItemLabel,
  AppRailNav,
  AppRailRoot,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Spinner,
} from "raft-ui";
import Tooltip from "../ui/Tooltip";
import NotificationTrigger from "./NotificationTrigger";
import { hasChatAttentionUnread, selectChatAttentionChannelIds } from "../../utils/chatAttentionUnread";
import { useShallow } from "zustand/react/shallow";
import { useJoinCommunityFlow } from "../../hooks/useJoinCommunityFlow";
import { markMobileAppSeen, shouldShowMobileAppBadge } from "./mobileAppBadge";
import {
  CHINESE_COMMUNITY_PAGE_PATH,
  DEFAULT_COMMUNITY_SERVER_SLUG,
  shouldShowChineseCommunityEntry,
} from "../../utils/communityServers";

// Narrow vertical rail to the left of the Sidebar. Hosts, top to bottom:
// 1. Server avatar / switcher button (clicking opens a flyout to switch servers)
// 2. Rail mode buttons. The selection derives from the URL.
//
// Rail mode is path-based: /channel/, /dm/, /threads, /tasks, /saved, /search
// are chat; /agent/, /human/, /members are members; /computer/, /computers
// are computers; /settings/, /release-notes are settings. Clicking a rail
// button restores that mode's last-visited path from localStorage memory,
// or falls back to the mode's canonical landing.
//
// Hidden on mobile root inline view: mobile already has its own bottom tab bar
// and the sidebar is the whole main area, so a second vertical rail there would
// just steal width.
const EMPTY_SERVER_UNREAD_COUNTS = {};

const TOOLTIP_CONTENT_PROPS = {
  left: { side: "left" },
  right: { side: "right" },
} as const;

function stopMouseDownPropagation(event: React.MouseEvent) {
  event.stopPropagation();
}

function initialFocusForKeyboardOpen(openType: string) {
  return openType === "keyboard";
}

// Double-clicking Activity jumps straight to the first unread entry.
export function focusFirstUnreadActivity() {
  useInboxStore.getState().setPendingFocusKind("first-unread");
  void useInboxStore.getState().loadInbox({ reset: true });
}

interface LeftRailProps {
  hidden?: boolean;
  thinDivider?: boolean;
  publicProjection?: PublicLeftRailProjection;
}

export interface PublicLeftRailProjection {
  server: Pick<Server, "id" | "name" | "slug" | "avatarUrl">;
  authenticated: boolean;
  showHelp: boolean;
  activeMode: "chat" | "settings";
  onSelectMode: (mode: "chat" | "settings") => void;
  onSelectSettingsTab: (tab: "about" | "feedback") => void;
  onAnonymousServerSelection: () => void;
}

export function LeftRail({ hidden, thinDivider = false, publicProjection }: LeftRailProps) {
  // Display-language (react-intl) — layout namespace. Rail tab labels feed both
  // raft-ui Tooltip content and `aria-label`, so they must come from the catalog,
  // not literals.
  const { formatMessage } = useIntl();
  const feedbackUnread = useFeedbackUnread(!hidden && !publicProjection);
  const currentUserId = useAuthStore((s) => s.user?.id ?? null);
  const server = useServerStore((s) => s.current);
  const isGuest = server?.role === "guest";
  const servers = useServerStore((s) => s.servers);
  // Public discovery rows retain their gray row-level unread marker, but only
  // joined channels and DMs participate in the global pink Chat attention dot.
  // Keep the channel-id projection shallow so high-frequency channel activity
  // updates do not churn this rail subscription.
  const chatAttentionChannelIds = useChannelStore(useShallow((s) =>
    selectChatAttentionChannelIds(s.channels, s.dmChannels),
  ));
  const hasLocalChatUnread = useMessageStore((s) =>
    hasChatAttentionUnread(chatAttentionChannelIds, s.unreadCounts),
  );
  // Keep this subscription on 0↔nonzero / accepted-window edges rather than
  // every count. Once Activity accepts a fresh server window, totalUnreadCount
  // owns the current-server dot; the cached cross-server summary remains only
  // a pre-load hint and cannot resurrect a read dot.
  const [hasAcceptedActivityWindow, hasActivityTotalUnread, hasPreloadActivityUnread] = useInboxStore(useShallow((s) => [
    s.hasAcceptedWindow,
    s.totalUnreadCount > 0,
    s.activeUnreadCount > 0,
  ] as const));
  const [computerAttentionCount, machineCount] = useMachineStore(useShallow((s) => [
    countMachinesNeedingAttention(s.machines),
    s.machines.length,
  ] as const));
  const computerAttentionTooltip = computerAttentionCount > 0
    ? formatMessage(
        { id: "layout.leftRail.computersNeedAttentionSummary" },
        { count: computerAttentionCount, total: machineCount },
      )
    : undefined;
  const { railMode, selectRailMode } = useRailMode();

  const [showServerMenu, setShowServerMenu] = useState(false);
  const [showHelpMenu, setShowHelpMenu] = useState(false);
  // Single source of truth: the store owns the cross-server unread summary.
  const serverUnreadCounts = useServerStore((s) => s.serverUnreadCounts);
  const loadServerUnreadSummary = useServerStore((s) => s.loadServerUnreadSummary);

  // One-shot "there is a mobile app now" dot. Read from storage rather than
  // held in a store: it is per user and per device by construction (see
  // mobileAppBadge.ts), and `currentUserId` arrives after the first render on a
  // cold load, so the initial value has to be recomputed once it lands.
  //
  // Initialised lazily, and the effect below is a genuine no-op on mount.
  // Both halves are load-bearing against `leftRailActivityDotSubscription`,
  // which budgets the rail's commits:
  //   - `useState(false)` + effect  → the effect commits on every mount
  //   - identity-guarded setState   → still commits; a bailed-out setState is
  //                                   not a free one
  // Only skipping the call entirely is free. The effect still has to exist,
  // because on a cold load the auth store hydrates after the rail mounts — the
  // lazy value would then be computed with no user and the dot would never
  // appear for that session.
  const [showMobileAppBadge, setShowMobileAppBadge] = useState(
    () => shouldShowMobileAppBadge(currentUserId),
  );
  const badgeUserIdRef = useRef(currentUserId);
  useEffect(() => {
    if (badgeUserIdRef.current === currentUserId) return;
    badgeUserIdRef.current = currentUserId;
    setShowMobileAppBadge(shouldShowMobileAppBadge(currentUserId));
  }, [currentUserId]);
  const dismissMobileAppBadge = useCallback(() => {
    markMobileAppSeen(currentUserId);
    setShowMobileAppBadge(false);
  }, [currentUserId]);

  const _pathBase = useMemo(() => (server ? `/s/${server.slug}` : ""), [server]);

  useEffect(() => {
    if (publicProjection) return;
    // No mount fetch here: App owns the single boot entry for the summary;
    // this effect keeps only the event triggers (prefs change, local-unread
    // edge via the dep below).
    const handleNotificationPrefsUpdated = () => {
      void loadServerUnreadSummary();
    };
    window.addEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handleNotificationPrefsUpdated);
    return () => {
      window.removeEventListener(SERVER_NOTIFICATION_PREFS_UPDATED_EVENT, handleNotificationPrefsUpdated);
    };
    // The store coalesces concurrent calls, so this is a cheap trigger rather
    // than a second fetch. Refresh when local unread appears/clears (flip).
  }, [hasLocalChatUnread, publicProjection, loadServerUnreadSummary]);

  const hasOtherServerUnread = useMemo(
    () => hasOtherServerActivityUnread(servers, server, serverUnreadCounts),
    [servers, server, serverUnreadCounts],
  );
  const currentServerActivityCount = server?.id
    ? serverUnreadCounts[server.id]?.activityUnreadCount
    : undefined;
  const hasActivityUnread = hasCurrentServerActivityUnread({
    hasAcceptedWindow: hasAcceptedActivityWindow,
    hasTotalUnread: hasActivityTotalUnread,
    hasPreloadActiveUnread: hasPreloadActivityUnread,
    summaryUnreadCount: currentServerActivityCount,
  });
  // Chat dot tracks unread in joined channels and DMs; Activity dot tracks
  // the server-authoritative Activity count independently of the selected
  // Activity filter.
  // Before Activity earned its own rail
  // entry (stdrc #proj-activity:171042a3 6/20) the Chat dot summed both
  // signals so the user wouldn't miss inbox-only items; with Activity now
  // visible on the rail, the Chat dot returns to its narrower meaning.
  const hasChatUnread = hasLocalChatUnread;

  const toggleServerMenu = useCallback(() => {
    setShowHelpMenu(false);
    setShowServerMenu((open) => !open);
  }, []);
  const closeServerMenu = useCallback(() => setShowServerMenu(false), []);
  const closeHelpMenu = useCallback(() => setShowHelpMenu(false), []);
  const railModeSelectors = useMemo(() => ({
    search: () => selectRailMode("search"),
    chat: () => selectRailMode("chat"),
    tasks: () => selectRailMode("tasks"),
    members: () => selectRailMode("members"),
    computers: () => selectRailMode("computers"),
    settings: () => selectRailMode("settings"),
  }), [selectRailMode]);
  const handleClassicActivityClick = useCallback((event: React.MouseEvent) => {
    if (event.detail >= 2) return;
    trackActivityOpen("rail");
    selectRailMode("activity");
  }, [selectRailMode]);
  const selectPublicChatMode = useCallback(() => publicProjection?.onSelectMode("chat"), [publicProjection]);
  const selectPublicSettingsMode = useCallback(() => publicProjection?.onSelectMode("settings"), [publicProjection]);
  const openPublicFeedback = useCallback(() => publicProjection?.onSelectSettingsTab("feedback"), [publicProjection]);
  const openPublicMobileApp = useCallback(() => publicProjection?.onSelectSettingsTab("about"), [publicProjection]);
  const handlePublicServerSwitcherClick = useCallback(() => {
    if (!publicProjection) return;
    if (!publicProjection.authenticated) {
      publicProjection.onAnonymousServerSelection();
      return;
    }
    setShowServerMenu((open) => !open);
  }, [publicProjection]);

  // Outside-click + ESC dismissal lives inside <ServerSwitcherMenu>; the
  // trigger button below uses `onMouseDown={(e) => e.stopPropagation()}` so
  // toggling the menu doesn't re-fire the document mousedown listener and
  // close the just-opened menu.

  const serverInitial = (server?.name || "S").trim().charAt(0).toUpperCase() || "S";

  if (hidden) return null;
  if (publicProjection) {
    // Public rail runs the same rui AppRail* chrome as the authenticated rail,
    // in every theme (cindyz, #wg-rbac:f8b37c04: "都改成和登录后的一致"). This
    // replaces the hand-built brutal strip that rendered yellow in Elegant, and
    // the black server-avatar block that only this rail had.
    return (
      <AppRailRoot
        className="hidden shrink-0 pb-2 md:flex"
        data-testid="workspace-left-rail"
        data-public-server-rail="true"
      >
        <AppRailHeader>
          <Tooltip content={publicProjection.server.name} contentProps={TOOLTIP_CONTENT_PROPS.right}>
            <AppRailItem
              selected={showServerMenu}
              onMouseDown={stopMouseDownPropagation}
              onClick={handlePublicServerSwitcherClick}
              aria-label={formatMessage(
                { id: "layout.leftRail.switchServerAria" },
                { serverName: publicProjection.server.name },
              )}
              className="size-10 overflow-hidden p-0 md:[@media(max-height:600px)]:size-9"
              data-testid="public-server-switcher-trigger"
            >
              <AppRailItemIcon>
                <AvatarSlot
                  context="panel-header"
                  type="server"
                  serverAvatarUrl={publicProjection.server.avatarUrl}
                  serverInitial={publicProjection.server.name}
                  className="md:[@media(max-height:600px)]:!size-8"
                />
              </AppRailItemIcon>
            </AppRailItem>
          </Tooltip>
          {publicProjection.authenticated ? (
            <ServerSwitcherMenu
              open={showServerMenu}
              onClose={closeServerMenu}
              serverUnreadCounts={EMPTY_SERVER_UNREAD_COUNTS}
              testId="desktop-server-switcher-menu"
              className="absolute left-full top-1 ml-2 max-h-[calc(100dvh-16px)] w-64"
            />
          ) : null}
        </AppRailHeader>
        <AppRailNav>
          <RailTabButton
            icon={<MessageSquare size={18} />}
            label={formatMessage({ id: "layout.leftRail.tabChat" })}
            active={publicProjection.activeMode === "chat"}
            onClick={selectPublicChatMode}
            testId="left-rail-tab-chat"
          />
        </AppRailNav>
        <AppRailFooter>
          {publicProjection.showHelp ? (
            <Popover open={showHelpMenu} onOpenChange={setShowHelpMenu}>
              <div className="relative flex h-11 w-full items-center justify-center">
                <PopoverTrigger
                  openOnHover
                  delay={0}
                  closeDelay={120}
                  render={(
                    <RailTabButton
                      icon={<CircleHelp size={18} />}
                      label={formatMessage({ id: "layout.leftRail.tabHelp" })}
                      active={showHelpMenu}
                      onClick={closeServerMenu}
                      testId="left-rail-help"
                      ariaHasPopup="menu"
                      ariaExpanded={showHelpMenu}
                      showTooltip={false}
                      showDot={showMobileAppBadge}
                    />
                  )}
                />
                <HelpMenu
                  servers={servers}
                  serverSlugOverride={publicProjection.server.slug}
                  onClose={closeHelpMenu}
                  showMobileAppBadge={showMobileAppBadge}
                  onMobileAppOpened={dismissMobileAppBadge}
                  onOpenFeedback={openPublicFeedback}
                  onOpenMobileApp={openPublicMobileApp}
                />
              </div>
            </Popover>
          ) : null}
          <div className="flex h-11 w-full items-center justify-center">
            <RailTabButton
              icon={<Settings size={18} />}
              label={formatMessage({ id: "layout.leftRail.tabSettings" })}
              active={publicProjection.activeMode === "settings"}
              onClick={selectPublicSettingsMode}
              testId="left-rail-settings"
            />
          </div>
        </AppRailFooter>
      </AppRailRoot>
    );
  }
  // HOST-SHELL EMBED: the native WebView owns its chrome; this rail is global app
  // navigation and must not render inside it.
  //
  // Placed AFTER the hooks, not before: an early return ahead of them calls hooks
  // conditionally and breaks the Rules of Hooks (oxlint react-doctor caught exactly
  // that on my first attempt). It is still on the RENDER PATH — the very first frame
  // already returns null — so there is no flash. An effect would paint the rail on
  // frame 1 and delete it on frame 2, which the user sees and no "final DOM"
  // assertion can catch.
  if (isHostShell()) return null;

  const brutalRailDividerClassName = thinDivider ? "theme-brutal:!border-r" : "";

  return (
    <>
      <AppRailRoot
        className={`hidden md:flex pb-2 ${brutalRailDividerClassName}`}
        data-testid="workspace-left-rail"
      >
      {/* Server switcher (top) */}
      <AppRailHeader>
        <Tooltip
          content={server?.name || formatMessage({ id: "layout.leftRail.serverFallbackName" })}
          contentProps={TOOLTIP_CONTENT_PROPS.right}
        >
          <AppRailItem
            selected={showServerMenu}
            onMouseDown={stopMouseDownPropagation}
            onClick={toggleServerMenu}
            aria-label={formatMessage(
              { id: "layout.leftRail.switchServerAria" },
              { serverName: server?.name || formatMessage({ id: "layout.leftRail.serverFallbackName" }) },
            )}
            // Server-name button matches RailTabButton geometry: h-10 (40)
            // on tall viewports for visual weight, h-9 (36) on short to fit
            // the compact 48px h-panel-header. stdrc 2026-05-02
            // #proj-uiux:8e7df837 task #98 followup 54fbf722: "server name
            // 按钮怎么没修？" — keep server-initial in step with the rail
            // tabs, not pinned at size-icon-header (36 across all viewports).
            // No overflow-hidden here: the avatar clips its own image, and the
            // other-server unread dot sits on the button's corner (task #685).
            className="size-10 p-0 md:[@media(max-height:600px)]:size-9"
          >
            <AppRailItemIcon className="[&_[data-slot=app-rail-item-attention-mask]]:z-[2] [&_[data-slot=app-rail-item-indicator]]:z-[2]">
              <AvatarSlot
                context="panel-header"
                type="server"
                serverAvatarUrl={server?.avatarUrl}
                serverInitial={serverInitial}
                className="md:[@media(max-height:600px)]:!size-8"
              />
              {hasOtherServerUnread ? (
                <AppRailItemAttention title={formatMessage({ id: "layout.leftRail.serverFallbackName" })}>
                  <span aria-hidden="true" className="hidden">
                    <AttentionDot size="lg" aria-hidden="true" />
                  </span>
                </AppRailItemAttention>
              ) : null}
            </AppRailItemIcon>
          </AppRailItem>
        </Tooltip>

        <ServerSwitcherMenu
          open={showServerMenu}
          onClose={closeServerMenu}
          serverUnreadCounts={serverUnreadCounts}
          testId="desktop-server-switcher-menu"
          className="absolute left-full top-1 ml-2 w-64 max-h-[calc(100dvh-16px)]"
        />
      </AppRailHeader>

      {/* Rail buttons (middle). Mutually-exclusive — at most one is
          highlighted at a time. */}
      <AppRailNav className="relative w-full">
        <RailTabButton icon={<Search size={18} />} label={formatMessage({ id: "layout.leftRail.tabSearch" })} active={railMode === "search"} onClick={railModeSelectors.search} testId="left-rail-tab-search" />
        <RailTabButton icon={<MessageSquare size={18} />} label={formatMessage({ id: "layout.leftRail.tabChat" })} active={railMode === "chat"} onClick={railModeSelectors.chat} showDot={hasChatUnread} dotInactiveOnly testId="left-rail-tab-chat" />
        <RailTabButton
          icon={<Activity size={18} />}
          label={formatMessage({ id: "layout.leftRail.tabActivity" })}
          active={railMode === "activity"}
          showDot={hasActivityUnread}
          dotInactiveOnly
          onClick={handleClassicActivityClick}
          onDoubleClick={focusFirstUnreadActivity}
          testId="left-rail-tab-activity"
        />
        <RailTabButton icon={<CheckSquare size={18} />} label={formatMessage({ id: "layout.leftRail.tabTasks" })} active={railMode === "tasks"} onClick={railModeSelectors.tasks} testId="left-rail-tab-tasks" />
        {!isGuest && <RailTabButton icon={<Users size={18} />} label={formatMessage({ id: "layout.leftRail.tabMembers" })} active={railMode === "members"} onClick={railModeSelectors.members} testId="left-rail-tab-members" />}
        {!isGuest && <RailTabButton
          icon={<Monitor size={18} />}
          label={formatMessage({ id: "layout.leftRail.tabComputers" })}
          active={railMode === "computers"}
          showDot={computerAttentionCount > 0}
          dotInactiveOnly
          dotTooltip={computerAttentionTooltip}
          onClick={railModeSelectors.computers}
          testId="left-rail-tab-computers"
        />}
      </AppRailNav>

      {/* Notification Center trigger — the permanent Bell sits above Help.
          Its pink dot is conditional, but the entry point and empty-state
          drawer remain available even with zero notifications. Originating direction:
          stdrc 2026-05-02 #proj-uiux:f87f6eb9 (task #94 "the top warning bar
          covers itself; collect everything into a popup hung off Settings").
          The popup floats to the right of the rail. */}
      <AppRailFooter>
      <NotificationTrigger flavor="rail-bottom" />

      <Popover open={showHelpMenu} onOpenChange={setShowHelpMenu}>
        <div className="relative flex h-11 w-full items-center justify-center">
          <PopoverTrigger
            openOnHover
            delay={0}
            closeDelay={120}
            render={(
              <RailTabButton
                icon={<CircleHelp size={18} />}
                label={formatMessage({ id: "layout.leftRail.tabHelp" })}
                active={showHelpMenu}
                onClick={closeServerMenu}
                testId="left-rail-help"
                ariaHasPopup="menu"
                ariaExpanded={showHelpMenu}
                showTooltip={false}
                showDot={showMobileAppBadge}
              />
            )}
          />
          <HelpMenu
            servers={servers}
            onClose={closeHelpMenu}
            showMobileAppBadge={showMobileAppBadge}
            onMobileAppOpened={dismissMobileAppBadge}
          />
        </div>
      </Popover>

      <div className="flex h-11 w-full items-center justify-center">
        <RailTabButton icon={<Settings size={18} />} label={formatMessage({ id: "layout.leftRail.tabSettings" })} active={railMode === "settings"} onClick={railModeSelectors.settings} showDot={feedbackUnread > 0} dotTooltip={formatMessage({ id: "layout.systemNotifications.feedbackRepliesTitle" })} testId="left-rail-settings" />
      </div>
      </AppRailFooter>
      </AppRailRoot>
    </>
  );
}

function HelpMenu({
  servers,
  serverSlugOverride,
  onClose,
  showMobileAppBadge,
  onMobileAppOpened,
  onOpenFeedback,
  onOpenMobileApp,
}: {
  servers: Server[];
  serverSlugOverride?: string;
  onClose: () => void;
  showMobileAppBadge: boolean;
  onMobileAppOpened: () => void;
  onOpenFeedback?: () => void;
  onOpenMobileApp?: () => void;
}) {
  const { formatMessage, locale } = useIntl();
  const navigate = useNavigate();
  const storedServerSlug = useServerStore((state) => state.current?.slug ?? null);
  const serverSlug = serverSlugOverride ?? storedServerSlug;
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const communityJoinFlow = useJoinCommunityFlow({
    onJoined: () => {
      onCloseRef.current();
    },
    onError: (_error, _slug, message) => {
      onCloseRef.current();
      // Surfacing via alert matches the existing ServerSwitcherMenu join flow
      // until the app has one shared toast surface for low-frequency failures.
      // eslint-disable-next-line no-alert
      alert(message);
    },
  });
  const showChineseCommunityEntry = shouldShowChineseCommunityEntry(locale);

  const openDocumentation = useCallback(() => {
    onCloseRef.current();
    window.open("https://docs.raft.build", "_blank", "noopener,noreferrer");
  }, []);

  const openFeedback = useCallback(() => {
    if (!serverSlug) return;
    onCloseRef.current();
    if (onOpenFeedback) {
      onOpenFeedback();
      return;
    }
    navigate(`/s/${serverSlug}/settings/feedback`);
  }, [navigate, onOpenFeedback, serverSlug]);
  const openMobileApp = useCallback(() => {
    if (!serverSlug) return;
    // Mark seen on open, not on menu-open: the dot is announcing the mobile app,
    // and someone who opened Help to reach Feedback has not been told about it.
    onMobileAppOpened();
    onCloseRef.current();
    if (onOpenMobileApp) {
      onOpenMobileApp();
      return;
    }
    navigate(`/s/${serverSlug}/settings/about`);
  }, [navigate, onMobileAppOpened, onOpenMobileApp, serverSlug]);

  const { joinCommunity } = communityJoinFlow;
  const openCommunity = useCallback(async () => {
    if (showChineseCommunityEntry) {
      onCloseRef.current();
      navigate(`${CHINESE_COMMUNITY_PAGE_PATH}?from=help-menu`);
      return;
    }
    const joinedDefault = servers.find((candidate) => candidate.slug === DEFAULT_COMMUNITY_SERVER_SLUG);
    if (joinedDefault) {
      onCloseRef.current();
      navigate(`/s/${joinedDefault.slug}`);
      return;
    }
    const outcome = await joinCommunity(DEFAULT_COMMUNITY_SERVER_SLUG);
    if (outcome.status === "agreement_required") onCloseRef.current();
  }, [joinCommunity, navigate, servers, showChineseCommunityEntry]);
  const handleCommunityClick = useCallback(() => {
    void openCommunity();
  }, [openCommunity]);

  return (
    <>
      <PopoverContent
        side="right"
        align="end"
        sideOffset={8}
        initialFocus={initialFocusForKeyboardOpen}
        role="menu"
        aria-label={formatMessage({ id: "layout.leftRail.helpMenuTitle" })}
        data-testid="left-rail-help-menu"
        className="w-80 overflow-hidden p-0"
      >
          <div className="flex items-center border-b border-line-muted bg-layer-panel px-3 py-2 text-foreground-strong theme-brutal:border-b-2 theme-brutal:border-black theme-brutal:bg-brutal-cream theme-brutal:text-black">
            <SectionEyebrow>
              {formatMessage({ id: "layout.leftRail.helpMenuTitle" })}
            </SectionEyebrow>
          </div>
          <MenuItem
            icon={<BookOpenText size={14} className="shrink-0" />}
            trailing={<ArrowUpRight size={14} className="shrink-0" />}
            onClick={openDocumentation}
          >
            {formatMessage({ id: "layout.leftRail.helpDocumentation" })}
          </MenuItem>
          {/* Signpost only — the content lives in Settings so there is one host
              to keep current, not two that can drift (@huxijin, #wg-download-mobile). */}
          {serverSlug ? (
            <MenuItem
              icon={<Smartphone size={14} className="shrink-0" />}
              // `lg` is the canonical dot; `sm` is compact-only, for parents
              // that physically cannot fit 10×10. A menu row fits it easily —
              // I reached for `sm` to make it feel less shouty, which is the
              // priority axis the design system explicitly does not have. At
              // 4×4 it rendered as a speck that read as a rendering artefact
              // rather than a signal (@wenyi, preview review).
              trailing={showMobileAppBadge
                ? (
                  <AttentionDot
                    className="shrink-0"
                    aria-hidden="true"
                    data-testid="help-menu-mobile-app-badge"
                  />
                )
                : undefined}
              onClick={openMobileApp}
              data-testid="help-menu-mobile-app"
            >
              {formatMessage({ id: "layout.leftRail.helpMobileApp" })}
            </MenuItem>
          ) : null}
          {serverSlug ? (
            <MenuItem
              icon={<MessageSquare size={14} className="shrink-0" />}
              onClick={openFeedback}
            >
              {formatMessage({ id: "settings.about.feedbackTitle" })}
            </MenuItem>
          ) : null}
          <MenuItem
            icon={communityJoinFlow.joiningCommunitySlug
              ? <Spinner size="sm" aria-hidden="true"  aria-label={formatMessage({ id: "common.loadingLabel" })} />
              : <UsersRound size={14} className="shrink-0" />}
            onClick={handleCommunityClick}
            disabled={communityJoinFlow.joiningCommunitySlug !== null}
          >
            {communityJoinFlow.joiningCommunitySlug
              ? formatMessage({ id: "layout.leftRail.helpCommunityJoining" })
              : formatMessage({
                  id: showChineseCommunityEntry
                    ? "layout.leftRail.helpChineseCommunity"
                    : "layout.leftRail.helpCommunity",
                })}
          </MenuItem>
      </PopoverContent>
      {communityJoinFlow.agreementDialog}
    </>
  );
}

type RailTabButtonProps = Omit<
  React.ComponentPropsWithoutRef<"button">,
  "children" | "onClick" | "onDoubleClick" | "aria-label" | "aria-haspopup" | "aria-expanded"
> & {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  showDot?: boolean;
  dotInactiveOnly?: boolean;
  dotTone?: string;
  dotTooltip?: string;
  tooltipSide?: "left" | "right";
  onClick: (event: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  testId?: string;
  buttonRef?: React.Ref<HTMLButtonElement>;
  ariaHasPopup?: "menu";
  ariaExpanded?: boolean;
  showTooltip?: boolean;
};

export const RailTabButton = forwardRef<HTMLButtonElement, RailTabButtonProps>(function RailTabButton({
  icon,
  label,
  active,
  showDot,
  dotInactiveOnly,
  dotTone,
  dotTooltip,
  tooltipSide = "right",
  onClick,
  onDoubleClick,
  testId,
  onPointerDown,
  buttonRef,
  ariaHasPopup,
  ariaExpanded,
  showTooltip = true,
  className = "",
  ...buttonProps
}, forwardedRef) {
  const dotVisible = Boolean(showDot && (!dotInactiveOnly || !active));
  const setButtonRefs = useCallback((node: HTMLButtonElement | null) => {
    setReactRef(buttonRef, node);
    setReactRef(forwardedRef, node);
  }, [buttonRef, forwardedRef]);
  const button = (
    <AppRailItem
      {...buttonProps}
      ref={setButtonRefs}
      selected={active}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      aria-label={label}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      data-testid={testId}
      onPointerDown={onPointerDown}
      // RailTabButton size — h-10 (40) on tall viewports for visual weight
      // matching the original brutal aesthetic; shrinks to h-9 (36) on
      // short viewports (max-h:600) to fit the compact 48px h-panel-header
      // and stay aligned with size-icon-header (36) used by main panel
      // header icons. stdrc 2026-05-02 #proj-uiux:8e7df837 task #98:
      // "正常桌面上还是原来的大小比较合适，只在缩窄 rail 和 header 的时候
      // 应该缩按钮".
      className={`size-10 [@media(max-height:600px)]:h-9 [@media(max-height:600px)]:w-9 ${className}`}
    >
      <AppRailItemIcon className="relative">
        {icon}
        {dotVisible ? (
          <AppRailItemAttention title={dotTooltip ?? label}>
            {icon}
            <span className="hidden">
              <AttentionDot size="lg" tone={dotTone} aria-hidden="true" />
            </span>
          </AppRailItemAttention>
        ) : null}
      </AppRailItemIcon>
      <AppRailItemLabel>{label}</AppRailItemLabel>
    </AppRailItem>
  );

  return showTooltip ? (
    <Tooltip
      content={dotVisible && dotTooltip ? dotTooltip : label}
      contentProps={TOOLTIP_CONTENT_PROPS[tooltipSide]}
    >
      {button}
    </Tooltip>
  ) : button;
});

function setReactRef<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === "function") ref(value);
  else ref.current = value;
}

export default LeftRail;
