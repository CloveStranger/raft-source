import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { logger } from "../logger";
import type { RuntimeProbeUnavailableReason } from "./types";
import { createWindowsPowerShellChildEnv } from "./windowsPowerShellEnv";

export interface ProbeDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  execIsElectron?: boolean;
  /** Optional authoritative SEA classification for the current executable. */
  execIsSea?: boolean;
  /** Optional authoritative Node-capability classification for the current executable. */
  hasNodeRuntime?: boolean;
  cwd?: string;
  homeDir?: string;
  warn?: (message: string) => void;
  existsSyncFn?: (filePath: string) => boolean;
  /** Optional fs.statSync stand-in (mtime/size probe cache keys). */
  statSyncFn?: (filePath: string) => { mtimeMs: number; size: number };
  execFileSyncFn?: typeof execFileSync;
  /** Optional fs.readFileSync stand-in (Windows batch wrapper parsing). */
  readFileSyncFn?: (filePath: string, encoding: "utf8") => string;
  windowsEnvironmentReaderFn?: WindowsEnvironmentReader;
}

export interface WindowsEnvironmentScopes {
  machine?: NodeJS.ProcessEnv;
  user?: NodeJS.ProcessEnv;
}

export type WindowsEnvironmentReader = (
  env: NodeJS.ProcessEnv,
  execFileSyncFn: typeof execFileSync,
  warn?: (message: string) => void,
) => WindowsEnvironmentScopes | null;

function normalizeExecOutput(raw: unknown): string {
  return Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw ?? "");
}

const WINDOWS_ENVIRONMENT_SCRIPT = [
  "& {",
  "  $result = [ordered]@{}",
  "  foreach ($scope in @('Machine', 'User')) {",
  "    $scopeEnv = [Environment]::GetEnvironmentVariables($scope)",
  "    $scopeObj = [ordered]@{}",
  "    foreach ($key in $scopeEnv.Keys) {",
  "      $value = $scopeEnv[$key]",
  "      if ($null -ne $value) { $scopeObj[$key] = [string]$value }",
  "    }",
  "    $result[$scope] = $scopeObj",
  "  }",
  "  $result | ConvertTo-Json -Compress -Depth 3",
  "}",
].join("\n");

const WINDOWS_ENVIRONMENT_ERROR_SUMMARY_MAX_LENGTH = 240;

function summarizeWindowsEnvironmentError(error: unknown): string {
  const details = error as {
    code?: unknown;
    signal?: unknown;
    status?: unknown;
    stderr?: unknown;
  };
  const exit = typeof details?.status === "number" ? String(details.status) : "unknown";
  const code = typeof details?.code === "string" ? details.code : "unknown";
  const signal = typeof details?.signal === "string" ? details.signal : "none";
  const stderr = normalizeExecOutput(details?.stderr).trim().replace(/\s+/g, " ");
  const fallback = error instanceof Error ? error.message.trim().replace(/\s+/g, " ") : String(error);
  const rawSummary = stderr || fallback || "no child error detail";
  const summary = rawSummary.length > WINDOWS_ENVIRONMENT_ERROR_SUMMARY_MAX_LENGTH
    ? `${rawSummary.slice(0, WINDOWS_ENVIRONMENT_ERROR_SUMMARY_MAX_LENGTH - 3)}...`
    : rawSummary;
  return `[Daemon] Windows environment refresh failed (exit=${exit}, code=${code}, signal=${signal}): ${summary}`;
}

// Each runtime is probed again on reconnect/config refresh, so a slow lookup
// fails this inventory pass without becoming a cached permanent miss. The
// budget covers powershell.exe process start plus Get-Command; a lookup that
// exceeds it is reported as `probe_timeout`, never as `not_installed`
// (task #1240).
export const WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS = 1000;

function normalizeProcessEnv(value: unknown): NodeJS.ProcessEnv {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const env: NodeJS.ProcessEnv = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (rawValue !== undefined && rawValue !== null) {
      env[key] = String(rawValue);
    }
  }
  return env;
}

function readWindowsMachineUserEnvironment(
  env: NodeJS.ProcessEnv,
  execFileSyncFn: typeof execFileSync,
  warn?: (message: string) => void,
): WindowsEnvironmentScopes | null {
  try {
    const output = normalizeExecOutput(execFileSyncFn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_ENVIRONMENT_SCRIPT,
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      env: createWindowsPowerShellChildEnv(env),
      timeout: 5000,
    }));
    const parsed = JSON.parse(output || "{}") as { Machine?: unknown; User?: unknown };
    return {
      machine: normalizeProcessEnv(parsed.Machine),
      user: normalizeProcessEnv(parsed.User),
    };
  } catch (error) {
    warn?.(summarizeWindowsEnvironmentError(error));
    return null;
  }
}

function findEnvKey(env: NodeJS.ProcessEnv | undefined, name: string): string | null {
  if (!env) return null;
  const lowerName = name.toLowerCase();
  const keys = Object.keys(env);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index]!;
    if (key.toLowerCase() === lowerName) return key;
  }
  return null;
}

function getEnvValue(env: NodeJS.ProcessEnv | undefined, name: string): string | undefined {
  const key = findEnvKey(env, name);
  return key ? env?.[key] : undefined;
}

function setEnvValue(env: NodeJS.ProcessEnv, key: string, value: string): void {
  const existingKey = findEnvKey(env, key);
  if (existingKey && existingKey !== key) {
    delete env[existingKey];
  }
  env[key] = value;
}

function mergeWindowsPathSegments(values: Array<string | undefined>): string | undefined {
  const segments: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const rawSegment of value.split(";")) {
      const segment = rawSegment.trim();
      if (!segment) continue;
      const key = segment.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      segments.push(segment);
    }
  }
  return segments.length > 0 ? segments.join(";") : undefined;
}

function mergeWindowsEnvironmentScopes(
  baseEnv: NodeJS.ProcessEnv,
  scopes: WindowsEnvironmentScopes,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  const layers = [scopes.machine ?? {}, scopes.user ?? {}, baseEnv];

  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (value === undefined || key.toLowerCase() === "path") continue;
      setEnvValue(merged, key, value);
    }
  }

  const pathKey = findEnvKey(baseEnv, "Path")
    ?? findEnvKey(scopes.machine, "Path")
    ?? findEnvKey(scopes.user, "Path")
    ?? "Path";
  // Keep daemon/agent overrides first, then append Machine/User PATH entries
  // that a long-lived daemon process may not have inherited yet.
  const pathValue = mergeWindowsPathSegments([
    getEnvValue(baseEnv, "Path"),
    getEnvValue(scopes.machine, "Path"),
    getEnvValue(scopes.user, "Path"),
  ]);
  if (pathValue) {
    merged[pathKey] = pathValue;
  }

  return merged;
}

export function withWindowsUserEnvironment(env: NodeJS.ProcessEnv, deps: ProbeDeps = {}): NodeJS.ProcessEnv {
  const platform = deps.platform ?? process.platform;
  if (platform !== "win32") return env;

  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  const reader = deps.windowsEnvironmentReaderFn ?? readWindowsMachineUserEnvironment;
  const warn = deps.warn ?? ((message: string) => logger.warn(message));
  const scopes = reader(env, execFileSyncFn, warn);
  if (!scopes) return env;

  return mergeWindowsEnvironmentScopes(env, scopes);
}

function resolveCommandOnWindows(
  command: string,
  env: NodeJS.ProcessEnv,
  execFileSyncFn: typeof execFileSync,
  existsSyncFn: (filePath: string) => boolean,
): CommandLookup {
  // Only a CommandNotFoundException means "not on PATH"; it exits with a
  // reserved code. Any other failure of the lookup exits 1 (PowerShell's
  // default for an uncaught error) and is not evidence that the command is
  // absent.
  const script =
    "& {try { $cmd = Get-Command -Name $args[0] -ErrorAction Stop | Select-Object -First 1 } " +
    `catch [System.Management.Automation.CommandNotFoundException] { exit ${WINDOWS_LOOKUP_NOT_FOUND_EXIT} }; ` +
    "if ($cmd.Path) { $cmd.Path } " +
    "elseif ($cmd.Source) { $cmd.Source } " +
    "elseif ($cmd.Definition) { $cmd.Definition } }";

  try {
    const output = normalizeExecOutput(execFileSyncFn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
      command,
    ], {
      stdio: ["ignore", "pipe", "ignore"],
      env: createWindowsPowerShellChildEnv(env),
      timeout: WINDOWS_COMMAND_RESOLVE_TIMEOUT_MS,
    }));
    const resolved = output.trim().split(/\r?\n/)[0];
    // Found but with no usable path, or a lookup that printed nothing: not a miss.
    if (!resolved) return { command: null, missReason: "probe_failed" };

    // PowerShell Get-Command prefers .ps1, but cmd.exe cannot execute .ps1
    // (it opens Notepad or hangs). Prefer .cmd > .bat > .exe / extensionless
    // in the same directory.
    const lowerResolved = resolved.toLowerCase();
    if (lowerResolved.endsWith(".ps1")) {
      const dir = path.dirname(resolved);
      const base = path.basename(resolved, ".ps1");
      const alternatives = [
        path.join(dir, `${base}.cmd`),
        path.join(dir, `${base}.bat`),
        path.join(dir, `${base}.exe`),
        path.join(dir, base),
      ];
      for (const alt of alternatives) {
        if (existsSyncFn(alt)) return { command: alt };
      }
      // Found, but only as a PowerShell script cmd.exe cannot run.
      return { command: null, missReason: "probe_failed" };
    }

    return { command: resolved };
  } catch (error) {
    return { command: null, missReason: classifyCommandLookupFailure(error, WINDOWS_LOOKUP_NOT_FOUND_EXIT) };
  }
}

/**
 * Result of looking a command up on PATH. `missReason` is set only when
 * `command` is null: "not_installed" means the lookup itself ran and reported
 * the command absent; any other reason means the lookup could not decide
 * (timed out, locator missing, ...), so the caller must not treat it as absent.
 */
export interface CommandLookup {
  command: string | null;
  missReason?: RuntimeProbeUnavailableReason;
}

/** Exit code the Windows lookup script reserves for "Get-Command found nothing". */
const WINDOWS_LOOKUP_NOT_FOUND_EXIT = 3;
/** `which` (debianutils, GNU, BusyBox, macOS) exits 1 when a command is not found; 2+ is a usage/internal error. */
const POSIX_WHICH_NOT_FOUND_EXIT = 1;

function classifyCommandLookupFailure(error: unknown, notFoundExit: number): RuntimeProbeUnavailableReason {
  // Only the locator's own "not found" status means absent. Any other exit
  // status (the locator failed) or a spawn error (timeout, missing locator,
  // EACCES) cannot tell us the command is missing.
  const status = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  if (status === notFoundExit) return "not_installed";
  return classifyProbeExecFailure(error);
}

const POSIX_USER_BIN_DIRS = [[".local", "bin"], [".kimi-code", "bin"]] as const;

export function resolveCommandOnPath(command: string, deps: ProbeDeps = {}): string | null {
  return lookupCommandOnPath(command, deps).command;
}

/** {@link resolveCommandOnPath} plus a structured reason when the command was not resolved. */
export function lookupCommandOnPath(command: string, deps: ProbeDeps = {}): CommandLookup {
  const platform = deps.platform ?? process.platform;
  const env = withWindowsUserEnvironment(deps.env ?? process.env, deps);
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  const existsSyncFn = deps.existsSyncFn ?? existsSync;
  if (platform === "win32") {
    return resolveCommandOnWindows(command, env, execFileSyncFn, existsSyncFn);
  }
  const locator = "which";

  let missReason: RuntimeProbeUnavailableReason = "not_installed";
  try {
    const output = normalizeExecOutput(execFileSyncFn(locator, [command], {
      stdio: ["ignore", "pipe", "ignore"],
      env,
    }));
    const resolved = output.trim().split(/\r?\n/)[0];
    if (resolved) return { command: resolved };
    // `which` succeeded but printed nothing: not evidence of absence.
    missReason = "probe_failed";
  } catch (error) {
    // Fall through to the user-local bin directories.
    missReason = classifyCommandLookupFailure(error, POSIX_WHICH_NOT_FOUND_EXIT);
  }
  // A service started from a non-login context (installer, cron, `env -i`)
  // inherits the system default PATH, which omits the user-local bin
  // directories where the Claude Code, Codex, Grok and Kimi installers put
  // their binaries.
  const homeDir = deps.homeDir ?? env.HOME;
  const fallback = homeDir
    ? firstExistingPath(
      POSIX_USER_BIN_DIRS.map((segments) => path.posix.join(homeDir, ...segments, command)),
      deps,
    )
    : null;
  return fallback ? { command: fallback } : { command: null, missReason };
}

/**
 * Classify a failed probe child process (execFileSync error) by its structured
 * fields. The command was already resolved, so this never returns
 * "not_installed": a resolved command that fails to exec (even with ENOENT,
 * e.g. a missing shebang interpreter) is a broken install, not a missing one.
 */
export function classifyProbeExecFailure(error: unknown): Exclude<RuntimeProbeUnavailableReason, "not_installed" | "unsupported_version"> {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  if (code === "ETIMEDOUT") return "probe_timeout";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  return "probe_failed";
}

export function firstExistingPath(candidates: string[], deps: ProbeDeps = {}): string | null {
  const exists = deps.existsSyncFn ?? existsSync;
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function readCommandVersion(command: string, args: string[] = [], deps: ProbeDeps = {}): string | null {
  const env = withWindowsUserEnvironment(deps.env ?? process.env, deps);
  const execFileSyncFn = deps.execFileSyncFn ?? execFileSync;
  try {
    const output = normalizeExecOutput(execFileSyncFn(command, [...args, "--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      ...(deps.cwd ? { cwd: deps.cwd } : {}),
      timeout: 5000,
    }));
    return output.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

export function resolveHomePath(relativePath: string, deps: ProbeDeps = {}): string {
  const homeDir = deps.homeDir ?? deps.env?.HOME ?? process.env.HOME ?? "";
  return path.join(homeDir, relativePath);
}
