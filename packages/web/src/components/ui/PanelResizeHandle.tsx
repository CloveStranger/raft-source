import type { HTMLAttributes } from "react";

const SIDE_CLASS = {
  left: "-left-1",
  right: "-right-1",
} as const;

// Tailwind only sees literal class names, so the breakpoint is a lookup rather
// than an interpolated prefix.
const VISIBLE_FROM_CLASS = {
  sm: "sm:block",
  md: "md:block",
} as const;

export interface PanelResizeHandleProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** Which edge of the positioned panel the handle straddles. */
  side: keyof typeof SIDE_CLASS;
  /** Breakpoint from which panels sit side by side; the handle is hidden below it. */
  visibleFrom: keyof typeof VISIBLE_FROM_CLASS;
}

/** Drag handle on the divider between two panels: an 8px grab strip centred on
 *  the panel edge, with a hairline that darkens on hover. The parent must be
 *  positioned and must not clip its own edge. Pointer handlers, test ids and
 *  any extra classes pass straight through. */
export default function PanelResizeHandle({ side, visibleFrom, className = "", ...props }: PanelResizeHandleProps) {
  return (
    <div
      {...props}
      className={`group absolute ${SIDE_CLASS[side]} top-0 bottom-0 z-20 hidden w-2 cursor-col-resize touch-none select-none ${VISIBLE_FROM_CLASS[visibleFrom]} ${className}`.trim()}
    >
      <span className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px -translate-x-1/2 bg-foreground/25 group-hover:bg-foreground theme-brutal:bg-black/25 theme-brutal:group-hover:bg-black" />
    </div>
  );
}
