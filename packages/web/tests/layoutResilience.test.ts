import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8");

test("agent detail diagnostic text cannot squeeze identity or actions", () => {
  const source = read("src/components/agent/AgentDetailPanel.tsx");

  assert.match(source, /<div className="flex min-w-0 items-center gap-1\.5">/);
  assert.match(source, /const activityText = showDetail\s*\?\s*formatActivityText\(\s*formatMessage,\s*displayState\.activity,\s*displayState\.activityDetail,\s*displayState\.activityDetailKind,\s*\)\s*:\s*formatActivityText\(formatMessage, displayState\.activity, ""\);/);
  assert.match(source, /<Tooltip content=\{activityText\}><span className="min-w-0 truncate text-sm text-foreground-muted theme-brutal:text-black\/60 font-mono">/);
  // The description lives only in the Profile tab body; the top bar never repeats it.
  assert.doesNotMatch(source, /subtitle=\{[^}]*agent\.description/);
  assert.match(source, /const headerTitle = agent\.displayName \|\| agent\.name;/);
  assert.match(source, /const titleClickProps = useMemo\(\(\) => \(\{ title: headerTitle \}\), \[headerTitle\]\);/);
  assert.match(source, /titleClickProps=\{titleClickProps\}/);
  assert.match(source, /titleSuffix=\{\s*isDeleted \? \(/);
  assert.match(source, /<Tooltip content=\{startError\}><span className="min-w-0 flex-1 truncate text-sm font-bold text-foreground-strong theme-brutal:text-black">/);
  assert.match(source, /const hasRuntimeError = activityState\?\.activity === "error" \|\| Boolean\(agent\.lastRuntimeError\);/);
  // task #735: the error text deliberately gained a lookup-reason arm in front of
  // the catalog/fallback chain (only a confirmed miss keeps the install copy);
  // this pin tracks the new shape — update it consciously, never silently.
  assert.match(source, /const activityErrorText = startLookupDisplay && startLookupDisplay !== "confirmed_missing"\s*\?\s*formatMessage\(\s*\{ id: RUNTIME_LOOKUP_DISPLAY_MESSAGE_ID\[startLookupDisplay\] \},\s*\{ runtimeName: getRuntimeDisplayName\(agent\.runtime\) \},\s*\)\s*:\s*runtimeErrorKind\s*\?\s*formatMessage\(\{ id: RUNTIME_ERROR_LABEL_ID\[runtimeErrorKind\] \}\)\s*:\s*hasRuntimeError\s*\?\s*formatActivityText\(formatMessage, "error", rawRuntimeError\)\s*:\s*formatMessage\(\{ id: "activity\.status\.agentErrorFallback" \}\)/);
  assert.match(source, /const diagnosticErrorMessage = hasRuntimeError && canViewPrivateAgentSurfaces/);
  assert.match(source, /<Tooltip content=\{canViewPrivateAgentSurfaces \? activityErrorText : activityFallbackErrorText\}><span className="min-w-0 flex-1 line-clamp-2 break-words text-sm font-bold leading-snug text-foreground-strong theme-brutal:text-black">/);
  assert.match(source, /<div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">/);
  // Header identity: the name row holds only the name (and its edit pencil); live
  // activity has its own line under the handle, so it can never squeeze the name.
  assert.match(source, /<div className="min-w-0 flex-1">\s*<div className="flex min-w-0 items-center gap-2">\s*<AgentHeaderName\s+agent=\{agent\}\s+onEdit=\{canManageAgent && !agent\.deletedAt \? editDisplayName : undefined\}\s*\/>\s*<\/div>/);
  assert.match(source, /const editDisplayName = useCallback\(\(\) => setEditField\("displayName"\), \[\]\);/);
  // #737 (cindyz/gzj): the identity name renders through PanelTitle — one spec
  // source with the header title; update this pin consciously if it moves again.
  assert.match(source, /<PanelTitle className="min-w-0 text-foreground-muted theme-brutal:text-black theme-brutal:text-lg">\{agent\.displayName \|\| agent\.name\}<\/PanelTitle>/);
  assert.match(source, /title=\{`@\$\{agent\.name\}`\}>@\{agent\.name\}<\/div>\s*\{\/\* Live activity has its own line under the handle, so it never squeezes the name\. \*\/\}\s*\{!agent\.deletedAt && \(\s*<div className="mt-1 min-w-0">\s*<AgentStatusBadge agentId=\{agent\.id\}/);
  // #737: the body handle carries the shared size tier (PROFILE_HANDLE_SIZE_CLASS).
  assert.match(source, /className=\{`truncate text-sm \$\{PROFILE_HANDLE_SIZE_CLASS\} text-foreground-placeholder theme-brutal:text-foreground-muted font-mono`\}/);
  assert.match(source, /title=\{`@\$\{agent\.name\}`\}>@\{agent\.name\}<\/div>/);
});

test("activity log status rows contain long error details inside a shrinkable lane", () => {
  const source = read("src/components/agent/AgentActivityLog.tsx");

  assert.match(source, /<span className="min-w-0 flex-1 text-sm text-foreground-strong theme-brutal:text-black">/);
  // The shrinkable lane is the resilience invariant: the secondary detail
  // stays wrapped in `ml-1.5 break-words text-black/60` inside the
  // `min-w-0 flex-1` parent. Inner content now routes through <RefText>
  // (activity ref linkification, task #266) but the lane is unchanged.
  assert.match(
    source,
    /<span className="ml-1\.5 break-words text-foreground-muted theme-brutal:text-black\/60">\s*<RefText text=\{secondary\} \/>\s*<\/span>/,
  );
  assert.match(source, /<div className="min-w-0 flex-1 text-sm">/);
});

test("adjacent identity headers keep names shrinkable and status/action affordances fixed", () => {
  const chatPanel = read("src/components/message/ChatPanel.tsx");
  const machinePanel = [
    read("src/components/machine/MachineDetailPanel.tsx"),
    read("src/components/machine/CommandCopyRoot.tsx"),
    read("src/components/machine/WorkspaceDeleteButton.tsx"),
    read("src/components/machine/BulkResetOptionCard.tsx"),
    read("src/components/machine/MachineAgentRow.tsx"),
  ].join("\n");
  const humanPanel = [
    read("src/components/member/HumanDetailPanel.tsx"),
    read("src/components/member/CreatedAgentRow.tsx"),
  ].join("\n");

  // task #743: the activity text starts at zero width and grows only up to its
  // content (flex-1 max-w-fit), so it yields before the name without the
  // name sharing a proportional shrink — and the status dot stays in the row.
  assert.match(chatPanel, /<Tooltip content=\{activityText\}>\s*<span\s+className="min-w-0 flex-1 max-w-fit truncate text-sm text-foreground-muted font-mono"\s*>/);
  // #737 follow-up (cindyz/gzj 2026-10-10): DM titles use PanelTitle like the
  // channel / thread / profile headers — the same name must read the same in
  // every surface. Update this pin consciously if the markup moves again.
  assert.match(chatPanel, /<Tooltip content=\{displayName\}><PanelTitle render=\{<span className="min-w-0 (?:flex-1 )?truncate" \/>\}>\{displayName\}<\/PanelTitle><\/Tooltip>/);
  assert.match(chatPanel, /title=\{isRegularChannel \? channel\.name : undefined\}/);
  assert.match(
    chatPanel,
    /const channelSubtitle =\s*isRegularChannel\s*\?\s*channel\.description\s*\?\s*<ChannelDescription description=\{channel\.description\} \/>\s*:\s*undefined\s*:\s*undefined;/,
  );
  assert.match(chatPanel, /subtitle=\{channelSubtitle\}/);

  // #737 colour pass: the computer profile name renders through PanelTitle
  // (muted + 600 on the 17 line); brutal keeps 18/700 via the guard.
  assert.match(machinePanel, /<PanelTitle className="min-w-0 text-foreground-muted theme-brutal:text-black theme-brutal:text-lg">\{machine\.name\}<\/PanelTitle>/);
  assert.match(machinePanel, /<div className="truncate text-sm text-foreground-muted theme-brutal:text-black\/50 font-mono">\{machine\.hostname\}<\/div>/);
  assert.match(machinePanel, /<Tooltip content=\{activityText\}><span\s+className="hidden max-w-\[min\(32rem,42vw\)\] truncate align-middle text-xs font-mono text-foreground-muted theme-brutal:text-black\/50 sm:inline-block"\s*>/);

  // #737: human profile name renders through PanelTitle (same spec source as the
  // header title); update consciously.
  const humanNameHeaderIdx = humanPanel.search(
    /<PanelTitle className="min-w-0 text-foreground-muted theme-brutal:text-black theme-brutal:text-lg">\{human\.displayName \|\| human\.name\}<\/PanelTitle>/,
  );
  assert.ok(humanNameHeaderIdx >= 0, "human profile shrinkable name header anchor not found");
  assert.match(humanPanel, /className="inline-flex shrink-0 items-center px-1\.5 py-0\.5 text-\[10px\] font-bold uppercase border border-line-muted theme-brutal:border-black bg-gray-300 text-foreground-muted theme-brutal:text-black\/60"/);
});

test("channel descriptions collapse with the compact fixed-height panel header", () => {
  const description = read("src/components/channel/ChannelDescription.tsx");
  const globalCss = read("src/index.css");

  assert.match(
    globalCss,
    /@media \(max-height: 600px\) \{\s*\[data-slot="app-shell-root"\] \{\s*--shell-header-height:\s*48px;/,
  );
  assert.match(
    description,
    /line-clamp-2[^"\n]*\[@media\(max-height:600px\)\]:line-clamp-1/,
  );
});

test("short-viewport tab-icon hiding stays brutal-scoped (elegant items are icon-only)", () => {
  const mainLayout = read("src/components/layout/MainLayout.tsx");
  // task #707: the stdrc short-viewport adaptation hides tab icons below
  // 600px height. That is safe only in brutal (items keep a text label);
  // elegant items are icon-only (the label is sr-only), so an unscoped rule
  // blanks the entire tab bar.
  assert.match(
    mainLayout,
    /theme-brutal:\[@media\(max-height:600px\)\]:hidden/,
    "tab-icon hiding must carry the theme-brutal scope so elegant keeps its only visible content",
  );
});
