import { create } from "zustand";

interface UIState {
  sidebarOpen: boolean;
  threadMaximized: boolean;
  toggleThreadMaximized: () => void;
  restoreThreadLayout: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: false,
  threadMaximized: false,
  toggleThreadMaximized: () => set((s) => ({ threadMaximized: !s.threadMaximized })),
  restoreThreadLayout: () => set({ threadMaximized: false }),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
}));

/** Shared layout/read contract; only a matching open conversation can be hidden. */
export function isThreadMaximized(
  maximized: boolean,
  parentMessageId: string | null,
  parentChannelId: string | null,
  currentChannelId: string | null,
  profileOpen = false,
): boolean {
  return maximized && !profileOpen && !!parentMessageId && !!parentChannelId && parentChannelId === currentChannelId;
}
