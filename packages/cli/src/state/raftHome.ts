// The Raft home as the CLI sees it: $RAFT_HOME, else $SLOCK_HOME, else
// ~/.slock when it already holds Raft state, else ~/.raft. The rule lives in
// @botiverse/raft-shared (raftHome.ts) so the CLI, daemon and Computer can
// never pick different directories; every CLI path under the home starts here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { configuredRaftHome, defaultRaftHomeDirname } from "@botiverse/raft-shared";

export function resolveRaftHome(env: NodeJS.ProcessEnv = process.env, homeDir?: string): string {
  const configured = configuredRaftHome(env);
  if (configured) return configured;
  const home = homeDir || env.HOME || os.homedir();
  return path.join(home, defaultRaftHomeDirname((name) => fs.existsSync(path.join(home, name))));
}
