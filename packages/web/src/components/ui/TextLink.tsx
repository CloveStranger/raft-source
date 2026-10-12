import type { ButtonHTMLAttributes } from "react";

/**
 * The inline text-link used for secondary actions across auth and onboarding.
 *
 * Every one of these — Sign In / Create One, Forgot Password, Log out, and the
 * setup gate's Later — is the same control in one of two emphasis variants.
 * Each surface used to hand-roll the className, which is how "Later" ended up
 * as a dashed-underline mono one-off while "Log out" was a plain grey link.
 * Reuse this instead of re-writing the classes.
 *
 * - `primary`: the alternate primary action (Create One / Sign In) — accent
 *   (pink on Brutal), medium weight.
 * - `muted`: a low-key secondary escape hatch (Forgot Password / Log out / Later) — grey.
 *
 * Neither variant is underlined at rest; the underline appears on hover and
 * keyboard focus. Color/weight carry the affordance. A link that sits inside a
 * sentence of the same color (e.g. "Signed in as X. Log out") passes `inline`
 * to keep the underline at rest.
 */
export type TextLinkVariant = "primary" | "muted";

const VARIANT_CLASS: Record<TextLinkVariant, string> = {
  primary: "font-medium text-accent-strong hover:underline focus-visible:underline theme-brutal:text-brutal-pink",
  muted: "text-foreground-muted hover:text-foreground-strong hover:underline focus-visible:underline",
};

export default function TextLink({
  variant = "muted",
  inline = false,
  type = "button",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: TextLinkVariant; inline?: boolean }) {
  return (
    <button
      type={type}
      className={`${VARIANT_CLASS[variant]}${inline ? " underline" : ""} disabled:opacity-50 ${className}`.trim()}
      {...props}
    />
  );
}
