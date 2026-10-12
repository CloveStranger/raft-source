import { useMemo } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useIntl } from "react-intl";
import { ArrowUpDown } from "lucide-react";
import Tooltip from "../ui/Tooltip";
import SelectionPopover from "../ui/SelectionPopover";
import type { SidebarSortMode } from "./sidebarSort";
import {
  SIDEBAR_SECTION_ICON_BUTTON_CLASS,
  SIDEBAR_SORT_LABEL_ID,
  SIDEBAR_SORT_MODES,
} from "./Sidebar";
import type { SidebarSortSection } from "./Sidebar";

export function SidebarSortMenu({
  section,
  value,
  onChange,
  open,
  setOpenSortMenu,
  menuRef,
}: {
  section: SidebarSortSection;
  value: SidebarSortMode;
  onChange: (value: SidebarSortMode) => void;
  open: boolean;
  setOpenSortMenu: Dispatch<SetStateAction<SidebarSortSection | null>>;
  menuRef: RefObject<HTMLDivElement | null>;
}) {
  const { formatMessage } = useIntl();
  const options = useMemo(() => SIDEBAR_SORT_MODES.map((mode) => ({
    key: mode,
    checked: mode === value,
    label: formatMessage({ id: SIDEBAR_SORT_LABEL_ID[mode] }),
    onClick: () => {
      onChange(mode);
      setOpenSortMenu(null);
    },
  })), [formatMessage, onChange, setOpenSortMenu, value]);
  // Sidebar sort = single-select dropdown — delegated to SelectionPopover
  // so the ✓ position (right) and hover token (`bg-soft-signal/30`)
  // match the rest of the Selection family. stdrc 2026-05-25
  // #proj-theme:ac79cf20 msg=8fdf9cba + msg=b0b92c1c. Removes the older
  // hand-rolled `<button role="menuitemradio">` rows that put ✓ on the
  // left and used full-saturation `bg-soft-signal` for both hover and
  // selected fill (Linear/Notion/GitHub/Figma all put ✓ on the right
  // for single-select dropdowns).
  return (
    <div ref={open ? menuRef : undefined} className="relative shrink-0">
      <Tooltip content={formatMessage(
          { id: "layout.sidebar.sortTitle" },
          { currentLabel: formatMessage({ id: SIDEBAR_SORT_LABEL_ID[value] }) },
        )}>
      <button
        type="button"
        aria-label={formatMessage({ id: "layout.sidebar.sortAria" })}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="sidebar-sort-menu-button"
        data-sort-section={section}
        onClick={(event) => {
          event.stopPropagation();
          setOpenSortMenu((current) => (current === section ? null : section));
        }}
        className={SIDEBAR_SECTION_ICON_BUTTON_CLASS}
      >
        <ArrowUpDown size={14} />
      </button>
      </Tooltip>
      {open && (
        <SelectionPopover
          title={formatMessage({ id: "layout.sidebar.sortMenuTitle" })}
          showHeader={false}
          className="absolute right-0 top-8 z-50 min-w-[136px] overflow-hidden border border-line-muted bg-layer-panel shadow-raft-sm theme-brutal:border-2 theme-brutal:border-black theme-brutal:bg-white theme-brutal:shadow-brutal"
          options={options}
        />
      )}
    </div>
  );
}
