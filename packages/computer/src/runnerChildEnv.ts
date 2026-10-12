import { OS_SUPERVISOR_KIND_ENV_VAR } from "./osSupervisorLifecycle";

export const PARENT_LOCK_HELD_ENV_VAR = "RAFT_COMPUTER_PARENT_MUTATION_LOCK_HELD";
export const SOURCE_SERVICE_PID_ENV_VAR = "RAFT_COMPUTER_SOURCE_SERVICE_PID";

/**
 * Pin the Raft home this service resolved into a child's env. Children
 * (service replacement, per-server daemon, agent `raft` CLI, Stamp/Hands under
 * an agent) must not re-run the default-home rule: with both ~/.slock and
 * ~/.raft holding state they could land on the other directory (task #915).
 * Both names are set because older consumers read only SLOCK_HOME.
 */
export function pinRaftHomeEnv(env: NodeJS.ProcessEnv, raftHome: string): NodeJS.ProcessEnv {
  return { ...env, RAFT_HOME: raftHome, SLOCK_HOME: raftHome };
}

/** Preserve launch/runtime env while stripping service-only ownership state. */
export function buildRunnerChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  raftHome?: string,
): NodeJS.ProcessEnv {
  const {
    [PARENT_LOCK_HELD_ENV_VAR]: _parentLockMarker,
    [SOURCE_SERVICE_PID_ENV_VAR]: _sourceServicePid,
    [OS_SUPERVISOR_KIND_ENV_VAR]: _osSupervisorKind,
    ...childEnv
  } = baseEnv;
  return raftHome === undefined ? childEnv : pinRaftHomeEnv(childEnv, raftHome);
}
