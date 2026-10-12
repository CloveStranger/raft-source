import { useId } from "react";
import type { ChangeEventHandler } from "react";
import { useIntl } from "react-intl";
import { Input } from "raft-ui";
import FormField from "../ui/FormField";
import { APP_WHEN_TO_USE_MAX_CODE_POINTS, countAppWhenToUseCharacters, isAppWhenToUseTooLong } from "@botiverse/raft-shared";

export function AppWhenToUseField({ value, onChange }: { value: string; onChange: ChangeEventHandler<HTMLInputElement> }) {
  const { formatMessage } = useIntl();
  const id = useId();
  const count = countAppWhenToUseCharacters(value);
  const invalid = isAppWhenToUseTooLong(value);
  const limit = APP_WHEN_TO_USE_MAX_CODE_POINTS;
  return (
    <FormField label={formatMessage({ id: "settings.connectedApps.whenToUseLabel" })} labelStyle="plain" size="compact" hint={formatMessage({ id: "settings.connectedApps.whenToUseHint" })} error={invalid ? formatMessage({ id: "settings.connectedApps.whenToUseTooLong" }, { limit }) : undefined} optional>
      <Input type="text" value={value} onChange={onChange} className="w-full text-sm"
        aria-invalid={invalid} aria-describedby={`${id}-count`}
        placeholder={formatMessage({ id: "settings.connectedApps.whenToUsePlaceholder" })} />
      <div id={`${id}-count`} className="mt-1 text-xs text-foreground-muted" aria-live="polite">
        {formatMessage({ id: "settings.connectedApps.whenToUseCount" }, { count, limit })}
      </div>

    </FormField>
  );
}
