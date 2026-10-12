import { useCallback } from "react";
import { useIntl } from "react-intl";
import { Check } from "lucide-react";
import MenuItem from "../ui/MenuItem";
import type { SidebarSortMode } from "./sidebarSort";
import { SIDEBAR_SORT_LABEL_ID } from "./Sidebar";

export function SectionSortModeMenuItem({ mode, checked, onSelect }: {
  mode: SidebarSortMode;
  checked: boolean;
  onSelect: (mode: SidebarSortMode) => void;
}) {
  const { formatMessage } = useIntl();
  const select = useCallback(() => onSelect(mode), [mode, onSelect]);
  return (
    <MenuItem
      role="menuitemradio"
      aria-checked={checked}
      trailing={checked ? <Check size={14} /> : null}
      onClick={select}
    >
      {formatMessage({ id: SIDEBAR_SORT_LABEL_ID[mode] })}
    </MenuItem>
  );
}
