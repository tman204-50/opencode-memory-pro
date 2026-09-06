import { execFileSync } from "node:child_process";
import { stableHash } from "./utils.js";
import { resolveMemoryConfig } from "./config.js";
// SCOPING_TOGGLE: runtime switch between two scoping modes, driven by the
// plugin config key `scoping` (env override: OPENCODE_MEMORY_PRO_SCOPING):
//   "global"  (default) — single-user personal assistant: every scope
//             collapses to "global", so ALL memories are searchable from
//             any session/directory. (This supersedes the old
//             SINGLE_USER_GLOBAL_SCOPE hardcode.)
//   "project" — upstream behavior: memories are partitioned per project by
//             git remote URL (or local directory path hash); the "global"
//             scope is still searched when includeGlobalScope is enabled.
// The mode is re-read on every call (cheap sidecar read), so flipping the
// config file takes effect in running processes without a restart.
export function deriveProjectScope(worktree) {
    if (resolveScoping(worktree) !== "project") {
        return "global";
    }
    const remote = tryGetGitRemote(worktree);
    if (remote) {
        return `project:${stableHash(remote).slice(0, 16)}`;
    }
    return `project:local:${stableHash(worktree).slice(0, 16)}`;
}
export function buildScopeFilter(activeScope, includeGlobal) {
    const scopes = includeGlobal ? [activeScope, "global"] : [activeScope];
    return [...new Set(scopes)];
}
function resolveScoping(worktree) {
    try {
        return resolveMemoryConfig({}, worktree).scoping === "project" ? "project" : "global";
    }
    catch {
        return "global";
    }
}
function tryGetGitRemote(worktree) {
    try {
        const output = execFileSync("git", ["-C", worktree, "config", "--get", "remote.origin.url"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return output.length > 0 ? output : null;
    }
    catch {
        return null;
    }
}