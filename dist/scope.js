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
// SCOPE_NORMALIZE (1.3.7): resolves a caller-supplied scope argument against
// the active scoping mode. In "global" mode every explicit scope (e.g. a
// memory_remember(scope="project")) collapses to "global" — otherwise such
// rows would be stored under a literal scope that scope-filtered tools never
// query (the rows are effectively lost). In "project" mode the argument is
// honored, falling back to the derived project scope.
export function resolveScope(scope, worktree) {
    if (resolveScoping(worktree) !== "project") {
        return "global";
    }
    return scope ?? deriveProjectScope(worktree);
}
// SCOPING_CONFIG_SOURCE (1.4.5): resolveScoping used to call
// resolveMemoryConfig({}, worktree) — the empty config meant opencode.json's
// memory.scoping (which only reaches the plugin through the config hook)
// was silently ignored and "project" collapsed to "global". The plugin now
// injects the real config object via setScopingConfigSource(); sidecar and
// env are still re-read on every call, and env keeps precedence.
let scopingConfigSource;
export function setScopingConfigSource(config) {
    scopingConfigSource = config ?? undefined;
}
function resolveScoping(worktree) {
    try {
        return resolveMemoryConfig(scopingConfigSource ?? {}, worktree).scoping === "project" ? "project" : "global";
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