import { useCallback } from "react";
import { ChannelMemberRemoveButton } from "./ChannelMemberList";

/** Per-row remove control: binds the row's id so the list passes one stable callback. */
export function CandidateRemoveButton({
  id,
  label,
  onRemove,
}: {
  id: string;
  label: string;
  onRemove: (id: string) => void;
}) {
  const handleClick = useCallback(() => onRemove(id), [onRemove, id]);
  return <ChannelMemberRemoveButton label={label} onClick={handleClick} />;
}
