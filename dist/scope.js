import { stableHash } from "./utils.js";
import { resolveMemoryConfig } from "./config.js";
// SCOPING_TOGGLE: runtime switch between two scoping modes, driven by the
// plugin config key `scoping` (env override: OPENCODE_MEMORY_PRO_SCOPING):
//   "global"  (default) — single-user personal assistant: every scope
//             collapses to "global", so ALL memories are searchable from
//             any session/directory. (This supersedes the old
//             SINGLE_USER_GLOBAL_SCOPE hardcode.)
//   "project" — upstream behavior: memories are partitioned per project by
//             a hash of the worktree's local directory path; the "global"
//             scope is still searched when includeGlobalScope is enabled.
// NO_GIT_SCOPE (perf review): this used to also try a `git config --get
// remote.origin.url` lookup (so clones of the same repo at different paths
// shared one scope) via execFileSync — a BLOCKING subprocess spawn on every
// call in "project" mode. Dropped entirely; project scope is now always
// derived from the worktree path alone. Trade-off: two clones/worktrees of
// the same repo now get different scopes (they didn't before); nothing
// shells out anymore.
// The mode is re-read on every call, cached briefly (see resolveScoping)
// so flipping the config file takes effect in running processes without a
// restart, without paying a full config re-resolution on every tool call.
export function deriveProjectScope(worktree) {
    if (resolveScoping(worktree) !== "project") {
        return "global";
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
    // SCOPING_CACHE (perf review): the config object just changed, so any
    // cached scoping decisions computed against the old one are invalid.
    scopingCache.clear();
}
// SCOPING_CACHE (perf review): resolveScoping used to call
// resolveMemoryConfig() — up to 4 sync existsSync+readFileSync+JSON.parse
// sidecar reads plus a full re-resolution of every config section — on
// EVERY tool call and every recall turn, just to read one boolean field.
// Cache the resolved value per worktree for a short TTL so repeated calls
// within one turn/session don't repay that cost, while still picking up
// sidecar edits or `setScopingConfigSource` calls (which clear the cache
// outright) without a process restart. The cache entry is additionally
// keyed on the current OPENCODE_MEMORY_PRO_SCOPING env value (a free
// read, no I/O) so a runtime env override — the one thing that can change
// the outcome without going through setScopingConfigSource — is never
// served stale.
const SCOPING_CACHE_TTL_MS = Number.isFinite(Number(process.env.OPENCODE_MEMORY_PRO_SCOPING_CACHE_TTL_MS))
    ? Math.max(0, Number(process.env.OPENCODE_MEMORY_PRO_SCOPING_CACHE_TTL_MS))
    : 5000;
// SCOPING_CACHE_LRU (1.6.2): the cache evicted the OLDEST-INSERTED entry
// (Map insertion order), not the least-recently-USED — a long-lived server
// hosting many project directories could evict a hot entry while keeping a
// cold stale one. get() now refreshes recency before every read (delete →
// set), so eviction drops the least-recently-USED key. Also: a TTL of 0
// (OPENCODE_MEMORY_PRO_SCOPING_CACHE_TTL_MS=0) silently DISABLED the cache
// (every entry expired instantly, `now < expiresAt` always false); 0 now
// means "never expire" so the cache stays usable.
const SCOPING_CACHE_MAX_ENTRIES = 20;
const scopingCache = new Map();
function resolveScoping(worktree) {
    const key = worktree ?? "";
    const envScoping = process.env.OPENCODE_MEMORY_PRO_SCOPING;
    const now = Date.now();
    const rawCached = scopingCache.get(key);
    if (rawCached && rawCached.envScoping === envScoping) {
        const expired = SCOPING_CACHE_TTL_MS > 0 && now >= rawCached.expiresAt;
        if (!expired) {
            // Refresh recency, then normalize: good; the clone below keeps
            // insertion order = LRU order.
            scopingCache.delete(key);
            scopingCache.set(key, { value: rawCached.value, envScoping, expiresAt: rawCached.expiresAt });
            return rawCached.value;
        }
    }
    let value;
    try {
        value = resolveMemoryConfig(scopingConfigSource ?? {}, worktree).scoping === "project" ? "project" : "global";
    }
    catch {
        value = "global";
    }
    scopingCache.delete(key);
    scopingCache.set(key, { value, envScoping, expiresAt: now + SCOPING_CACHE_TTL_MS });
    if (scopingCache.size > SCOPING_CACHE_MAX_ENTRIES) {
        const leastRecent = scopingCache.keys().next().value;
        scopingCache.delete(leastRecent);
    }
    return value;
}
// SCOPING_CACHE_LRU (1.6.2): test-only seam — expose the cache's current
// keys IN INSERTION (LRU) ORDER so the eviction policy is observable.
export function getScopingCacheKeys() {
    return Array.from(scopingCache.keys());
}