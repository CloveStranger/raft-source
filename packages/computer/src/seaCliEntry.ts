/**
 * SEA entry for the hidden `__cli` mode (every agent `raft` call).
 *
 * The SEA build bundles this file on its own and embeds it as a separate
 * asset beside the Computer bundle. The SEA's tiny loader evaluates only this
 * asset when argv[2] is `__cli`, so an agent call never parses or evaluates
 * the Computer/daemon bundle. Outside a SEA, `index.ts` handles `__cli`.
 */
import { runBundledRaftCli } from "@botiverse/raft-daemon/bundled-cli";

void runBundledRaftCli(process.argv.slice(3));
