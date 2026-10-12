import { useCallback } from "react";
import { ComposerSuggestionOption } from "raft-ui";

/** Autocomplete suggestion row — owns its per-item select closure so the
    parent map passes only stable references (task #709 react-perf). */
export function AutocompleteOptionRow<T>({
  value,
  flatIndex,
  highlighted,
  className,
  onMouseDown,
  onSelect,
  children,
}: {
  value: T;
  flatIndex: number;
  highlighted: boolean;
  className?: string;
  onMouseDown: (e: React.MouseEvent<HTMLElement>) => void;
  onSelect: (value: T) => void;
  children: React.ReactNode;
}) {
  const handleClick = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <ComposerSuggestionOption
      render={<button type="button" />}
      data-ac-index={flatIndex}
      data-highlighted={highlighted ? "true" : undefined}
      className={className}
      onMouseDown={onMouseDown}
      onClick={handleClick}
    >
      {children}
    </ComposerSuggestionOption>
  );
}
