import { useCallback } from "react";
import { useThreadStore } from "../../store/threadStore";
import ThreadPanel from "../message/ThreadPanel";

export function ContentSlotThreadPanel({ closeSlot }: { closeSlot: () => void }) {
  const handleClose = useCallback(() => {
    useThreadStore.getState().closeThread();
    closeSlot();
  }, [closeSlot]);
  return <ThreadPanel presentation="side" onClose={handleClose} />;
}
