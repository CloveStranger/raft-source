// Where the Raft home lives: the one directory that holds a machine's Raft
// state (Computer, daemon, agent workspaces, CLI profiles and ledgers).
//
// ONE rule, used by every process that resolves the home on its own (daemon,
// Computer, CLI, SDK, the npm shim; the native installer mirrors it), so they
// can never pick two different directories on the same machine:
//
//   1. $RAFT_HOME, else $SLOCK_HOME, when set.
//   2. ~/.slock when it already holds Raft state (any of
//      LEGACY_RAFT_HOME_STATE_ENTRIES). Machines set up before the rename keep
//      it forever: agent workspaces live under it and the server stores those
//      workspace paths, so nothing is moved or migrated.
//   3. ~/.raft otherwise (new machines). A ~/.slock without Raft state does
//      not count: old npm shims and CLIs create one just for a notice file,
//      and following it would strand a new machine's ~/.raft.
//
// When both directories hold state the rule still answers ~/.slock, but that
// can be the wrong one (a ~/.raft machine where an older ~/.slock-only
// program later wrote state). `raft-computer start` refuses and `doctor`
// reports it (defaultRaftHomesConflict); a running service passes its own
// home down to every child via RAFT_HOME + SLOCK_HOME so nothing below it
// re-runs this rule.
//
// Pure values and string functions only (this package also runs in
// browsers); callers probe the filesystem and join the path.
export const RAFT_HOME_ENVS = ["RAFT_HOME", "SLOCK_HOME"] as const;
export const RAFT_HOME_DIRNAME = ".raft";
export const LEGACY_RAFT_HOME_DIRNAME = ".slock";
// Entries that only a machine actually using ~/.slock has: agent workspaces,
// Computer state, daemon machine state, CLI profiles and agent ledgers.
export const LEGACY_RAFT_HOME_STATE_ENTRIES = ["agents", "computer", "machines", "profiles", "agent-state"] as const;

type Env = Record<string, string | undefined>;

/** The Raft home the environment configures, or undefined when the default applies. */
export function configuredRaftHome(env: Env): string | undefined {
  for (const name of RAFT_HOME_ENVS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * The default Raft home's directory name under the user's home directory.
 * `exists` answers whether a path, relative to that home directory and
 * written with `/`, exists there.
 */
export function defaultRaftHomeDirname(exists: (relativePath: string) => boolean): string {
  return holdsRaftState(LEGACY_RAFT_HOME_DIRNAME, exists) ? LEGACY_RAFT_HOME_DIRNAME : RAFT_HOME_DIRNAME;
}

/**
 * True when BOTH default directories hold Raft state, so the default rule's
 * answer (~/.slock) may not be the directory this machine's Computer actually
 * runs from. Whichever directory was in use first, picking by contents can
 * move it to the other one and strand its agent workspaces, so callers that
 * start a Computer must not guess here: they refuse and ask for RAFT_HOME
 * (task #915). Only meaningful when no RAFT_HOME / SLOCK_HOME is configured.
 */
export function defaultRaftHomesConflict(exists: (relativePath: string) => boolean): boolean {
  return holdsRaftState(LEGACY_RAFT_HOME_DIRNAME, exists) && holdsRaftState(RAFT_HOME_DIRNAME, exists);
}

function holdsRaftState(dirname: string, exists: (relativePath: string) => boolean): boolean {
  return LEGACY_RAFT_HOME_STATE_ENTRIES.some((entry) => exists(`${dirname}/${entry}`));
}

/** True for both default home directory names, for code that must recognise either. */
export function isDefaultRaftHomeDirname(name: string): boolean {
  return name === RAFT_HOME_DIRNAME || name === LEGACY_RAFT_HOME_DIRNAME;
}
