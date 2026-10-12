import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL(".", import.meta.url));
const copyKeys = ["feedback.native.diagnostics.edit", "feedback.native.diagnostics.rejected", "feedback.native.diagnostics.unavailable", "feedback.native.diagnosticsTitle", "feedback.native.diagnostics.preparing", "feedback.native.diagnostics.uploading", "feedback.native.diagnostics.submitting", "feedback.native.diagnostics.failed", "feedback.native.diagnostics.skip", "feedback.native.diagnostics.retry", "feedback.native.diagnostics.omit", "feedback.native.hostRequired", "feedback.native.authRequired", "feedback.native.authRestored", "settings.about.feedbackTitle", "settings.about.feedbackAttachmentOpenError", "common.lightbox.close"];
const copy = Object.fromEntries(["en", "zh-cn"].map(locale => {
  const source = readFileSync(resolve(root, `src/i18n/messages/${locale}.ts`), "utf8");
  const entries = Object.fromEntries(copyKeys.map(key => {
    const line = source.split("\n").find(line => line.trimStart().startsWith(`${JSON.stringify(key)}:`));
    if (!line) throw new Error(`Missing feedback copy ${locale}/${key}`);
    return [key, JSON.parse(line.trim().slice(JSON.stringify(key).length + 1).trim().replace(/,$/, ""))];
  }));
  return [locale === "zh-cn" ? "zh-CN" : "en", entries];
}));
export default defineConfig({
  define: { __RAFT_FEEDBACK_COPY__: JSON.stringify(copy) },
  root: resolve(root, "feedback"),
  publicDir: false,
  envDir: root,
  base: "/feedback/",
  resolve: { alias: { "/src": resolve(root, "src") } },
  plugins: [react(), {
    name: "feedback-entry-boundary",
    generateBundle() {
      const forbidden = [...this.getModuleIds()].filter(id => id.startsWith(resolve(root, "src") + "/") && !id.startsWith(resolve(root, "src/feedback") + "/"));
      if (forbidden.length) this.error(`Standalone feedback imported application startup: ${forbidden.join(", ")}`);
    },
    writeBundle() {
      const directory = resolve(root, "dist/feedback/assets");
      const sizes = { js: 0, css: 0 };
      for (const name of readdirSync(directory)) {
        if (name.endsWith(".js")) sizes.js += statSync(resolve(directory, name)).size;
        if (name.endsWith(".css")) sizes.css += statSync(resolve(directory, name)).size;
      }
      if (sizes.js > 1_000_000 || sizes.css > 750_000) this.error(`Feedback entry size budget exceeded: ${JSON.stringify(sizes)}`);
    },
  }],
  build: { outDir: resolve(root, "dist/feedback"), emptyOutDir: true, manifest: true, rolldownOptions: { input: resolve(root, "feedback/index.html") } },
});
