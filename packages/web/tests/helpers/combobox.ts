import { fireEvent } from "@testing-library/react";

/** What a combobox shows: a select trigger's text, or a searchable box's typed/selected text. */
export function comboboxText(element: Element): string {
  return element.tagName === "INPUT" ? (element as HTMLInputElement).value : element.textContent ?? "";
}

/** Opens a combobox. A searchable box opens from the keyboard (jsdom gives Base UI no click-to-open on an input). */
export function openCombobox(element: HTMLElement): void {
  if (element.tagName === "INPUT") {
    fireEvent.focus(element);
    fireEvent.keyDown(element, { key: "ArrowDown" });
    return;
  }
  fireEvent.click(element);
}

/** An option's text without its aria-hidden detail line (the stored id under a model name). */
export function optionText(option: Element): string {
  const copy = option.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent?.trim() ?? "";
}
