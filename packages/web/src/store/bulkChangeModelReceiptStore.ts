import { create } from "zustand";
import type { BulkModelTarget, BulkUnfinishedPhase } from "../components/machine/bulkChangeModelPlan";

/**
 * Result of the last bulk "Change model" run per Computer (task #1287).
 *
 * Client-session scope only, by contract: it survives navigating away and back
 * (an unresolved failure banner must still be there, static), but not a reload,
 * and it is not synced across devices. Nothing here promises background
 * completion: the requests already ran in the page that started them.
 *
 * Timing (designs task #1285): success banner 5 s, changed-row highlight 3 s.
 * Both are one-shot: they are stored as absolute deadlines, so remounting after
 * the deadline shows nothing instead of replaying the animation.
 */

export const BULK_SUCCESS_BANNER_MS = 5_000;
export const BULK_ROW_HIGHLIGHT_MS = 3_000;

export interface BulkUnfinishedAgent {
  agentId: string;
  phase: BulkUnfinishedPhase;
}

export type BulkChangeReceipt =
  | {
      kind: "success";
      target: BulkModelTarget;
      changedAgentIds: string[];
      skippedAgentIds: string[];
      bannerUntil: number;
    }
  | {
      kind: "partial";
      target: BulkModelTarget;
      total: number;
      unfinished: BulkUnfinishedAgent[];
    };

interface BulkChangeModelReceiptState {
  receipts: Record<string, BulkChangeReceipt | undefined>;
  highlights: Record<string, { agentIds: string[]; until: number } | undefined>;
  record: (machineId: string, receipt: BulkChangeReceipt, highlightedAgentIds: string[], now: number) => void;
  clear: (machineId: string) => void;
}

export const useBulkChangeModelReceiptStore = create<BulkChangeModelReceiptState>((set) => ({
  receipts: {},
  highlights: {},
  record: (machineId, receipt, highlightedAgentIds, now) => set((state) => ({
    receipts: { ...state.receipts, [machineId]: receipt },
    highlights: {
      ...state.highlights,
      [machineId]: highlightedAgentIds.length > 0
        ? { agentIds: highlightedAgentIds, until: now + BULK_ROW_HIGHLIGHT_MS }
        : undefined,
    },
  })),
  clear: (machineId) => set((state) => ({
    receipts: { ...state.receipts, [machineId]: undefined },
  })),
}));
