import {
  Combobox,
  ComboboxContent,
  ComboboxControl,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
} from "raft-ui";
import type { ComboboxProps } from "raft-ui";
import { ChevronDown } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { useIntl } from "react-intl";
import StableField from "./StableField";
import type { RuntimeOption } from "./RuntimeConfigFields";

/** Item value of the "use what I typed" row (custom value fields only). */
const CUSTOM_ITEM_PREFIX = "__runtime_form_v2_custom__:";

/**
 * Case-insensitive match on what a person may remember: the name, the stored
 * id, or the group (provider). Each space-separated word must appear somewhere,
 * so "gpt sol" finds "GPT 6.1 Sol".
 */
export function runtimeChoiceMatches(option: RuntimeOption, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const fields = [option.label, option.value, option.group ?? "", option.description ?? ""]
    .map((text) => text.toLowerCase());
  return words.every((word) => fields.some((text) => text.includes(word)));
}

type RuntimeChoiceComboboxProps = {
  options: readonly RuntimeOption[];
  value: string;
  /** `custom` is true when the value is the typed text rather than a listed choice. */
  onValueChange: (next: string, custom: boolean) => void;
  /** The "runtime default" choice of an optional field; stored as "". */
  emptyOption?: RuntimeOption;
  allowCustom: boolean;
  /** The value is one the person typed on purpose (not a listed choice that went away). */
  customValue?: boolean;
  placeholder: string;
  portalContainer?: RefObject<HTMLElement | null>;
  testId: string;
  /** Set by StableField on its adopted control; forwarded to the input, as RuntimeSelectControl does. */
  "data-invalid"?: string;
  "aria-describedby"?: string;
};

/**
 * The runtime form v2 select with a live option list (e.g. models), as a field.
 */
export function RuntimeFormV2ChoiceCombobox({
  common,
  belowControl,
  ...props
}: RuntimeChoiceComboboxProps & {
  common: { label: string; hint?: string; required: boolean; error?: string; labelAccessory?: ReactNode };
  belowControl?: ReactNode;
}) {
  return (
    <StableField {...common} belowControl={belowControl}>
      <RuntimeChoiceCombobox {...props} />
    </StableField>
  );
}

/**
 * A searchable choice control. The stored value is always the option's value
 * (the model id); the label is only what is shown. A stored value that is not
 * in the list stays selected and visible, marked as such. With `allowCustom`, a
 * typed value that matches nothing can be used as is.
 */
export function RuntimeChoiceCombobox({
  options,
  value,
  onValueChange,
  emptyOption,
  allowCustom,
  customValue = false,
  placeholder,
  portalContainer,
  testId,
  "data-invalid": dataInvalid,
  "aria-describedby": ariaDescribedBy,
}: RuntimeChoiceComboboxProps) {
  const { formatMessage } = useIntl();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const controlRef = useRef<HTMLDivElement | null>(null);
  const listed = useMemo(() => options.some((option) => option.value === value), [options, value]);
  const unlisted = value !== "" && !listed;
  const byValue = useMemo(() => {
    const map = new Map<string, RuntimeOption>();
    if (emptyOption) map.set(emptyOption.value, emptyOption);
    for (const option of options) map.set(option.value, option);
    return map;
  }, [options, emptyOption]);
  const notListedLabel = formatMessage({ id: customValue ? "agent.runtimeConfig.custom" : "agent.runtimeFormV2.notInList" });
  const filtered = useMemo(() => {
    const matches = options.filter((option) => runtimeChoiceMatches(option, query));
    return [
      ...(emptyOption && runtimeChoiceMatches(emptyOption, query) ? [emptyOption] : []),
      ...(unlisted && runtimeChoiceMatches({ value, label: value }, query) ? [{ value, label: value, description: notListedLabel }] : []),
      ...matches,
    ];
  }, [options, query, emptyOption, unlisted, value, notListedLabel]);
  const typed = query.trim();
  const offerCustom = allowCustom && typed !== "" && !byValue.has(typed) && typed !== value;
  const items = useMemo(
    () => [...filtered.map((option) => option.value), ...(offerCustom ? [`${CUSTOM_ITEM_PREFIX}${typed}`] : [])],
    [filtered, offerCustom, typed],
  );
  const selectedValue = value === "" ? (emptyOption?.value ?? null) : value;
  const selectedLabel = selectedValue === null ? "" : (byValue.get(selectedValue)?.label ?? selectedValue);
  const itemLabel = useCallback(
    (item: string) => (item.startsWith(CUSTOM_ITEM_PREFIX) ? item.slice(CUSTOM_ITEM_PREFIX.length) : byValue.get(item)?.label ?? item),
    [byValue],
  );
  const handleInputChange: NonNullable<ComboboxProps<string>["onInputValueChange"]> = useCallback((next, details) => {
    // Only typing filters; the combobox also rewrites the input itself (to the
    // selected item's label, or empty), which must not become the query.
    if (details.reason === "input-change" || details.reason === "input-clear") {
      setQuery(next);
      setOpen(true);
    }
  }, []);
  const handleValueChange = useCallback((next: string | null) => {
    setQuery("");
    if (next === null) return;
    if (next.startsWith(CUSTOM_ITEM_PREFIX)) onValueChange(next.slice(CUSTOM_ITEM_PREFIX.length), true);
    else if (emptyOption && next === emptyOption.value) onValueChange("", false);
    // Re-picking a custom value from its own row keeps it custom.
    else onValueChange(next, customValue && next === value && !byValue.has(next));
  }, [onValueChange, emptyOption, customValue, value, byValue]);
  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    setQuery("");
  }, []);
  const portalProps = useMemo(() => (portalContainer ? { container: portalContainer } : undefined), [portalContainer]);
  const groups = useMemo(() => groupOptions(filtered), [filtered]);
  return (
    <>
      <Combobox<string>
        autoHighlight
        items={items}
        value={selectedValue}
        itemToStringLabel={itemLabel}
        filter={null}
        onInputValueChange={handleInputChange}
        onValueChange={handleValueChange}
        open={open}
        onOpenChange={handleOpenChange}
        // Typing shows the query; otherwise the field reads as the selected choice.
        inputValue={open ? query : selectedLabel}
      >
        {/* Field metrics like the select fields beside it (RuntimeSelectControl's chrome="field"). */}
        <ComboboxControl ref={controlRef} className="w-full px-3 py-2">
          <ComboboxInput
            className="text-field font-field"
            placeholder={open && selectedLabel ? selectedLabel : placeholder}
            data-testid={testId}
            data-invalid={dataInvalid}
            aria-describedby={ariaDescribedBy}
            suppressPasswordManager
          />
          <ChevronDown aria-hidden />
        </ComboboxControl>
        {/* The popup is as wide as the whole field, not just its text input. */}
        <ComboboxContent align="start" anchor={controlRef} className="w-(--anchor-width)" portalProps={portalProps}>
          <ComboboxList>
            {groups.map((group) => group.label ? (
              <ComboboxGroup key={group.label}>
                <ComboboxGroupLabel>{group.label}</ComboboxGroupLabel>
                {group.options.map(renderOption)}
              </ComboboxGroup>
            ) : group.options.map(renderOption))}
            {offerCustom && (
              <ComboboxItem key="custom" value={`${CUSTOM_ITEM_PREFIX}${typed}`} data-testid={`${testId}-use-custom`}>
                <span className="truncate">{formatMessage({ id: "agent.runtimeFormV2.useCustomValue" }, { value: typed })}</span>
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty>{formatMessage({ id: "ui.selectionPopover.emptyLabel" })}</ComboboxEmpty>
        </ComboboxContent>
      </Combobox>
      {unlisted && !customValue && (
        <p className="mt-1 text-xs text-foreground-muted" data-testid={`${testId}-unlisted`}>
          {formatMessage({ id: "agent.runtimeFormV2.savedValueNotInList" }, { value })}
        </p>
      )}
    </>
  );
}

function renderOption(option: RuntimeOption) {
  const id = option.label !== option.value ? option.value : null;
  return (
    <ComboboxItem key={option.value} value={option.value} disabled={option.disabled}>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{option.label}</span>
        {/* A description (e.g. "Not in the current list") is part of the
            option's name; the id line is visual help only. */}
        {option.description
          ? <span className="truncate text-xs text-foreground-muted">{option.description}</span>
          : id && <span aria-hidden className="truncate text-xs text-foreground-muted">{id}</span>}
      </span>
      <ComboboxItemIndicator />
    </ComboboxItem>
  );
}

function groupOptions(options: readonly RuntimeOption[]): Array<{ label: string; options: RuntimeOption[] }> {
  const groups: Array<{ label: string; options: RuntimeOption[] }> = [];
  for (const option of options) {
    const label = option.group ?? "";
    const tail = groups.at(-1);
    if (!tail || tail.label !== label) groups.push({ label, options: [option] });
    else tail.options.push(option);
  }
  return groups;
}
