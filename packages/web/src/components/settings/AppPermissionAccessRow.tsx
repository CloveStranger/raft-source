import { useCallback, useMemo } from "react";
import { useIntl } from "react-intl";
import type { AppNotificationGroup } from "@botiverse/raft-shared";
import { Select, SelectContent, SelectIcon, SelectItem, SelectItemIndicator, SelectItemText, SelectList, SelectTrigger, SelectValue, TableCell, TableRow } from "raft-ui";
import { APP_NOTIFICATION_GROUP_META, permissionGroupLabel, toggleAppNotificationGroup } from "./AppNotificationsControls";
import type { AppNotificationSelection } from "./AppNotificationsControls";

/** One resource row of the developer app-permissions table. It owns its access
    options and change handler so the table passes only stable references
    (task #709 react-perf). */
export function AppPermissionAccessRow({
  group,
  value,
  disabled,
  onChange,
}: {
  group: AppNotificationGroup;
  value: AppNotificationSelection;
  disabled: boolean;
  onChange: (next: AppNotificationSelection) => void;
}) {
  const { formatMessage } = useIntl();
  const selected = value.groups.includes(group);
  const accessOptions = useMemo(() => [
    { value: "none", label: formatMessage({ id: "settings.connectedApps.appPermissions.none" }) },
    { value: "enabled", label: formatMessage({ id: group === "agent_reminder_write" ? "settings.connectedApps.appPermissions.write" : "settings.connectedApps.appPermissions.read" }) },
  ], [formatMessage, group]);
  const handleValueChange = useCallback((access: string | null) => {
    if (access === null) return;
    onChange(toggleAppNotificationGroup(value, group, access === "enabled"));
  }, [group, onChange, value]);
  return (
    <TableRow>
      <TableCell>
        <div className="font-bold text-foreground-strong">{formatMessage({ id: APP_NOTIFICATION_GROUP_META[group].labelId })}</div>
        <div className="mt-1 text-[11px] text-foreground-muted">{formatMessage({ id: APP_NOTIFICATION_GROUP_META[group].summaryId })}</div>
      </TableCell>
      <TableCell className="align-middle">
        <Select
          items={accessOptions}
          value={selected ? "enabled" : "none"}
          disabled={disabled}
          onValueChange={handleValueChange}
        >
          <SelectTrigger aria-label={permissionGroupLabel(group, formatMessage)} className="w-full text-xs">
            <SelectValue />
            <SelectIcon />
          </SelectTrigger>
          <SelectContent>
            <SelectList>
              {accessOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  <SelectItemText>{option.label}</SelectItemText>
                  <SelectItemIndicator />
                </SelectItem>
              ))}
            </SelectList>
          </SelectContent>
        </Select>
      </TableCell>
    </TableRow>
  );
}
