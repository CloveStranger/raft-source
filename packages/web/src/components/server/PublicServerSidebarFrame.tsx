import type { ReactNode } from "react";
import { SidebarRoot } from "raft-ui";

/** Frame shared by the two side columns of the public server page (channels
 *  and settings): the rui SidebarRoot, a header row and a scroll surface.
 *
 *  The class strings mirror the signed-in Sidebar column (root, header, scroll
 *  surface). They are measured against it in a real browser rather than
 *  imported, because importing from Sidebar.tsx would pull the member stores
 *  into the anonymous page. */
export default function PublicServerSidebarFrame({
  title,
  testIdPrefix,
  scrollTestId,
  children,
}: {
  title: string;
  testIdPrefix: string;
  scrollTestId: string;
  children: ReactNode;
}) {
  return (
    <SidebarRoot
      className="relative flex h-full w-full flex-col border-r border-line-muted bg-layer-canvas-muted font-display text-foreground-strong select-none theme-brutal:border-r-2 theme-brutal:border-black theme-brutal:bg-brutal-cream theme-brutal:text-black"
      data-testid={`${testIdPrefix}-root`}
    >
      <div
        className="flex h-panel-header shrink-0 items-center border-b border-line-muted bg-layer-canvas-muted px-5 theme-brutal:border-b-2 theme-brutal:border-black theme-brutal:bg-brutal-cream"
        data-testid={`${testIdPrefix}-header`}
      >
        <h1 className="font-heading truncate text-lg in-data-[theme=elegant]:text-[17px] font-bold text-foreground-strong theme-brutal:text-black">{title}</h1>
      </div>
      <div className="scrollbar-quiet min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 py-3" data-testid={scrollTestId}>
        {children}
      </div>
    </SidebarRoot>
  );
}
