/**
 * Run the bundled `slock` CLI in-process with `argv` as its arguments.
 *
 * The busybox/self-re-exec answer to "how does an agent call `slock` on a SEA
 * single-binary Computer". A SEA binary can't spawn `node <cli-script>` (no
 * node, no sidecar script), so instead the SEA binary re-execs itself in a CLI
 * mode (`<exe> __cli <args>`) and this runs the CLI it bundled. The CLI entry
 * runs `program.parseAsync(process.argv)` on import, so we rewrite argv to look
 * like a normal `slock <args>` invocation and then load it. A fresh process is
 * spawned per agent `slock` call (the cliTransport wrapper execs `<exe> __cli`),
 * so there is no module-cache reuse concern. Importing the entry here also pulls
 * the CLI into the SEA bundle's import graph (it is otherwise only referenced by
 * path via `resolveRaftCliPath` and would not be embedded).
 *
 * This lives in its own module (exported as `@botiverse/raft-daemon/bundled-cli`)
 * so the `__cli` path loads only the CLI. Reaching it through
 * `@botiverse/raft-daemon/core` evaluated the whole daemon graph first, which
 * roughly doubled every agent `raft` call's memory and startup time.
 */
export async function runBundledRaftCli(argv: string[]): Promise<void> {
  process.argv = [process.execPath, "slock", ...argv];
  // Static specifier (so esbuild embeds the CLI into the SEA bundle), but the
  // CLI dist ships no .d.ts beside index.js → TS7016. It is a side-effecting
  // "run the CLI" import, not a typed module.
  // @ts-expect-error - untyped CLI entry; importing it runs program.parseAsync.
  await import("@botiverse/raft/dist/index.js");
}
