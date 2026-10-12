import { defaultSchema } from "rehype-sanitize";
import type { Options as RehypeSanitizeOptions } from "rehype-sanitize";

export const ORDERED_LIST_MARKDOWN_ATTRIBUTES = [
  ...(defaultSchema.attributes?.ol || []),
  "start",
];

// Custom URL schemes allowed in rendered markdown link hrefs, on top of
// rehype-sanitize's default allowlist (http/https/mailto/…). Explicit
// per-scheme entries only — adding another scheme is a separate review
// (task #734). Shared by the message-body schema in
// `message/messageMarkdownSecurity.ts` so both sanitize layers agree.
export const MARKDOWN_EXTRA_HREF_PROTOCOLS = ["obsidian"];

export const MARKDOWN_HREF_PROTOCOLS = [
  ...(defaultSchema.protocols?.href || []),
  ...MARKDOWN_EXTRA_HREF_PROTOCOLS,
];

export const markdownSanitizeSchema: RehypeSanitizeOptions = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    ol: ORDERED_LIST_MARKDOWN_ATTRIBUTES,
  },
  protocols: {
    ...defaultSchema.protocols,
    href: MARKDOWN_HREF_PROTOCOLS,
  },
};
