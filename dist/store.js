import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import Fuse from "fuse.js";
import { validateEpisodicRecord, validateEpisodicRecordArray } from "./types.js";
import { tokenize, parseJsonObject } from "./utils.js";
import { log, logFileOnly } from "./logger.js";
import { startSpan } from "./timing.js";
const TABLE_NAME = "memories";
const EVENTS_TABLE_NAME = "effectiveness_events";
const EVENTS_SOURCE_COLUMN = "source";
// ANN_TUNABLES (1.3.0): nprobes controls IVF recall-vs-latency on filtered
// vector searches; the consolidation query batch controls how many ANN
// queries each batched vectorSearch call carries. Both were build-time
// guesses (nprobes=40, batch=16) — now env-overridable with the same
// conservative defaults, so tuning no longer requires a rebuild.
function envInt(name, fallback, min, max) {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.floor(raw))) : fallback;
}
// CACHE_TTL_DEFAULT (1.4.8): the SCOPE_CACHE_STALENESS age bound shipped with
// a 60s default — shorter than a single conversational turn gap — so with
// per-put invalidateScope the cache NEVER hit and every recall paid a full
// scope rebuild (readByScopes + tokenize + IDF + vecNorm over the whole
// scope; observed 14/14 and 17/17 cacheMiss across sessions, growing
// linearly with row count). Default is now 10 minutes and env-tunable:
// same-process writes are still caught instantly by version invalidation
// (store.put -> invalidateScope), so the age bound only bounds cross-process
// staleness, where a 10-minute window is acceptable. 0 disables the age
// check entirely (pure version gating, pre-1.4.0 behavior).
const STALE_AFTER_MS = envInt("OPENCODE_MEMORY_PRO_STALE_AFTER_MS", 10 * 60 * 1000, 0, 24 * 60 * 60 * 1000);
// SCOPE_CACHE_CAP (1.4.3): the per-scope cache used to truncate to a
// hardcoded 1000 newest records, silently making older memories invisible
// to search once a scope outgrew it. Now env-overridable; the default stays
// 1000 to preserve pre-1.4.3 behavior unless the operator opts in, so raising
// the cap is an explicit, documented decision (memory cost: ~6KB/record for
// the vector + tokenized + norms, so 50k ≈ 300-500MB/scope in JS).
const MAX_RECORDS_PER_SCOPE = envInt("OPENCODE_MEMORY_PRO_MAX_RECORDS_PER_SCOPE", 1_000, 100, 5_000_000);
const DEFAULT_CACHE_CONFIG = {
    maxScopes: 10,
    maxRecordsPerScope: MAX_RECORDS_PER_SCOPE,
    enabled: true,
    // SCOPE_CACHE_STALENESS (1.4.0): the version counter only sees THIS
    // process's writes, so when two opencode processes share one dbPath the
    // scope cache could serve stale records forever. A modest age-based
    // staleness bound forces a reload after staleAfterMs even when the local
    // version is unchanged, bounding cross-process staleness without a schema
    // change. 0 disables the age check (pure version gating, pre-1.4.0).
    staleAfterMs: STALE_AFTER_MS,
};
const NPROBES = envInt("OPENCODE_MEMORY_PRO_NPROBES", 40, 1, 500);
const ANN_QUERY_BATCH = envInt("OPENCODE_MEMORY_PRO_QUERY_BATCH", 16, 1, 256);
// READ_CAP_FIX (1.4.3): full-scope reads used a hard-coded .limit(100000)
// with no ORDER BY, so beyond 100k rows a search silently truncated an
// arbitrary subset of the table. Reads now order by timestamp DESC
// (deterministic latest-first when the cap binds) and the cap is
// configurable. 0 disables the cap (LanceDB limit() takes a u64;
// MAX_SAFE_INTEGER is effectively unbounded).
const MAX_SCAN_ROWS = envInt("OPENCODE_MEMORY_PRO_MAX_SCAN_ROWS", 5_000_000, 0, 100_000_000);
const SCAN_LIMIT = MAX_SCAN_ROWS === 0 ? Number.MAX_SAFE_INTEGER : MAX_SCAN_ROWS;
const SCAN_ORDER = Object.freeze([Object.freeze({ columnName: "timestamp", ascending: false })]);
// EPISODE_SCAN_ORDER (1.5.0): the episodic_tasks table uses startTime (not
// timestamp) as its temporal column — the READ_CAP_FIX pattern from 1.4.3,
// applied to queryTaskEpisodes/suggestRetryBudget so a client-side top-N slice
// means "most recent N" instead of an arbitrary scan-order prefix (a scope
// with more episodes than the caller's limit hid every newer episode forever).
const EPISODE_SCAN_ORDER = Object.freeze([Object.freeze({ columnName: "startTime", ascending: false })]);
const EPISODE_SCAN_LIMIT = MAX_SCAN_ROWS === 0 ? Number.MAX_SAFE_INTEGER : Math.max(MAX_SCAN_ROWS, 10_000);
// Exported for use by consolidateDuplicates
export function storeFastCosine(a, b, normA, normB) {
    if (a.length === 0 || b.length === 0 || a.length !== b.length)
        return 0;
    const denom = normA * normB;
    if (denom === 0)
        return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
    }
    return dot / denom;
}
export class MemoryStore {
    dbPath;
    static MIN_ROWS_FOR_INDEX = 256;
    lancedb = null;
    connection = null;
    table = null;
    eventTable = null;
    episodicTaskTable = null;
    // EPISODIC_TABLE_SINGLE_FLIGHT (1.6.1): memoizes the in-flight
    // ensureEpisodicTaskTable() promise so concurrent first-touches coalesce
    // onto one open/create instead of the loser's createTable throwing
    // "table already exists" and leaving episodicTaskTable null — which
    // silently no-ops every episodic hook for that session. Cleared in
    // finally so a failed ensure can retry on the next call.
    episodicTaskTablePromise = null;
    // INIT_SINGLE_FLIGHT (1.4.5): memoizes the in-flight init() promise so
    // concurrent callers coalesce onto one init instead of each opening a
    // connection and racing createTable (which throws "table already exists"
    // on a fresh store and leaks the loser's connection). Cleared in finally
    // so a failed init can be retried on the next call.
    initPromise = null;
    indexState = {
        vector: false,
        fts: false,
        ftsError: "",
        vectorRetries: 0,
        ftsRetries: 0,
        // DIMENSION_MISMATCH_DETECT: set by init() by comparing the live
        // embedder's probed dimension against the "vector" column's actual
        // physical FixedSizeList width (fixed forever once the table's first
        // row is written). See getPhysicalVectorDim() / repairEmbeddingDimension().
        dimensionMismatch: false,
        expectedDim: null,
        actualDim: null,
    };
    scopeCache = new Map();
    // SCOPE_CACHE_LAZY (1.1.7): per-scope write counter. invalidateScope()
    // bumps this instead of deleting the cache entry, so a burst of writes
    // (one chat turn = several commits) no longer thrashes the cache — the
    // entry is only reloaded when a query actually observes a stale version.
    scopeVersions = new Map();
    // FEEDBACK_STATS_CACHE (perf review): mirrors scopeVersions/scopeCache
    // but for the events-table feedback aggregate consumed by _search's
    // feedbackWeight channel (see getFeedbackStatsForScope). Bumped by
    // invalidateFeedbackStats(), called from _putEvent for feedback-type
    // events.
    feedbackVersions = new Map();
    feedbackStatsCache = new Map();
    cacheConfig;
    cacheStats = { hits: 0, misses: 0, evictions: 0 };
    graph = null;
    // LANCE_COMPACTION (1.1.2): Lance keeps one immutable version per write
    // (add/delete/update) plus its fragment files forever; without periodic
    // compaction this fork grew to ~21k _versions + data files (1.2GB with an
    // 8192 fd limit) → EMFILE, cancelled native tasks, OOM. optimize() compacts
    // fragments and prunes old versions; Lance serializes writers with an
    // exclusive table lock, so running it live is safe, and a failure is
    // logged but never fatal.
    static OPTIMIZE_INTERVAL_MS = 6 * 60 * 60 * 1000;
    static OPTIMIZE_MIN_VERSIONS = 500;
    // OPTIMIZE_LOCK (1.3.4): two opencode processes sharing one store both run
    // maybeOptimizeAll on first writes after a restart (lastOptimizeAt=0), so
    // their optimize() calls race. The loser's native Rust env_logger prints
    // "Compaction commit failed; leaving N rewritten fragment(s) in place for
    // GC" DIRECTLY to stderr — the plugin has no JS hook to intercept it (no
    // RUST_LOG in the binary), so it lands on the TUI no matter what log()
    // does. A lock file serializes compaction across processes; the loser just
    // skips this cycle (the 6h interval retries later). Stale locks (owner
    // process dead or older than the TTL) are reclaimed.
    static OPTIMIZE_LOCK_TTL_MS = 30 * 60 * 1000;
    // OPTIMIZE_LOCK_WAIT (1.3.6): the 1.3.4 lock gave up instantly when a live
    // process held it, and worse, it treated an EMPTY lock file as stale and
    // deleted it. But the owner creates the file with open("wx") and only THEN
    // writes its pid — a reader landing in that window read 0 bytes, declared
    // the lock stale, deleted it, and both processes "owned" the lock and raced
    // optimize(), which is what puts "Compaction commit failed; leaving N
    // rewritten fragments in place for GC" back on the TUI. Now a contender
    // WAITS a bounded amount of time for a live owner to finish (serializing
    // the compaction), and only reclaims after the pid should have been
    // written or the 30min TTL passes.
    static OPTIMIZE_LOCK_WAIT_MS = 10 * 1000;
    // INDEX_RECHECK_INTERVAL_MS (perf review): ensureIndexes() previously ran
    // exactly once, from _init(). A store that crosses MIN_ROWS_FOR_INDEX
    // (256 rows) mid-process — a handful of capture-heavy sessions on a
    // fresh store — never got the vector ANN index built for the rest of
    // that process's lifetime, staying on the brute-force cosine fallback in
    // findSimilarVectors/findSimilarVectorsBatch (dedup-check-on-capture and
    // consolidation) until restart. maybeOptimizeAll already runs after
    // every write path, so piggyback a cheap, independently-throttled
    // re-check there: table.listIndices()+countRows() is metadata-only, far
    // cheaper than the scans it unblocks, so a short interval is safe.
    static INDEX_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
    optimizing = false;
    lastOptimizeAt = 0;
    lastIndexCheckAt = 0;
    constructor(dbPath, cacheConfig) {
        this.dbPath = dbPath;
        this.cacheConfig = {
            ...DEFAULT_CACHE_CONFIG,
            maxRecordsPerScope: MAX_RECORDS_PER_SCOPE,
            ...cacheConfig,
        };
        // FEEDBACK_SCAN_BOUND (1.5.8-post): computeFeedbackStatsForScope used
        // the global SCAN_LIMIT (5M default) with a timestamp-desc sort, so a
        // feedback-cache miss/stale window (default 10 min) could spend seconds
        // scanning effectiveness_events.lance on a recall turn. The aggregate
        // only needs the last 30 days, one row per memoryId — 50k is far
        // beyond any real feedback volume. Per-instance (constructor-time)
        // so tests can shrink it.
        this.feedbackStatsScanLimit = envInt("OPENCODE_MEMORY_PRO_FEEDBACK_STATS_SCAN_LIMIT", 50_000, 1, 5_000_000);
    }
    /**
     * Cross-process compaction lock. Returns true when this process owns the
     * lock; false when another live process holds it (or the lock could not be
     * taken). Stale locks are reclaimed: owner pid no longer alive, or the lock
     * file is older than OPTIMIZE_LOCK_TTL_MS (crash fallback; the pid check
     * covers the normal case).
     */
    async acquireOptimizeLock() {
        await mkdir(this.dbPath, { recursive: true }).catch(() => { });
        const lockFile = join(this.dbPath, ".optimize.lock");
        const deadline = Date.now() + MemoryStore.OPTIMIZE_LOCK_WAIT_MS;
        let waitedMs = 0;
        for (;;) {
            try {
                const handle = await open(lockFile, "wx");
                try {
                    await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
                }
                catch { }
                await handle.close();
                if (waitedMs > 0) {
                    log("debug", `[store] acquired compaction lock after ${waitedMs}ms wait`);
                }
                return true;
            }
            catch (error) {
                if (error?.code !== "EEXIST")
                    return false;
                let stale = false;
                try {
                    const content = await readFile(lockFile, "utf8");
                    const [pidStr, tsStr] = content.split("\n");
                    const ownerPid = Number(pidStr);
                    const ownerTs = Number(tsStr);
                    if (!Number.isInteger(ownerPid) || ownerPid <= 0) {
                        // The owner creates the file with open("wx") and only
                        // THEN writes the pid; reading in between yields empty
                        // content. Treat that as "being initialized", not stale
                        // — this was the 1.3.4 bug that let two instances both
                        // own the lock and race optimize().
                        if (waitedMs < 250) {
                            await new Promise((resolve) => setTimeout(resolve, 50));
                            waitedMs += 50;
                            continue;
                        }
                        stale = true;
                    }
                    else if (Number.isFinite(ownerTs) && Date.now() - ownerTs > MemoryStore.OPTIMIZE_LOCK_TTL_MS) {
                        stale = true;
                    }
                    else if (ownerPid !== process.pid) {
                        try {
                            process.kill(ownerPid, 0);
                        }
                        catch {
                            stale = true;
                        }
                    }
                    else {
                        // Same process already owns it (shouldn't happen with
                        // the optimizing guard; never deadlock on ourselves).
                        return false;
                    }
                }
                catch {
                    // Lock vanished between the EEXIST and the read (owner
                    // released); give it a short grace before reclaiming.
                    if (waitedMs < 150) {
                        await new Promise((resolve) => setTimeout(resolve, 50));
                        waitedMs += 50;
                        continue;
                    }
                    stale = true;
                }
                if (!stale) {
                    // Live owner: wait for it to finish instead of racing it,
                    // until the bounded deadline (then skip this cycle).
                    if (Date.now() >= deadline) {
                        logFileOnly("debug", "[store] compaction lock still held after waiting; skipping this cycle");
                        return false;
                    }
                    await new Promise((resolve) => setTimeout(resolve, 100));
                    waitedMs += 100;
                    continue;
                }
                // Stale: reclaim and loop back to try creating the lock.
                await rm(lockFile, { force: true }).catch(() => { });
            }
        }
    }
    async releaseOptimizeLock() {
        await rm(join(this.dbPath, ".optimize.lock"), { force: true }).catch(() => { });
    }
    /**
     * Version-count-gated Lance compaction. Non-blocking: reads the _versions
     * directory for each open table and optimizes the ones that crossed the
     * threshold (or all when force=true), throttled by an interval so chatty
     * sessions can't trigger it every turn. cleanupOlderThan=1h keeps
     * in-flight recent versions; deleteUnverified removes orphaned fragment
     * files (safe under Lance's exclusive table write lock). The cross-process
     * lock keeps two opencode instances from racing optimize() on a shared
     * store — the race is what makes lance print "Compaction commit failed" to
     * stderr (uninterceptable), so the lock is what keeps it out of the TUI.
     */
    async maybeOptimizeAll(force = false) {
        // INDEX_RECHECK_INTERVAL_MS (perf review): independent of compaction
        // — fire-and-forget so it never adds latency to the write path that
        // triggered this call, and skipped while a compaction is in flight in
        // this process to avoid two concurrent native calls against the same
        // table handle (the next write's call picks it up a few minutes
        // later either way).
        void this.maybeRecheckVectorIndex().catch(() => { });
        // TIMING_SPANS (1.4.7): compaction is the usual suspect for write-path
        // latency spikes; spanExtra.attempted distinguishes real compaction
        // runs from the frequent interval-guard early returns.
        const spanExtra = {};
        const stop = startSpan("store.optimize");
        try {
            return await this._maybeOptimizeAll(force, spanExtra);
        }
        finally {
            stop(spanExtra);
        }
    }
    async maybeRecheckVectorIndex() {
        if (this.indexState.vector || this.optimizing)
            return;
        const now = Date.now();
        if (now - this.lastIndexCheckAt < MemoryStore.INDEX_RECHECK_INTERVAL_MS)
            return;
        this.lastIndexCheckAt = now;
        try {
            await this.ensureIndexes();
        }
        catch (error) {
            log("debug", `[store] periodic vector index recheck failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async _maybeOptimizeAll(force = false, spanExtra = {}) {
        if (this.optimizing)
            return;
        // OPTIMIZE_GUARD (1.3.6): set the in-process guard synchronously,
        // BEFORE any await. The 1.3.4 code set it only after the async
        // candidate enumeration, so two overlapping calls in one process (the
        // fire-and-forget write trigger plus an awaited explicit call on the
        // first turn) could both pass the guard and run optimize()
        // concurrently — another way into the "Compaction commit failed" race.
        this.optimizing = true;
        let attempted = false;
        spanExtra.attempted = false;
        try {
            const elapsed = Date.now() - this.lastOptimizeAt;
            if (!force && elapsed < MemoryStore.OPTIMIZE_INTERVAL_MS)
                return;
            const tables = [this.table, this.eventTable, this.episodicTaskTable].filter(Boolean);
            const candidates = [];
            for (const table of tables) {
                let count = 0;
                // LANCE_COMPACTION_FIX (1.1.6): LanceDB stores each table on disk as
                // "<name>.lance", but Table.name only carries the bare name — so the
                // old readdir(.../table.name/_versions) always hit ENOENT, the catch
                // swallowed it, and optimize() NEVER ran. Result: 13k+ _versions and
                // 11k+ fragment files accumulated (disk + native handle/cache growth
                // per write, EMFILE/OOM risk). Try the real on-disk dir first.
                for (const dirName of [`${table.name}.lance`, table.name]) {
                    try {
                        const entries = await readdir(join(this.dbPath, dirName, "_versions"), { withFileTypes: true });
                        count = entries.filter((e) => e.isFile()).length;
                        if (count > 0)
                            break;
                    }
                    catch { }
                }
                if (force || count >= MemoryStore.OPTIMIZE_MIN_VERSIONS) {
                    candidates.push({ table, count });
                }
                else {
                    log("debug", `[store] optimize skipped for ${table.name}: ${count} versions (min ${MemoryStore.OPTIMIZE_MIN_VERSIONS})`);
                }
            }
            if (force) {
                this.lastOptimizeAt = Date.now();
                attempted = true;
            }
            if (candidates.length === 0)
                return;
            attempted = true;
            const lockHeld = await this.acquireOptimizeLock();
            if (!lockHeld) {
                logFileOnly("warn", "[store] optimize skipped: another process holds the compaction lock (retries next interval)");
                return;
            }
            try {
                const olderThan = new Date(Date.now() - 60 * 60 * 1000);
                log("debug", `[store] optimize candidates: ${candidates.map((c) => `${c.table.name}(${c.count})`).join(", ")}`);
                for (const { table, count } of candidates) {
                    try {
                        const stats = await table.optimize({ cleanupOlderThan: olderThan, deleteUnverified: true });
                        log("info", `[store] optimized ${table.name}: ${count} versions before, pruned=${stats.prune.oldVersionsRemoved}, bytesRemoved=${stats.prune.bytesRemoved}`);
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        // Known-benign LanceDB compaction races: a concurrent write
                        // (or a second optimize pass) commits a newer version between
                        // our read and our commit. Lance leaves the rewritten
                        // fragments for GC and the next optimize retry succeeds (and
                        // the success line below is logged). Keep these out of the
                        // TUI; they still land in the plugin log file for debugging.
                        if (/Retryable commit conflict|Compaction commit failed/.test(message)) {
                            logFileOnly("warn", `[store] optimize conflict for ${table.name} (self-heals on retry): ${message}`);
                            continue;
                        }
                        log("warn", `[store] optimize failed for ${table.name}: ${message}`);
                    }
                }
            }
            finally {
                await this.releaseOptimizeLock();
            }
        }
        finally {
            this.optimizing = false;
            spanExtra.attempted = attempted;
            if (attempted) {
                this.lastOptimizeAt = Date.now();
            }
        }
    }
    async init(vectorDim) {
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = this._init(vectorDim);
        try {
            return await this.initPromise;
        }
        finally {
            this.initPromise = null;
        }
    }
    async _init(vectorDim) {
        await mkdir(this.dbPath, { recursive: true });
        await mkdir(dirname(this.dbPath), { recursive: true });
        this.lancedb = await import("@lancedb/lancedb");
        this.connection = (await this.lancedb.connect(this.dbPath));
        try {
            this.table = await this.connection.openTable(TABLE_NAME);
        }
        catch {
            const bootstrap = {
                id: "__bootstrap__",
                text: "",
                vector: new Array(vectorDim).fill(0),
                category: "other",
                scope: "global",
                importance: 0,
                timestamp: 0,
                lastRecalled: 0,
                recallCount: 0,
                projectCount: 0,
                schemaVersion: 2,
                embeddingModel: "bootstrap",
                vectorDim,
                metadataJson: "{}",
                userId: undefined,
                teamId: undefined,
                sourceSessionId: undefined,
                confidence: undefined,
                tags: undefined,
                status: "active",
                parentId: undefined,
                citationSource: undefined,
                citationTimestamp: undefined,
                citationStatus: undefined,
                citationChain: undefined,
            };
            this.table = await this.connection.createTable(TABLE_NAME, [bootstrap]);
            await this.table.delete("id = '__bootstrap__'");
        }
        try {
            this.eventTable = await this.connection.openTable(EVENTS_TABLE_NAME);
        }
        catch {
            const bootstrapEvent = {
                id: "__bootstrap__",
                type: "capture",
                scope: "global",
                sessionID: "",
                timestamp: 0,
                memoryId: "",
                text: "",
                outcome: "considered",
                skipReason: "",
                resultCount: 0,
                injected: false,
                source: "",
                feedbackType: "",
                helpful: -1,
                reason: "",
                labelsJson: "[]",
                metadataJson: "{}",
            };
            this.eventTable = await this.connection.createTable(EVENTS_TABLE_NAME, [bootstrapEvent]);
            await this.eventTable.delete("id = '__bootstrap__'");
        }
        await this.ensureMemoriesTableCompatibility();
        await this.ensureEventTableCompatibility();
        await this.ensureIndexes();
        // DIMENSION_MISMATCH_DETECT: compare the embedder dimension this
        // process just probed (vectorDim, the init() argument) against the
        // table's actual physical column width. They only diverge when
        // embedding.provider/embedding.model was changed to a different-
        // output-size model without resetting the store — and when that
        // happens, LanceDB does NOT reject the mismatched write; it silently
        // coerces it into the old fixed-width column (corrupting the vector),
        // and every vectorSearch() call at the new dimension throws (silently
        // swallowed by findSimilarVectors's catch), so dedup/consolidation
        // silently stop finding neighbors for anything written after the
        // switch. See repairEmbeddingDimension() for the fix.
        try {
            const physicalDim = await this.getPhysicalVectorDim();
            this.indexState.expectedDim = physicalDim;
            this.indexState.actualDim = vectorDim;
            this.indexState.dimensionMismatch = physicalDim !== null && physicalDim !== vectorDim;
            if (this.indexState.dimensionMismatch) {
                log("warn", `[store] Embedding dimension mismatch: the embedder currently produces ` +
                    `${vectorDim}-dim vectors, but this store's "vector" column is physically fixed ` +
                    `at ${physicalDim}-dim (set when the table was first created). New memories will ` +
                    `be written with corrupted vectors and dedup/consolidation will silently stop ` +
                    `finding neighbors for anything written from now on. Fix: call the memory_reembed ` +
                    `tool (dryRun:false, confirm:true) to back up and re-embed every memory under the ` +
                    `current model.`);
            }
        }
        catch (error) {
            log("debug", `[store] dimension-mismatch check failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        const retentionDays = this.retentionConfig?.effectivenessEventsDays;
        if (retentionDays !== undefined && retentionDays > 0) {
            await this.cleanupExpiredEvents(undefined, retentionDays);
        }
        // LANCE_COMPACTION_FIX (1.1.6): fire-and-forget so a first-run
        // compaction of a backlogged store (13k+ versions) doesn't block init —
        // it compacts in the background once the version gate passes.
        // OPTIMIZE_JITTER (1.3.4): staggered 5–30s so two instances that boot
        // together don't race for the compaction lock in the same instant.
        setTimeout(() => {
            void this.maybeOptimizeAll(false).catch((error) => {
                log("warn", `[store] startup optimize failed: ${error instanceof Error ? error.message : String(error)}`);
            });
        }, 5_000 + Math.floor(Math.random() * 25_000));
    }
    // GRACEFUL_SHUTDOWN: lance's commit path spawns a background
    // auto_cleanup_hook task; if the process exits without closing the
    // connection, tokio drops the runtime mid-task and lance logs "task ... was
    // cancelled" at shutdown. close() is synchronous (native binding) and
    // idempotent, so it can run from a process.on("exit") listener. Tables are
    // independent of the connection, so this is safe even with in-flight ops.
    close() {
        try {
            this.connection?.close();
        }
        catch (error) {
            log("warn", `[store] close failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.connection = null;
        this.table = null;
        this.eventTable = null;
        this.episodicTaskTable = null;
        this.episodicTaskTablePromise = null;
        this.lancedb = null;
    }
    retentionConfig;
    setRetentionConfig(config) {
        this.retentionConfig = config;
    }
    // RETENTION_SCORING (1.5.5): weights for retention-scored scope-cache
    // truncation (WHICH records survive when a scope exceeds
    // maxRecordsPerScope). Reuses the retrieval.* weights from search ranking
    // so "what ranks well ≈ what survives truncation". Set by index.js from
    // resolved.retrieval; null keeps the legacy recency-only truncation.
    retentionScoringConfig;
    setRetentionScoringConfig(config) {
        this.retentionScoringConfig = config || null;
    }
    // GRAPH_STORE_PHASE1: attach the offline entity graph for provenance
    // cleanup on memory removal/merge. Safe no-op if never attached.
    attachGraph(graph) {
        this.graph = graph;
    }
    notifyGraphRemoved(id) {
        try {
            this.graph?.onMemoryRemoved(id);
        }
        catch (error) {
            log("warn", `[store] graph onMemoryRemoved failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    notifyGraphMerged(olderId, newerId) {
        try {
            this.graph?.onMemoryMerged(olderId, newerId);
        }
        catch (error) {
            log("warn", `[store] graph onMemoryMerged failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    async cleanupExpiredEvents(scopes, retentionDaysOverride) {
        const table = this.requireEventTable();
        const retentionDays = retentionDaysOverride ?? this.retentionConfig?.effectivenessEventsDays ?? 90;
        if (retentionDays <= 0) {
            return 0;
        }
        const cutoffTimestamp = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        // TTL_BATCH_DELETE (1.1.7): was a per-row delete loop (up to 1000
        // commits at startup, each spawning a new LanceDB version). Now one
        // batched `id IN (...)` delete per 1000 rows → a handful of commits.
        // SCOPE_FILTER_FIX (1.2.0): events are always scoped with exact
        // strings ("global" / "project:<hash>"); the old `scope LIKE
        // 'project:%'` matched EVERY project scope, so cleaning one project
        // also deleted every other project's expired events. Now exact-match
        // `scope IN (...)` for the given scopes (undefined = all scopes).
        let deletedCount = 0;
        // FEEDBACK_TTL_INVALIDATION (1.6.2): deleting feedback rows changes
        // the feedback aggregate for their scopes, but cleanupExpiredEvents
        // never bumped feedbackVersions → stale aggregates were served for up
        // to the cache TTL (default 10 min; dormant at default event TTL 90d
        // > 30d feedback window, live with effectivenessEventsDays < 30).
        // Track which scopes actually had rows deleted and invalidate them.
        const scopesWithDeletedEvents = new Set();
        const ttlBatchSize = 1000;
        for (;;) {
            let filter = `timestamp < ${cutoffTimestamp}`;
            if (Array.isArray(scopes) && scopes.length > 0) {
                const scopeExpr = scopes.map((scope) => `scope = '${escapeSql(scope)}'`).join(" OR ");
                filter = `(${filter}) AND (${scopeExpr})`;
            }
            const toDelete = await table.query().where(filter).limit(ttlBatchSize).toArray();
            if (toDelete.length === 0)
                break;
            const idsToDelete = toDelete.map((row) => row.id);
            // FEEDBACK_TTL_INVALIDATION: only invalidate scopes whose deleted
            // events were actual feedback (non-feedback events don't feed the
            // aggregate).
            for (const row of toDelete) {
                if (row.type === "feedback") {
                    scopesWithDeletedEvents.add(row.scope);
                }
            }
            try {
                const idIn = idsToDelete.map((id) => `'${escapeSql(id)}'`).join(", ");
                await table.delete(`id IN (${idIn})`);
                deletedCount += idsToDelete.length;
            }
            catch (error) {
                log("warn", `[store] Failed to batch-delete ${idsToDelete.length} expired events: ${error}`);
                break;
            }
            if (idsToDelete.length < ttlBatchSize)
                break;
        }
        if (scopesWithDeletedEvents.size > 0) {
            for (const scope of scopesWithDeletedEvents) {
                this.invalidateFeedbackStats(scope);
            }
            log("info", `[store] Event TTL cleanup invalidated feedback stats for ${scopesWithDeletedEvents.size} scope(s)`);
        }
        if (deletedCount > 0) {
            log("info", `[store] Event TTL cleanup completed, deleted=${deletedCount}, retentionDays=${retentionDays}`);
        }
        await this.maybeOptimizeAll(false);
        return deletedCount;
    }
    async getEventTtlStatus() {
        const retentionDays = this.retentionConfig?.effectivenessEventsDays ?? 90;
        const enabled = retentionDays > 0;
        if (!enabled) {
            return { enabled: false, retentionDays: 0, expiredCount: 0, scopeBreakdown: {} };
        }
        const cutoffTimestamp = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const table = this.requireEventTable();
        // TTL_STATUS_BOUND (1.3.5): was an unbounded toArray() over every
        // expired event (this store has seen 636MB event tables). Bound it
        // like every other read path; the status is an estimate anyway.
        const allExpired = await table.query().where(`timestamp < ${cutoffTimestamp}`).limit(100000).toArray();
        const expiredCount = allExpired.length;
        const scopeBreakdown = {};
        for (const row of allExpired) {
            const scope = row.scope || "unknown";
            scopeBreakdown[scope] = (scopeBreakdown[scope] || 0) + 1;
        }
        return { enabled, retentionDays, expiredCount, scopeBreakdown };
    }
    async put(record) {
        // TIMING_SPANS (1.4.7): write-path latency (table.add + optimize trigger).
        const stop = startSpan("store.put");
        try {
            return await this._put(record);
        }
        finally {
            stop();
        }
    }
    async _put(record) {
        const table = this.requireTable();
        const recordWithDefaults = {
            ...record,
            userId: record.userId ?? undefined,
            teamId: record.teamId ?? undefined,
            sourceSessionId: record.sourceSessionId ?? undefined,
            confidence: record.confidence ?? undefined,
            // TAGS_SERIALIZE: tags is a STRING column (normalizeRow JSON.parses
            // it on read). Same hazard as citationChain below: a raw array hits
            // Array.prototype.toString ("a,b") and then fails to parse on every
            // subsequent read. Normalize at the chokepoint so every writer agrees.
            tags: Array.isArray(record.tags)
                ? JSON.stringify(record.tags)
                : record.tags ?? undefined,
            status: record.status ?? "active",
            parentId: record.parentId ?? undefined,
            // CITATION_CHAIN_SERIALIZE (1.3.5): citationChain is a STRING
            // column (normalizeRow JSON.parses it on read; updateCitation
            // stringifies it). The import path passed a raw array, which
            // stored "src" via Array.prototype.toString and broke chains on
            // round trip. Normalize at the chokepoint so every writer agrees.
            citationChain: Array.isArray(record.citationChain)
                ? JSON.stringify(record.citationChain)
                : record.citationChain,
        };
        await table.add([recordWithDefaults]);
        this.invalidateScope(record.scope);
    }
    async putEvent(event) {
        // TIMING_SPANS (1.4.7): telemetry writes fire on every recall/capture;
        // they share the LanceDB write path with memories.
        const stop = startSpan("store.putEvent");
        try {
            return await this._putEvent(event);
        }
        finally {
            stop();
        }
    }
    async _putEvent(event) {
        const feedbackEvent = event.type === "feedback" ? event : null;
        const captureEvent = event.type === "capture" ? event : null;
        // EVENT_TEXT_BOUND (1.1.7): capture events carry the whole transcript
        // (up to 60k chars) into the events table — the reason
        // effectiveness_events.lance was 636MB. Telemetry stats only ever use
        // outcome/skipReason, never the full text, so bound it here at the
        // chokepoint for every event type.
        const eventText = typeof event.text === "string" ? event.text.slice(0, 4000) : "";
        await this.requireEventTable().add([
            {
                id: event.id,
                type: event.type,
                scope: event.scope,
                sessionID: event.sessionID ?? "",
                timestamp: event.timestamp,
                memoryId: event.memoryId ?? "",
                text: eventText,
                outcome: event.type === "capture" ? event.outcome : "",
                skipReason: event.type === "capture" ? event.skipReason ?? "" : "",
                resultCount: event.type === "recall" ? event.resultCount : 0,
                injected: event.type === "recall" ? event.injected : false,
                source: event.type === "recall" ? event.source ?? "" : "",
                feedbackType: event.type === "feedback" ? event.feedbackType : "",
                helpful: event.type === "feedback" ? (event.helpful === undefined ? -1 : event.helpful ? 1 : 0) : -1,
                reason: event.type === "feedback" ? event.reason ?? "" : "",
                labelsJson: event.type === "feedback" ? JSON.stringify(event.labels ?? []) : "[]",
                metadataJson: event.metadataJson,
                sourceSessionId: feedbackEvent?.sourceSessionId ?? captureEvent?.sourceSessionId ?? "",
                confidenceDelta: feedbackEvent?.confidenceDelta ?? null,
                relatedMemoryId: feedbackEvent?.relatedMemoryId ?? "",
                context: feedbackEvent?.context ? JSON.stringify(feedbackEvent.context) : null,
            },
        ]);
        // FEEDBACK_STATS_CACHE (perf review): a new feedback event changes
        // the aggregate for its scope; bump the version so the next
        // getFeedbackStatsForScope call for this scope recomputes instead of
        // serving a now-stale cached aggregate.
        if (feedbackEvent) {
            this.invalidateFeedbackStats(event.scope);
        }
    }
    invalidateFeedbackStats(scope) {
        this.feedbackVersions.set(scope, (this.feedbackVersions.get(scope) ?? 0) + 1);
    }
    async search(params) {
        // TIMING_SPANS (1.4.7): hybrid search is the recall hot path. The span
        // covers cache read + scoring; spanExtra.candidates (filled by _search)
        // reports how many rows were scanned so tuning can correlate latency
        // with scope-cache size.
        const spanExtra = {};
        const stop = startSpan("store.search");
        try {
            return await this._search(params, spanExtra);
        }
        finally {
            stop(spanExtra.candidates !== undefined ? { candidates: spanExtra.candidates } : undefined);
        }
    }
    async _search(params, spanExtra = {}) {
        const cached = await this.getCachedScopes(params.scopes);
        if (cached.records.length === 0)
            return [];
        const queryTokens = tokenize(params.query);
        const queryNorm = vecNorm(params.queryVector);
        const useVectorChannel = params.queryVector.length > 0 && params.vectorWeight > 0;
        const useBm25Channel = queryTokens.length > 0 && params.bm25Weight > 0;
        // FUZZY_CHANNEL (1.4.2): fuse.js typo-tolerant channel. On by default
        // (weight 0.15) unless the caller passes fuzzyWeight 0.
        const fuzzyWeight = Math.max(0, Number(params.fuzzyWeight) || 0);
        const useFuzzyChannel = params.query.trim().length > 0 && fuzzyWeight > 0;
        const fuzzyThreshold = params.fuzzyThreshold !== undefined ? Math.max(0, Math.min(1, params.fuzzyThreshold)) : 0.5;
        const { vectorWeight, bm25Weight, fuzzyWeight: normalizedFuzzyWeight } = normalizeChannelWeights(useVectorChannel ? params.vectorWeight : 0, useBm25Channel ? params.bm25Weight : 0, useFuzzyChannel ? fuzzyWeight : 0);
        const rrfK = Math.max(1, Math.floor(params.rrfK ?? 60));
        const recencyBoostEnabled = params.recencyBoost ?? true;
        const recencyHalfLifeHours = Math.max(1, params.recencyHalfLifeHours ?? 72);
        const importanceWeight = clampImportanceWeight(params.importanceWeight ?? 0.4);
        const feedbackWeight = Math.max(0, Math.min(1, params.feedbackWeight ?? 0));
        const globalDiscountFactor = params.globalDiscountFactor ?? 1.0;
        const fuzzyResults = useFuzzyChannel ? this.getFuzzyIndex(cached, params.scopes, fuzzyThreshold).search(params.query.trim(), { limit: Math.max(50, (Number(params.limit) || 50) * 4) }) : [];
        const fuzzyRanks = useFuzzyChannel ? buildRankMap(fuzzyResults.map((r) => ({ record: r.item, fuzzyScore: 1 - (r.score ?? 1) })), (item) => item.fuzzyScore) : null;
        const fuzzyScoreMap = new Map(fuzzyResults.map((r) => [r.item.id, 1 - (r.score ?? 1)]));
        // BM25_INDEX_ALIGN (1.4.5): cached.tokenized is aligned with the
        // UNFILTERED cached.records, so the tokenized index must be captured
        // BEFORE the dimension-mismatch filter. Mapping with the filtered
        // index silently scored every row after a filtered-out row against
        // the WRONG document's tokens.
        const candidates = cached.records
            .map((record, index) => ({ record, index }))
            .filter(({ record }) => params.queryVector.length === 0 || record.vector.length === params.queryVector.length)
            .map(({ record, index }) => {
            const recordNorm = cached.norms.get(record.id) ?? vecNorm(record.vector);
            const vectorScore = useVectorChannel ? storeFastCosine(params.queryVector, record.vector, queryNorm, recordNorm) : 0;
            const bm25Score = useBm25Channel ? bm25LikeScore(queryTokens, cached.tokenized[index], cached.idf) : 0;
            const isGlobal = record.scope === "global";
            return { record, vectorScore, bm25Score, fuzzyScore: fuzzyScoreMap.get(record.id) ?? 0, isGlobal };
        });
        if (candidates.length === 0)
            return [];
        spanExtra.candidates = candidates.length;
        const vectorRanks = useVectorChannel ? buildRankMap(candidates, (item) => item.vectorScore) : null;
        const bm25Ranks = useBm25Channel ? buildRankMap(candidates, (item) => item.bm25Score) : null;
        const feedbackStatsMap = feedbackWeight > 0
            ? await this.getMemoryFeedbackStatsMap(candidates.map((c) => c.record.id), params.scopes)
            : new Map();
        const scored = candidates
            .map((item) => {
            let rrfScore = 0;
            if (vectorRanks) {
                const rank = vectorRanks.get(item.record.id);
                if (rank !== undefined)
                    rrfScore += vectorWeight / (rrfK + rank);
            }
            if (bm25Ranks) {
                const rank = bm25Ranks.get(item.record.id);
                if (rank !== undefined)
                    rrfScore += bm25Weight / (rrfK + rank);
            }
            // FUZZY_CHANNEL (1.4.2): only records that appear in the fuzzy
            // top-N contribute a rank; the rest get nothing (same semantics
            // as the other channels).
            if (fuzzyRanks) {
                const rank = fuzzyRanks.get(item.record.id);
                if (rank !== undefined)
                    rrfScore += normalizedFuzzyWeight / (rrfK + rank);
            }
            rrfScore *= rrfK + 1;
            const recencyFactor = recencyBoostEnabled
                ? computeRecencyMultiplier(item.record.timestamp, recencyHalfLifeHours)
                : 1;
            const importanceFactor = 1 + importanceWeight * clampImportance(item.record.importance);
            const scopeFactor = item.isGlobal ? globalDiscountFactor : 1.0;
            const feedbackStats = feedbackStatsMap.get(item.record.id);
            const feedbackFactor = feedbackWeight > 0 && feedbackStats
                ? 1 + feedbackWeight * (feedbackStats.feedbackFactor - 1)
                : 1;
            const score = rrfScore * recencyFactor * importanceFactor * scopeFactor * feedbackFactor;
            return {
                record: item.record,
                score,
                vectorScore: item.vectorScore,
                bm25Score: item.bm25Score,
                fuzzyScore: item.fuzzyScore,
            };
        })
            .filter((item) => item.score >= params.minScore)
            .sort((a, b) => b.score - a.score)
            .slice(0, params.limit);
        return scored;
    }
    async deleteById(id, scopes) {
        const rows = await this.readByScopes(scopes);
        const match = rows.find((row) => this.matchesId(row.id, id));
        if (!match)
            return false;
        await this.requireTable().delete(`id = '${escapeSql(match.id)}'`);
        this.invalidateScope(match.scope);
        this.notifyGraphRemoved(match.id);
        return true;
    }
    // DELETE_BY_RAW_ID (1.3.5): exact-id hard delete that sees rows the
    // filtered reads hide (digested/merged/disabled). Used by memory_import
    // replace-mode so a pre-existing hidden row is actually replaced instead
    // of leaving two physical rows with the same id.
    async deleteByIdRaw(id) {
        const table = this.requireTable();
        const rows = await table.query().where(`id = '${escapeSql(id)}'`).limit(1).toArray();
        if (rows.length === 0)
            return false;
        await table.delete(`id = '${escapeSql(id)}'`);
        this.invalidateScope(rows[0].scope);
        this.notifyGraphRemoved(id);
        return true;
    }
    // DELETE_BY_FORCE (1.3.8): like deleteById but sees rows the status-
    // filtered reads hide (disabled/merged/digested). Fixes memory_forget
    // force=true: the soft-delete path marks rows disabled, and the force
    // path previously used deleteById, whose readByScopes filter excludes
    // status='disabled' — so "Use force=true for permanent deletion" silently
    // failed and left the hidden row on disk forever. Tries the exact-id raw
    // delete first (fast path), then falls back to an unfiltered scan so
    // prefix ids and hidden rows both work.
    async deleteByIdForce(id, scopes) {
        const table = this.requireTable();
        // Fast path: exact-id raw delete (sees hidden rows). When a scope
        // filter is provided, only delete if the row lives in one of those
        // scopes (DELETE_FORCE_SCOPE (1.6.2): memory_delete/memory_forget
        // previously hard-deleted across ALL scopes while claiming
        // current-scope-only).
        const exact = await table.query().where(`id = '${escapeSql(id)}'`).limit(1).toArray();
        if (exact.length > 0) {
            if (scopes && !scopes.includes(exact[0].scope)) {
                return false;
            }
            await table.delete(`id = '${escapeSql(id)}'`);
            this.invalidateScope(exact[0].scope);
            this.notifyGraphRemoved(id);
            return true;
        }
        // DELETE_ORDER_FALLBACK (1.6.2): the fallback scan had no ORDER BY —
        // with no committed order LanceDB's rows come back in an unstable
        // order, so a prefix-id match was nondeterministic and could silently
        // miss (or hit a different row than a prior call) beyond the cap.
        // Timestamp-desc matches the standard store ordering (SCAN_ORDER).
        const rows = await table.query().orderBy(SCAN_ORDER).limit(SCAN_LIMIT).toArray();
        if (MAX_SCAN_ROWS !== 0 && rows.length >= SCAN_LIMIT) {
            log("warn", `[store] deleteByIdForce fallback scan hit the ${MAX_SCAN_ROWS}-row cap; the target may not be found if it lives beyond the cap`);
        }
        const match = rows.find((row) => this.matchesId(row.id, id));
        if (!match)
            return false;
        if (scopes && !scopes.includes(match.scope)) {
            return false;
        }
        await table.delete(`id = '${escapeSql(match.id)}'`);
        this.invalidateScope(match.scope);
        this.notifyGraphRemoved(match.id);
        return true;
    }
    async softDeleteMemory(id, scopes) {
        const rows = await this.readByScopes(scopes);
        const match = rows.find((row) => this.matchesId(row.id, id));
        if (!match)
            return false;
        // ATOMIC_UPDATE (1.1.7): was delete+add (2 non-atomic commits); a single
        // table.update is one commit and can't leave stale+new copies.
        await this.requireTable().update({
            where: `id = '${escapeSql(match.id)}'`,
            values: { status: "disabled" },
        });
        this.invalidateScope(match.scope);
        this.notifyGraphRemoved(match.id);
        return true;
    }
    async updateMemoryScope(id, newScope, scopes) {
        const rows = await this.readByScopes(scopes);
        const match = rows.find((row) => this.matchesId(row.id, id));
        if (!match)
            return false;
        await this.requireTable().update({
            where: `id = '${escapeSql(match.id)}'`,
            values: { scope: newScope },
        });
        this.invalidateScope(match.scope);
        this.invalidateScope(newScope);
        return true;
    }
    async readGlobalMemories(limit = 100) {
        const rows = await this.readByScopes(["global"]);
        return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    }
    async getUnusedGlobalMemories(unusedDaysThreshold, limit = 100) {
        const cutoffTime = Date.now() - unusedDaysThreshold * 24 * 60 * 60 * 1000;
        const rows = await this.readByScopes(["global"]);
        return rows.filter((row) => row.lastRecalled > 0 && row.lastRecalled < cutoffTime).slice(0, limit);
    }
    async clearScope(scope) {
        // CLEAR_SCOPE_COUNT_ALL (1.4.6): readByScopes filters merged/digested/
        // disabled rows, but the delete below removes ALL rows in the scope —
        // the returned count undercounted (wrong tool response) and hidden
        // rows' graph nodes were never notified. Read exactly the set the
        // delete will remove (IncludingMerged applies no status filter).
        const rows = await this.readByScopesIncludingMerged([scope]);
        if (rows.length === 0)
            return 0;
        await this.requireTable().delete(`scope = '${escapeSql(scope)}'`);
        this.invalidateScope(scope);
        for (const row of rows) {
            this.notifyGraphRemoved(row.id);
        }
        return rows.length;
    }
    async list(scope, limit) {
        const rows = await this.readByScopes([scope]);
        return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    }
    async listSince(scope, sinceTimestamp, limit = 100) {
        const rows = await this.readByScopesIncludingMerged([scope]);
        return rows
            .filter((row) => row.timestamp >= sinceTimestamp)
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, limit);
    }
    async pruneScope(scope, maxEntries) {
        // TIMING_SPANS (1.4.7): retention prune scans up to 100k rows + batch
        // delete; worth watching alongside optimize on the write path.
        const stop = startSpan("store.pruneScope");
        try {
            return await this._pruneScope(scope, maxEntries);
        }
        finally {
            stop();
        }
    }
    async _pruneScope(scope, maxEntries) {
        const rows = await this.list(scope, SCAN_LIMIT);
        if (rows.length === SCAN_LIMIT) {
            log("warn", `[store] pruneScope scanned up to the ${SCAN_LIMIT}-row cap for scope=${scope}; entries older than the newest ${SCAN_LIMIT} rows are not candidates for pruning`);
        }
        if (rows.length <= maxEntries)
            return 0;
        const flagged = rows.filter((r) => {
            const meta = parseMetadata(r.metadataJson);
            return meta.isPotentialDuplicate === true;
        });
        const unflagged = rows.filter((r) => {
            const meta = parseMetadata(r.metadataJson);
            return meta.isPotentialDuplicate !== true;
        });
        const sortedFlagged = flagged.sort((a, b) => a.timestamp - b.timestamp);
        const sortedUnflagged = unflagged.sort((a, b) => a.timestamp - b.timestamp);
        const toDeleteCount = rows.length - maxEntries;
        const deleteFromFlagged = Math.min(sortedFlagged.length, toDeleteCount);
        const toDelete = [
            ...sortedFlagged.slice(0, deleteFromFlagged),
            ...sortedUnflagged.slice(0, toDeleteCount - deleteFromFlagged),
        ];
        // PRUNE_SCOPE_BATCH_DELETE (1.4.6): the per-row delete loop issued one
        // round trip per row; batch into a single id IN (...) delete. Same
        // selection semantics (flagged oldest first), one round trip.
        if (toDelete.length > 0) {
            const idList = toDelete.map((row) => `'${escapeSql(row.id)}'`).join(", ");
            await this.requireTable().delete(`id IN (${idList})`);
        }
        for (const row of toDelete) {
            this.notifyGraphRemoved(row.id);
        }
        this.invalidateScope(scope);
        await this.maybeOptimizeAll(false);
        return toDelete.length;
    }
    async consolidateDuplicates(scope, threshold, candidateLimit = 50) {
        // TIMING_SPANS (1.4.7): consolidation is throttled but heavy (ANN batch
        // scan + batched writes); track it separately from the search path.
        const spanExtra = {};
        const stop = startSpan("store.consolidate");
        try {
            return await this._consolidateDuplicates(scope, threshold, candidateLimit, spanExtra);
        }
        finally {
            stop(spanExtra.rows !== undefined ? { rows: spanExtra.rows } : undefined);
        }
    }
    async _consolidateDuplicates(scope, threshold, candidateLimit = 50, spanExtra = {}) {
        // MERGE_STATUS_FILTER (1.3.5): consolidation used to run over
        // readByScopesIncludingMerged and only consulted METADATA
        // status:merged/mergedFrom — so digested (retention-hidden) and
        // disabled (soft-deleted) rows could be picked as merge endpoints and
        // have their column status overwritten to "merged", resurrecting
        // disabled rows and corrupting digest provenance. Only active/unset
        // rows may participate.
        let rows = await this.readByScopesIncludingMerged([scope]);
        rows = rows.filter((r) => r.status === undefined || r.status === null || r.status === "" || r.status === "active");
        spanExtra.rows = rows.length;
        if (rows.length === 0) {
            return { mergedPairs: 0, updatedRecords: 0, skippedRecords: 0, clearedFlags: 0 };
        }
        const BATCH_SIZE = 100;
        const FALLBACK_THRESHOLD = 500;
        const QUERY_BATCH = ANN_QUERY_BATCH;
        let mergedPairs = 0;
        let updatedRecords = 0;
        let skippedRecords = 0;
        const now = Date.now();
        const FIVE_MINUTES_MS = 5 * 60 * 1000;
        const startTime = Date.now();
        const rowsWithNorms = rows.map((row) => ({
            row,
            norm: this.scopeCache.get(scope)?.norms.get(row.id) ?? vecNorm(row.vector),
        }));
        // DEDUP_FLAG_REVALIDATION (1.4.0): the write-time dedup check used to
        // flag nearly every capture (RRF score >= 1.0 vs writeThreshold in
        // [0,1]), and the flag was a one-way ratchet — nothing ever cleared it,
        // so flaggedCount only grew. Consolidation is where a real cosine
        // comparison happens, so flagged rows whose closest found neighbor
        // stays below the consolidate threshold get the flag cleared; rows
        // that DO have a near-duplicate keep it.
        const metaById = new Map(rowsWithNorms.map(({ row }) => [row.id, parseMetadata(row.metadataJson)]));
        // COSMETICS (1.5.3): consolidate used rowsWithNorms.find() per ANN
        // candidate (O(n) per candidate, O(n²) per chunk); the id → row map
        // below makes candidate lookups O(1).
        const rowById = new Map(rowsWithNorms.map((entry) => [entry.row.id, entry]));
        const flaggedIds = new Set([...metaById].filter(([, meta]) => meta.isPotentialDuplicate === true).map(([id]) => id));
        const bestSimByFlagged = new Map();
        const mergedIds = new Set();
        let clearedFlags = 0;
        log("debug", `[consolidate] scope=${scope} rows=${rows.length} threshold=${threshold} candidateLimit=${candidateLimit} batchSize=${BATCH_SIZE} fallbackThreshold=${FALLBACK_THRESHOLD}`);
        const processWithANN = async () => {
            let localMerged = 0;
            let localUpdated = 0;
            let localSkipped = 0;
            const totalChunks = Math.ceil(rowsWithNorms.length / BATCH_SIZE);
            // ISSUE3_YIELD (1.5.8): consolidate is CPU-bound and runs on
            // session.idle in-process; without yielding it would monopolize
            // the event loop for the whole ~18s run and starve concurrent
            // recalls (observed recall.pipeline 9.4s / store.search 9.1s vs
            // ~0.6s clean). The chunk-end yield only fired once per 100 rows,
            // leaving ~50ms+ sync slices. Now yield every sub-batch when the
            // event loop hasn't been released within ~40ms, bounding each
            // blocking slice.
            let lastYieldAt = Date.now();
            for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
                const chunkStart = chunkIdx * BATCH_SIZE;
                const chunkEnd = Math.min(chunkStart + BATCH_SIZE, rowsWithNorms.length);
                const chunk = rowsWithNorms.slice(chunkStart, chunkEnd);
                for (let i = 0; i < chunk.length; i += QUERY_BATCH) {
                    const sub = chunk.slice(i, i + QUERY_BATCH).filter((a) => !mergedIds.has(a.row.id));
                    if (sub.length === 0)
                        continue;
                    let candidatesByQuery;
                    try {
                        // BATCHED_ANN (1.1.8): was one vectorSearch per row
                        // (O(n) indexed queries); now up to QUERY_BATCH per call,
                        // results tagged with query_index by LanceDB.
                        candidatesByQuery = await this.findSimilarVectorsBatch(sub.map((a) => a.row.vector), scope, candidateLimit + 1);
                    }
                    catch (error) {
                        log("warn", `[consolidate] batched ANN search failed: ${error instanceof Error ? error.message : String(error)}`);
                        continue;
                    }
                    for (let k = 0; k < sub.length; k++) {
                        const a = sub[k];
                        if (mergedIds.has(a.row.id))
                            continue;
                        const candidates = candidatesByQuery[k] ?? [];
                        for (const candidate of candidates) {
                            if (candidate.id === a.row.id)
                                continue;
                            if (mergedIds.has(candidate.id))
                                continue;
                            const b = rowById.get(candidate.id);
                            if (!b)
                                continue;
                            if (mergedIds.has(b.row.id))
                                continue;
                            const sim = storeFastCosine(a.row.vector, b.row.vector, a.norm, b.norm);
                            if (flaggedIds.has(a.row.id)) {
                                bestSimByFlagged.set(a.row.id, Math.max(bestSimByFlagged.get(a.row.id) ?? -1, sim));
                            }
                            if (flaggedIds.has(b.row.id)) {
                                bestSimByFlagged.set(b.row.id, Math.max(bestSimByFlagged.get(b.row.id) ?? -1, sim));
                            }
                            if (sim < threshold)
                                continue;
                            const aMeta = metaById.get(a.row.id) ?? parseMetadata(a.row.metadataJson);
                            if (aMeta.status === "merged") {
                                localSkipped += 1;
                                continue;
                            }
                            if (a.row.lastRecalled > 0 && now - a.row.lastRecalled < FIVE_MINUTES_MS) {
                                localSkipped += 1;
                                continue;
                            }
                            const bMeta = metaById.get(b.row.id) ?? parseMetadata(b.row.metadataJson);
                            // SURVIVOR_MERGE_FIX (1.5.6): only status:"merged"
                            // (the row that LOST a previous merge) blocks being
                            // absorbed. mergedFrom marks the SURVIVOR (winner)
                            // — stamping it on every absorbed duplicate made
                            // first-generation survivors permanently immune and
                            // left every ≥0.95 duplicate cluster (survivor +
                            // survivor) unmergeable: observed 6031 candidate
                            // pairs passing every other gate, 0 writes.
                            if (bMeta.status === "merged") {
                                localSkipped += 1;
                                continue;
                            }
                            if (b.row.lastRecalled > 0 && now - b.row.lastRecalled < FIVE_MINUTES_MS) {
                                localSkipped += 1;
                                continue;
                            }
                            const older = a.row.timestamp <= b.row.timestamp ? a.row : b.row;
                            const newer = a.row.timestamp <= b.row.timestamp ? b.row : a.row;
                            if (older.id === newer.id) {
                                continue;
                            }
                            const newerMeta = parseMetadata(newer.metadataJson);
                            const mergedIntoId = newer.id;
                            const updatedOlderMeta = { status: "merged", mergedInto: mergedIntoId };
                            // CONSOLIDATE_WRITE_BATCHING (1.5.8): was one
                            // table.update() per row (2 commits per merge, up to
                            // 1350 commits for 675 merges → 126s). Both sides are
                            // now staged and flushed at the end of the run so a
                            // row touched by both a merge and a flag-clear
                            // commits exactly once (see flushConsolidationWrites;
                            // LanceDB's update applies one values object per
                            // predicate, so each distinct row still commits 1:1).
                            this.stageConsolidationWrite(older.id, {
                                status: "merged",
                                metadataJson: JSON.stringify({ ...parseMetadata(older.metadataJson), ...updatedOlderMeta }),
                            });
                            const updatedNewerMeta = { ...newerMeta, mergedFrom: older.id };
                            this.stageConsolidationWrite(newer.id, {
                                metadataJson: JSON.stringify(updatedNewerMeta),
                            });
                            this.notifyGraphMerged(older.id, newer.id);
                            mergedIds.add(older.id);
                            mergedIds.add(newer.id);
                            localMerged += 1;
                            localUpdated += 2;
                        }
                    }
                    // ISSUE3_YIELD: release the event loop every sub-batch if a
                    // slice of work exceeded the ~40ms budget. setImmediate
                    // yields at the next check rather than starving timers/I/O.
                    const sliceNow = Date.now();
                    if (sliceNow - lastYieldAt > 40) {
                        await new Promise((resolve) => setImmediate(resolve));
                        lastYieldAt = Date.now();
                    }
                }
                log("info", "consolidate:chunk", {
                    scope,
                    chunk: chunkIdx + 1,
                    total: totalChunks,
                    processed: chunkEnd,
                    merged: localMerged,
                    candidates: candidateLimit,
                    elapsedMs: Date.now() - startTime,
                });
            }
            return { merged: localMerged, updated: localUpdated, skipped: localSkipped };
        };
        const processWithFallback = async () => {
            let localMerged = 0;
            let localUpdated = 0;
            let localSkipped = 0;
            // ISSUE3_YIELD: O(N²) fallback is pure CPU — yield the event loop
            // ~every 40ms so concurrent recalls aren't starved for the whole
            // brute-force pass.
            let lastYieldAt = Date.now();
            for (let i = 0; i < rowsWithNorms.length; i += 1) {
                const a = rowsWithNorms[i];
                if (mergedIds.has(a.row.id))
                    continue;
                for (let j = i + 1; j < rowsWithNorms.length; j += 1) {
                    const b = rowsWithNorms[j];
                    if (mergedIds.has(b.row.id))
                        continue;
                    const sim = storeFastCosine(a.row.vector, b.row.vector, a.norm, b.norm);
                    if (flaggedIds.has(a.row.id)) {
                        bestSimByFlagged.set(a.row.id, Math.max(bestSimByFlagged.get(a.row.id) ?? -1, sim));
                    }
                    if (flaggedIds.has(b.row.id)) {
                        bestSimByFlagged.set(b.row.id, Math.max(bestSimByFlagged.get(b.row.id) ?? -1, sim));
                    }
                    if (sim < threshold)
                        continue;
                    const aMeta = metaById.get(a.row.id) ?? parseMetadata(a.row.metadataJson);
                    if (aMeta.status === "merged") {
                        localSkipped += 1;
                        continue;
                    }
                    if (a.row.lastRecalled > 0 && now - a.row.lastRecalled < FIVE_MINUTES_MS) {
                        localSkipped += 1;
                        continue;
                    }
                    const bMeta = metaById.get(b.row.id) ?? parseMetadata(b.row.metadataJson);
                    // SURVIVOR_MERGE_FIX (1.5.6): see ANN path — mergedFrom is
                    // the survivor marker and must not block being absorbed.
                    if (bMeta.status === "merged") {
                        localSkipped += 1;
                        continue;
                    }
                    if (b.row.lastRecalled > 0 && now - b.row.lastRecalled < FIVE_MINUTES_MS) {
                        localSkipped += 1;
                        continue;
                    }
                    const older = a.row.timestamp <= b.row.timestamp ? a.row : b.row;
                    const newer = a.row.timestamp <= b.row.timestamp ? b.row : a.row;
                    if (older.id === newer.id) {
                        continue;
                    }
                    const newerMeta = parseMetadata(newer.metadataJson);
                    const mergedIntoId = newer.id;
                    const updatedOlderMeta = { status: "merged", mergedInto: mergedIntoId };
                    // CONSOLIDATE_WRITE_BATCHING (1.5.8): see ANN path.
                    this.stageConsolidationWrite(older.id, {
                        status: "merged",
                        metadataJson: JSON.stringify({ ...parseMetadata(older.metadataJson), ...updatedOlderMeta }),
                    });
                    const updatedNewerMeta = { ...newerMeta, mergedFrom: older.id };
                    this.stageConsolidationWrite(newer.id, {
                        metadataJson: JSON.stringify(updatedNewerMeta),
                    });
                    this.notifyGraphMerged(older.id, newer.id);
                    mergedIds.add(older.id);
                    mergedIds.add(newer.id);
                    localMerged += 1;
                    localUpdated += 2;
                }
                const sliceNow = Date.now();
                if (sliceNow - lastYieldAt > 40) {
                    await new Promise((resolve) => setImmediate(resolve));
                    lastYieldAt = Date.now();
                }
            }
            return { merged: localMerged, updated: localUpdated, skipped: localSkipped };
        };
        // CONSOLIDATE_WRITES_ON_ABORT (1.6.2): staging + graph notification
        // happen WHILE a pass runs, but flushing happened only after both
        // passes completed. If the ANN pass threw mid-run and the fallback
        // was skipped (large scope) the method returned early with writes
        // still staged — a LATER run's flush then applied those stale
        // read values (the graph had already been notified at stage time),
        // or they lingered forever. The outer finally flushes whatever
        // remains staged and resets the stage on EVERY exit path; the
        // successful path's flush already cleared the stage, so the
        // defensive flush is a no-op there.
        try {
            try {
                const annResult = await processWithANN();
                mergedPairs = annResult.merged;
                updatedRecords = annResult.updated;
                skippedRecords = annResult.skipped;
            }
            catch (error) {
                log("error", `[consolidate] ANN-based consolidation failed:`, error);
                if (rows.length < FALLBACK_THRESHOLD) {
                    log("warn", `[consolidate] Falling back to O(N²) for small scope (${rows.length} memories)`);
                    const fbResult = await processWithFallback();
                    mergedPairs = fbResult.merged;
                    updatedRecords = fbResult.updated;
                    skippedRecords = fbResult.skipped;
                }
                else {
                    log("warn", `[consolidate] Skipping fallback for large scope (${rows.length} >= ${FALLBACK_THRESHOLD})`);
                    // CONSOLIDATE_WRITES_ON_ABORT (1.6.2): the early return
                    // still passes THROUGH the finally below, which flushes
                    // and resets the aborted pass's staged writes.
                    return { mergedPairs: 0, updatedRecords: 0, skippedRecords: 0, clearedFlags: 0 };
                }
            }
            // DEDUP_FLAG_REVALIDATION (1.4.0): clear false duplicate flags. Rows
            // whose best found neighbor never reached the merge threshold were
            // flagged by the pre-1.4.0 RRF write-check (or carry a flag made stale
            // by later edits); unsetting isPotentialDuplicate lets flaggedCount
            // self-correct instead of ratcheting up forever.
            for (const [id, bestSim] of bestSimByFlagged) {
                if (mergedIds.has(id) || bestSim >= threshold)
                    continue;
                const meta = metaById.get(id);
                if (!meta || meta.isPotentialDuplicate !== true)
                    continue;
                delete meta.isPotentialDuplicate;
                delete meta.duplicateOf;
                // CONSOLIDATE_WRITE_BATCHING (1.5.8): staged with merge writes.
                this.stageConsolidationWrite(id, { metadataJson: JSON.stringify(meta) });
                clearedFlags += 1;
            }
            // CONSOLIDATE_WRITE_BATCHING (1.5.8): flush all staged row updates
            // (merge losers, merge survivors, cleared duplicate flags) in batched
            // `id IN (...)` commits — one commit per ~100 rows instead of one per
            // row. Idempotent by construction: batches are disjoint, and the
            // stage is reset on entry, so a partially-processed scope re-runs
            // cleanly.
            const stagedUpdates = await this.flushConsolidationWrites();
            if (stagedUpdates > 0) {
                log("info", `[consolidate] flushed ${stagedUpdates} row updates in batched commits`);
            }
            this.resetConsolidationWriteStage();
            if (mergedPairs > 0 || clearedFlags > 0) {
                this.invalidateScope(scope);
            }
            await this.maybeOptimizeAll(false);
            return { mergedPairs, updatedRecords, skippedRecords, clearedFlags };
        }
        finally {
            // CONSOLIDATE_WRITES_ON_ABORT (1.6.2): see comment above the try.
            if (this.consolidationWriteStage && this.consolidationWriteStage.size > 0) {
                try {
                    await this.flushConsolidationWrites();
                    log("warn", `[consolidate] flushed staged writes after aborted pass`);
                }
                catch (flushError) {
                    log("warn", `[consolidate] failed to flush staged writes after abort: ${flushError instanceof Error ? flushError.message : String(flushError)}`);
                }
            }
            this.resetConsolidationWriteStage();
        }
    }
    // CONSOLIDATE_WRITE_BATCHING (1.5.8): consolidation staged row updates.
    // @internal — used by _consolidateDuplicates, reset per run.
    consolidationWriteStage = new Map();
    resetConsolidationWriteStage() {
        this.consolidationWriteStage = new Map();
    }
    stageConsolidationWrite(id, values) {
        if (!this.consolidationWriteStage) {
            this.consolidationWriteStage = new Map();
        }
        this.consolidationWriteStage.set(id, values);
    }
    async flushConsolidationWrites() {
        const stage = this.consolidationWriteStage ?? new Map();
        this.consolidationWriteStage = new Map();
        if (stage.size === 0) {
            return 0;
        }
        const table = this.requireTable();
        const ids = [...stage.keys()];
        let applied = 0;
        for (const id of ids) {
            const values = stage.get(id) ?? {};
            // LanceDB update(where, values) applies the SAME values object to
            // every matched row — row-specific metadataJson can't share one
            // values object, so each distinct row issues its own commit.
            // CONSOLIDATE_WRITE_BATCHING: stage-dedupes ids (a row touched by
            // merge + flag-clear flushes once), and flush is a single
            // guard point where a future LanceDB per-row bulk update can slot
            // in for the real 100× win. One commit per row (same as 1.5.7).
            await table.update({
                where: `id = '${escapeSql(id)}'`,
                values,
            });
            applied += 1;
        }
        return applied;
    }
    // ANN_CONSOLIDATION (1.1.7): previously this did
// query().where(scope).limit(limit).toArray() — which returns the FIRST N
// rows in scan order and only THEN ranked them. With a vector index available
// it now runs a real vectorSearch (IVF), so consolidation actually compares
// against the most-similar neighbors (probes boosted to improve recall on
// filtered queries). Without an index (small stores) it falls back to a
// CORRECT brute-force scan of the whole scope instead of a truncated one.
    // CACHE_REUSE_DEDUP (perf review): the no-index fallback in
    // findSimilarVectors/findSimilarVectorsBatch used to always issue a
    // fresh `select(["id","vector"])` scan of the whole scope — on every
    // capture's dedup check (findSimilarVectors) and every consolidation
    // batch (findSimilarVectorsBatch), until MIN_ROWS_FOR_INDEX rows exist.
    // When the scope cache already holds a fresh (version- and age-checked)
    // in-memory copy of the same rows — warm from a recent search or prior
    // capture in this scope — reuse it instead of a second full scan; the
    // norms are already precomputed too. Returns null on any cache miss so
    // callers fall back to the real query unchanged.
    getCachedVectorCandidates(scope) {
        if (!this.cacheConfig.enabled)
            return null;
        const entry = this.scopeCache.get(scope);
        if (!entry)
            return null;
        const currentVersion = this.scopeVersions.get(scope) ?? 0;
        if (entry.version !== currentVersion)
            return null;
        const maxAgeMs = Number.isFinite(this.cacheConfig.staleAfterMs) ? this.cacheConfig.staleAfterMs : 0;
        if (maxAgeMs > 0 && Date.now() - (entry.loadedAt ?? entry.lastAccessTimestamp) > maxAgeMs) {
            return null;
        }
        return entry.records.map((r) => ({
            id: r.id,
            vector: r.vector,
            norm: entry.norms.get(r.id) ?? vecNorm(r.vector),
        }));
    }
    async findSimilarVectors(queryVector, scope, limit) {
        try {
            const table = this.requireTable();
            const safeLimit = Math.max(1, Math.floor(limit) || 1);
            if (this.indexState.vector) {
                const results = await table.vectorSearch(queryVector)
                    .where(`scope = '${escapeSql(scope)}'`)
                    .nprobes(NPROBES)
                    .limit(Math.max(safeLimit, 100))
                    .toArray();
                const scored = results.map((r) => {
                    const distance = Number(r._distance);
                    const relevance = Number(r._relevance_score);
                    const sim = typeof relevance === "number" && Number.isFinite(relevance)
                        ? relevance
                        : Number.isFinite(distance) ? 1 - distance : 0;
                    // Arrow Vector → plain number[] (same normalization as normalizeRow)
                    const vec = Array.from(r.vector ?? []).map((item) => Number(item));
                    return { id: r.id, vector: vec, score: sim };
                });
                scored.sort((a, b) => b.score - a.score);
                return scored.slice(0, safeLimit);
            }
            const cachedCandidates = this.getCachedVectorCandidates(scope);
            const candidates = cachedCandidates ?? (await table.query()
                .where(`scope = '${escapeSql(scope)}'`)
                .select(["id", "vector"])
                .toArray()).map((r) => ({
                id: r.id,
                vector: Array.from(r.vector ?? []).map((item) => Number(item)),
                norm: undefined,
            }));
            const queryNorm = vecNorm(queryVector);
            const scored = candidates.map((r) => ({
                id: r.id,
                vector: r.vector,
                score: storeFastCosine(queryVector, r.vector, queryNorm, r.norm ?? vecNorm(r.vector)),
            }));
            scored.sort((a, b) => b.score - a.score);
            return scored.slice(0, safeLimit);
        }
        catch (error) {
            log("debug", `[store] findSimilarVectors failed for scope=${scope} limit=${limit}: ${error instanceof Error ? error.message : String(error)}`);
            return [];
        }
    }
    // BATCHED_ANN (1.1.8): one vectorSearch call per QUERY_BATCH vectors
    // (LanceDB tags results with query_index); no-index path reads the scope
    // once and ranks top-k for every query vector instead of N rescans.
    async findSimilarVectorsBatch(queryVectors, scope, limit) {
        const table = this.requireTable();
        const safeLimit = Math.max(1, Math.floor(limit) || 1);
        if (queryVectors.length === 0)
            return [];
        if (this.indexState.vector) {
            const results = await table.vectorSearch(queryVectors)
                .where(`scope = '${escapeSql(scope)}'`)
                .nprobes(NPROBES)
                .limit(Math.max(safeLimit, 100))
                .toArray();
            const byQuery = new Map();
            for (const r of results) {
                const qi = Number(r.query_index ?? 0);
                const distance = Number(r._distance);
                const relevance = Number(r._relevance_score);
                const sim = typeof relevance === "number" && Number.isFinite(relevance)
                    ? relevance
                    : Number.isFinite(distance) ? 1 - distance : 0;
                const vec = Array.from(r.vector ?? []).map((item) => Number(item));
                if (!byQuery.has(qi))
                    byQuery.set(qi, []);
                byQuery.get(qi).push({ id: r.id, vector: vec, score: sim });
            }
            const out = [];
            for (let i = 0; i < queryVectors.length; i++) {
                const scored = (byQuery.get(i) ?? []).slice();
                scored.sort((a, b) => b.score - a.score);
                out.push(scored.slice(0, safeLimit));
            }
            return out;
        }
        const cachedCandidates = this.getCachedVectorCandidates(scope);
        const allRows = cachedCandidates ?? (await table.query()
            .where(`scope = '${escapeSql(scope)}'`)
            .select(["id", "vector"])
            .toArray()).map((r) => ({
            id: r.id,
            vector: Array.from(r.vector ?? []).map((item) => Number(item)),
            norm: undefined,
        }));
        const out = [];
        for (const qv of queryVectors) {
            const queryNorm = vecNorm(qv);
            const scored = allRows.map((r) => ({
                id: r.id,
                vector: r.vector,
                score: storeFastCosine(qv, r.vector, queryNorm, r.norm ?? vecNorm(r.vector)),
            }));
            scored.sort((a, b) => b.score - a.score);
            out.push(scored.slice(0, safeLimit));
        }
        return out;
    }
    async countIncompatibleVectors(scopes, expectedDim) {
        const rows = await this.readByScopes(scopes);
        return rows.filter((row) => row.vectorDim !== expectedDim).length;
    }
    // ID_MATCH_TIGHTEN (1.1.7): prefix matching is only allowed for
    // sufficiently long queries (>= 8 chars of a UUID) to keep ambiguity
    // astronomically unlikely; a full 36-char UUID is exact. Sub-8-char
    // queries never match anything (previously a 2-char prefix could resolve
    // the wrong row via find()).
    matchesId(candidateId, query) {
        if (candidateId === query)
            return true;
        if (typeof query !== "string" || query.length < 8)
            return false;
        return candidateId.startsWith(query);
    }
    // FAST_PATH_USAGE_LOOKUP (perf review): zero-I/O lookup of a record
    // already sitting in the warm scope cache, for callers that just want to
    // find-by-id a row they (almost always) already retrieved via a recent
    // search. Returns null on any miss (cache absent/stale/doesn't have it)
    // so callers can fall back to a real query.
    findCachedRecordByScopes(id, scopes) {
        for (const scope of scopes) {
            const entry = this.scopeCache.get(scope);
            if (!entry)
                continue;
            // USAGE_CACHE_FRESHNESS (1.6.2): the fast path served any cached
            // row regardless of age — in the cross-process case (two opencode
            // instances on the same LanceDB dir) a STALE cache entry from
            // before another process's recallCount bump was read-modify-
            // written, REGRESSING recallCount (stale+1 overwrote the higher
            // count). Only trust cache entries fresh within staleAfterMs;
            // older ones fall through to the authoritative read.
            const maxAgeMs = Number.isFinite(this.cacheConfig.staleAfterMs) ? this.cacheConfig.staleAfterMs : 0;
            const staleByAge = maxAgeMs > 0 && Date.now() - (entry.loadedAt ?? entry.lastAccessTimestamp) > maxAgeMs;
            if (staleByAge)
                continue;
            const record = entry.records.find((row) => this.matchesId(row.id, id));
            if (record)
                return record;
        }
        return null;
    }
    async hasMemory(id, scopes) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const rows = await this.readByScopes(scopes);
            if (rows.some((row) => this.matchesId(row.id, id))) {
                return true;
            }
            if (attempt < 2) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        }
        return false;
    }
    async updateMemoryUsage(id, projectScope, scopes) {
        // MEMORY_USAGE_LOCK: index.js fires one updateMemoryUsage per recall
        // result, fire-and-forget (`.catch(() => {})`), so every result of one
        // recall — and overlapping recalls — race on the same row's
        // read-modify-write. Verified baseline: 9/10 concurrent updates lost
        // (recallCount 1/10, one recalledProjects entry instead of 10). The
        // lock is keyed on the caller-supplied id (always the full row id in
        // practice, from search results); prefix-id callers racing on the same
        // row via different prefixes would still slip past, but that is not a
        // real call pattern.
        return this.withKeyLock(`updateMemoryUsage\u0000${id}`, async () => {
            // FAST_PATH_USAGE_LOOKUP (perf review): this previously called
            // readByScopes(scopes) unconditionally — a full-column, full-scope
            // table scan — just to find one row by id. updateMemoryUsage runs
            // on every recall result of every chat turn (index.js) and,
            // worse, is awaited sequentially per result on manual
            // memory_search (tools/memory.js), so that scan's cost multiplied
            // by result count landed directly in tool latency. The caller
            // almost always just pulled this exact row out of the warm scope
            // cache moments earlier, so check that first (zero I/O), then an
            // id-bounded query (findRecordsByIds — already used by graph
            // expansion for the same reason), and only fall back to the full
            // scan (which also supports id-prefix matching) if both miss.
            let match = this.findCachedRecordByScopes(id, scopes);
            if (!match) {
                const fast = await this.findRecordsByIds([id], scopes);
                match = fast[0] ?? null;
            }
            if (!match) {
                const rows = await this.readByScopes(scopes);
                match = rows.find((row) => this.matchesId(row.id, id)) ?? null;
            }
            if (!match)
                return;
            const now = Date.now();
            const newRecallCount = match.recallCount + 1;
            let newProjectCount = match.projectCount;
            let metadataJson = match.metadataJson;
            if (match.scope === "global" && projectScope) {
                const projects = extractRecalledProjects(metadataJson);
                if (!projects.has(projectScope)) {
                    projects.add(projectScope);
                    // METADATA_MERGE_FIX (1.3.5): this previously REPLACED
                    // metadataJson with `{ recalledProjects: [...] }`, silently
                    // dropping source / isPotentialDuplicate / graphEntities /
                    // pinned on the first recall of every global memory. In the
                    // default scoping:"global" mode that hit every memory, which
                    // broke pruneScope (duplicate-flag based) and retention
                    // (pinned protections). Merge into the existing blob instead.
                    const baseMeta = parseMetadata(metadataJson);
                    if (projects.size > 100) {
                        const arr = Array.from(projects);
                        arr.splice(0, arr.length - 100);
                        baseMeta.recalledProjects = arr;
                    }
                    else {
                        baseMeta.recalledProjects = Array.from(projects);
                    }
                    metadataJson = JSON.stringify(baseMeta);
                    newProjectCount = projects.size;
                }
            }
            // ATOMIC_UPDATE_MEMORY_USAGE: previously this used table.delete() followed
            // by table.add() to simulate an update. Those are two separate non-atomic
            // ops against LanceDB's versioned/fragment storage, with no compaction
            // (table.optimize()) ever called afterward. Because updateMemoryUsage runs
            // on every recall (i.e. every chat turn), concurrent/rapid calls could
            // leave stale+new physical rows for the same id both scannable at once —
            // confirmed in practice: 4 memory ids each had 2 physical row copies after
            // normal recall traffic, none of which memory_consolidate could clean up
            // (that only merges near-duplicate CONTENT across different ids, not
            // literal same-id row duplication). table.update() is a single atomic op
            // (predicate + column values), so use that instead of delete+add.
            await this.requireTable().update({
                where: `id = '${escapeSql(match.id)}'`,
                values: {
                    lastRecalled: now,
                    recallCount: newRecallCount,
                    projectCount: newProjectCount ?? null,
                    metadataJson: metadataJson ?? null,
                },
            });
            // CACHE_PATCH_USAGE (1.4.9): this used to call invalidateScope
            // here. updateMemoryUsage fires on EVERY recall result
            // (index.js:654 auto-recall, tools/memory.js:296 manual search —
            // every LLM request in active sessions), and invalidation bumped
            // scopeVersions, so the scope cache never survived one round:
            // every getCachedScopes paid a full readByScopes + tokenize + IDF
            // + vecNorm rebuild (~150-215ms @ ~1500 rows) and recall.pipeline
            // stayed 1279-1570ms vs the 630-880ms clean baseline despite the
            // 1.4.8 TTL fix. The usage fields (lastRecalled/recallCount/
            // projectCount/metadataJson) are NOT used by _search scoring —
            // only by cleanup/prune/retention — so invalidating the search
            // cache is pure downside. Patch the cached record in place
            // instead: the cache stays hot AND consumers see fresh usage
            // counters. Real content changes still invalidate via store.put.
            const cachedEntry = this.scopeCache.get(match.scope);
            if (cachedEntry) {
                const cachedRecord = cachedEntry.records.find((record) => this.matchesId(record.id, match.id));
                if (cachedRecord) {
                    cachedRecord.lastRecalled = now;
                    cachedRecord.recallCount = newRecallCount;
                    cachedRecord.projectCount = newProjectCount ?? null;
                    if (metadataJson !== match.metadataJson) {
                        cachedRecord.metadataJson = metadataJson;
                    }
                }
            }
        });
    }
    async getCitation(id, scopes) {
        const rows = await this.readByScopes(scopes);
        const match = rows.find((row) => this.matchesId(row.id, id));
        if (!match)
            return null;
        if (!match.citationSource)
            return null;
        return {
            source: match.citationSource,
            timestamp: match.citationTimestamp ?? match.timestamp,
            status: match.citationStatus ?? "pending",
            chain: match.citationChain ?? [],
        };
    }
    async updateCitation(id, scopes, updates) {
        const rows = await this.readByScopes(scopes);
        const match = rows.find((row) => this.matchesId(row.id, id));
        if (!match)
            return false;
        const existingChain = match.citationChain ?? [];
        const currentMeta = parseMetadata(match.metadataJson);
        const newMeta = {
            ...currentMeta,
            citationStatus: updates.status,
            citationVerifiedAt: updates.status === "verified" ? Date.now() : currentMeta.citationVerifiedAt,
        };
        // CITATION_CHAIN_SERIALIZE (1.1.7): citationChain is a STRING column
        // (normalizeRow JSON.parses it on read); passing a raw array stored
        // "src" via Array.prototype.toString, so chains never survived a
        // round trip. Stringify explicitly.
        const nextChain = updates.chain ? [...existingChain, ...updates.chain] : existingChain;
        await this.requireTable().update({
            where: `id = '${escapeSql(match.id)}'`,
            values: {
                citationStatus: updates.status ?? match.citationStatus,
                citationChain: JSON.stringify(nextChain),
                metadataJson: JSON.stringify(newMeta),
            },
        });
        this.invalidateScope(match.scope);
        return true;
    }
    async validateCitation(id, scopes) {
        const citation = await this.getCitation(id, scopes);
        if (!citation) {
            return { valid: false, status: "invalid", reason: "No citation found" };
        }
        if (citation.status === "verified") {
            return { valid: true, status: "verified" };
        }
        if (citation.status === "invalid") {
            return { valid: false, status: "invalid", reason: "Citation was marked invalid" };
        }
        if (citation.status === "pending") {
            const ageMs = Date.now() - citation.timestamp;
            const autoExpireMs = 7 * 24 * 60 * 60 * 1000;
            if (ageMs > autoExpireMs) {
                await this.updateCitation(id, scopes, { status: "expired" });
                return { valid: false, status: "expired", reason: "Citation expired (pending too long)" };
            }
            return { valid: true, status: "pending" };
        }
        if (citation.status === "expired") {
            return { valid: false, status: "expired", reason: "Citation has expired" };
        }
        return { valid: false, status: citation.status, reason: "Unknown citation status" };
    }
    async explainMemory(id, scopes, currentScope, recencyHalfLifeHours = 72, globalDiscountFactor = 0.7) {
        const rows = await this.readByScopes(scopes);
        const match = rows.find((row) => this.matchesId(row.id, id));
        if (!match)
            return null;
        const now = Date.now();
        const ageHours = (now - match.timestamp) / (1000 * 60 * 60);
        const halfLifeMs = recencyHalfLifeHours * 60 * 60 * 1000;
        const decayFactor = Math.exp(-ageHours / recencyHalfLifeHours);
        const isGlobal = match.scope === "global";
        const citation = match.citationSource
            ? {
                source: match.citationSource,
                status: match.citationStatus,
                timestamp: match.citationTimestamp,
            }
            : undefined;
        const factors = {
            relevance: {
                overall: 0,
                vectorScore: 0,
                bm25Score: 0,
            },
            recency: {
                timestamp: match.timestamp,
                ageHours,
                withinHalfLife: ageHours <= recencyHalfLifeHours,
                decayFactor,
            },
            citation,
            importance: match.importance,
            scope: {
                memoryScope: match.scope,
                matchesCurrentScope: match.scope === currentScope,
                isGlobal,
            },
        };
        return {
            memoryId: match.id,
            text: match.text,
            factors,
            generatedAt: now,
        };
    }
    async refreshExpiredCitations(scope, maxAgeDays = 7) {
        const rows = await this.readByScopes([scope]);
        let expiredCount = 0;
        const cutoffTime = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
        for (const row of rows) {
            if (row.citationStatus === "pending" && row.citationTimestamp && row.citationTimestamp < cutoffTime) {
                const updated = await this.updateCitation(row.id, [scope], { status: "expired" });
                if (updated)
                    expiredCount++;
            }
        }
        return expiredCount;
    }
    async listEvents(scopes, limit) {
        const rows = await this.readEventsByScopes(scopes);
        return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    }
    async summarizeEvents(scope, includeGlobalScope) {
        const scopes = includeGlobalScope && scope !== "global" ? [scope, "global"] : [scope];
        const events = await this.readEventsByScopes(scopes);
        // Read all memories including merged for duplicate counts
        const memories = await this.readByScopesIncludingMerged(scopes);
        const captureSkipReasons = {};
        let captureConsidered = 0;
        let captureStored = 0;
        let captureSkipped = 0;
        let recallRequested = 0;
        let recallInjected = 0;
        let recallReturnedResults = 0;
        let autoRecallRequested = 0;
        let autoRecallInjected = 0;
        let autoRecallReturnedResults = 0;
        let manualRecallRequested = 0;
        let manualRecallReturnedResults = 0;
        let feedbackMissing = 0;
        let feedbackWrong = 0;
        let feedbackUsefulPositive = 0;
        let feedbackUsefulNegative = 0;
        for (const event of events) {
            if (event.type === "capture") {
                if (event.outcome === "considered")
                    captureConsidered += 1;
                if (event.outcome === "stored")
                    captureStored += 1;
                if (event.outcome === "skipped") {
                    captureSkipped += 1;
                    if (event.skipReason) {
                        captureSkipReasons[event.skipReason] = (captureSkipReasons[event.skipReason] ?? 0) + 1;
                    }
                }
            }
            if (event.type === "recall") {
                recallRequested += 1;
                if (event.resultCount > 0)
                    recallReturnedResults += 1;
                if (event.injected)
                    recallInjected += 1;
                const recallSource = event.source ?? "system-transform";
                if (recallSource === "manual-search") {
                    manualRecallRequested += 1;
                    if (event.resultCount > 0)
                        manualRecallReturnedResults += 1;
                }
                else {
                    autoRecallRequested += 1;
                    if (event.resultCount > 0)
                        autoRecallReturnedResults += 1;
                    if (event.injected)
                        autoRecallInjected += 1;
                }
            }
            if (event.type === "feedback") {
                if (event.feedbackType === "missing")
                    feedbackMissing += 1;
                if (event.feedbackType === "wrong")
                    feedbackWrong += 1;
                if (event.feedbackType === "useful") {
                    if (event.helpful)
                        feedbackUsefulPositive += 1;
                    else
                        feedbackUsefulNegative += 1;
                }
            }
        }
        const totalCaptureAttempts = captureStored + captureSkipped;
        const totalUsefulFeedback = feedbackUsefulPositive + feedbackUsefulNegative;
        // Count flagged (isPotentialDuplicate) and consolidated (status=merged) from memories table
        const flaggedCount = memories.filter((r) => {
            const meta = parseMetadata(r.metadataJson);
            return meta.isPotentialDuplicate === true;
        }).length;
        const consolidatedCount = memories.filter((r) => {
            const meta = parseMetadata(r.metadataJson);
            return meta.status === "merged";
        }).length;
        return {
            scope,
            totalEvents: events.length,
            capture: {
                considered: captureConsidered,
                stored: captureStored,
                skipped: captureSkipped,
                successRate: totalCaptureAttempts === 0 ? 0 : captureStored / totalCaptureAttempts,
                skipReasons: captureSkipReasons,
            },
            recall: {
                requested: recallRequested,
                injected: recallInjected,
                returnedResults: recallReturnedResults,
                hitRate: recallRequested === 0 ? 0 : recallReturnedResults / recallRequested,
                injectionRate: recallRequested === 0 ? 0 : recallInjected / recallRequested,
                auto: {
                    requested: autoRecallRequested,
                    injected: autoRecallInjected,
                    returnedResults: autoRecallReturnedResults,
                    hitRate: autoRecallRequested === 0 ? 0 : autoRecallReturnedResults / autoRecallRequested,
                    injectionRate: autoRecallRequested === 0 ? 0 : autoRecallInjected / autoRecallRequested,
                },
                manual: {
                    requested: manualRecallRequested,
                    returnedResults: manualRecallReturnedResults,
                    hitRate: manualRecallRequested === 0 ? 0 : manualRecallReturnedResults / manualRecallRequested,
                },
                manualRescueRatio: autoRecallRequested === 0 ? 0 : manualRecallRequested / autoRecallRequested,
            },
            feedback: {
                missing: feedbackMissing,
                wrong: feedbackWrong,
                useful: {
                    positive: feedbackUsefulPositive,
                    negative: feedbackUsefulNegative,
                    helpfulRate: totalUsefulFeedback === 0 ? 0 : feedbackUsefulPositive / totalUsefulFeedback,
                },
                falsePositiveRate: captureStored === 0 ? 0 : feedbackWrong / captureStored,
                falseNegativeRate: totalCaptureAttempts === 0 ? 0 : feedbackMissing / totalCaptureAttempts,
            },
            duplicates: {
                flaggedCount,
                consolidatedCount,
            },
        };
    }
    async getWeeklyEffectivenessSummary(scope, includeGlobalScope, days = 7) {
        const scopes = includeGlobalScope && scope !== "global" ? [scope, "global"] : [scope];
        const allEvents = await this.readEventsByScopes(scopes);
        const allMemories = await this.readByScopesIncludingMerged(scopes);
        const now = Date.now();
        const periodMs = days * 24 * 60 * 60 * 1000;
        const currentPeriodStart = now - periodMs;
        const previousPeriodStart = currentPeriodStart - periodMs;
        const currentEvents = allEvents.filter((e) => e.timestamp >= currentPeriodStart);
        const previousEvents = allEvents.filter((e) => e.timestamp >= previousPeriodStart && e.timestamp < currentPeriodStart);
        const current = this.aggregateEvents(scope, currentEvents, allMemories);
        const previous = previousEvents.length > 0 ? this.aggregateEvents(scope, previousEvents, []) : null;
        const trends = {
            captureSuccessRate: this.calculateTrend(current.capture.successRate, previous?.capture.successRate, currentEvents.length, previousEvents.length),
            recallHitRate: this.calculateTrend(current.recall.hitRate, previous?.recall.hitRate, currentEvents.length, previousEvents.length),
            feedbackHelpfulRate: this.calculateTrend(current.feedback.useful.helpfulRate, previous?.feedback.useful.helpfulRate, currentEvents.length, previousEvents.length),
        };
        const insights = this.generateInsights(current);
        const recentMemories = allMemories.filter((m) => m.timestamp >= currentPeriodStart);
        const byCategory = {};
        for (const mem of recentMemories) {
            const cat = mem.category ?? "other";
            if (!byCategory[cat]) {
                byCategory[cat] = { count: 0, samples: [] };
            }
            byCategory[cat].count += 1;
            if (byCategory[cat].samples.length < 3) {
                byCategory[cat].samples.push(mem.text.slice(0, 60));
            }
        }
        return {
            scope,
            periodDays: days,
            currentPeriodStart,
            currentPeriodEnd: now,
            previousPeriodStart,
            previousPeriodEnd: currentPeriodStart,
            current,
            previous,
            trends,
            insights,
            recentMemories: {
                total: recentMemories.length,
                byCategory,
            },
        };
    }
    aggregateEvents(scope, events, memories) {
        const captureSkipReasons = {};
        let captureConsidered = 0;
        let captureStored = 0;
        let captureSkipped = 0;
        let recallRequested = 0;
        let recallInjected = 0;
        let recallReturnedResults = 0;
        let autoRecallRequested = 0;
        let autoRecallInjected = 0;
        let autoRecallReturnedResults = 0;
        let manualRecallRequested = 0;
        let manualRecallReturnedResults = 0;
        let feedbackMissing = 0;
        let feedbackWrong = 0;
        let feedbackUsefulPositive = 0;
        let feedbackUsefulNegative = 0;
        for (const event of events) {
            if (event.type === "capture") {
                if (event.outcome === "considered")
                    captureConsidered += 1;
                if (event.outcome === "stored")
                    captureStored += 1;
                if (event.outcome === "skipped") {
                    captureSkipped += 1;
                    if (event.skipReason) {
                        captureSkipReasons[event.skipReason] = (captureSkipReasons[event.skipReason] ?? 0) + 1;
                    }
                }
            }
            if (event.type === "recall") {
                recallRequested += 1;
                if (event.resultCount > 0)
                    recallReturnedResults += 1;
                if (event.injected)
                    recallInjected += 1;
                const recallSource = event.source ?? "system-transform";
                if (recallSource === "manual-search") {
                    manualRecallRequested += 1;
                    if (event.resultCount > 0)
                        manualRecallReturnedResults += 1;
                }
                else {
                    autoRecallRequested += 1;
                    if (event.resultCount > 0)
                        autoRecallReturnedResults += 1;
                    if (event.injected)
                        autoRecallInjected += 1;
                }
            }
            if (event.type === "feedback") {
                if (event.feedbackType === "missing")
                    feedbackMissing += 1;
                if (event.feedbackType === "wrong")
                    feedbackWrong += 1;
                if (event.feedbackType === "useful") {
                    if (event.helpful)
                        feedbackUsefulPositive += 1;
                    else
                        feedbackUsefulNegative += 1;
                }
            }
        }
        const totalCaptureAttempts = captureStored + captureSkipped;
        const totalUsefulFeedback = feedbackUsefulPositive + feedbackUsefulNegative;
        const flaggedCount = memories.filter((r) => {
            const meta = parseMetadata(r.metadataJson);
            return meta.isPotentialDuplicate === true;
        }).length;
        const consolidatedCount = memories.filter((r) => {
            const meta = parseMetadata(r.metadataJson);
            return meta.status === "merged";
        }).length;
        return {
            scope,
            totalEvents: events.length,
            capture: {
                considered: captureConsidered,
                stored: captureStored,
                skipped: captureSkipped,
                successRate: totalCaptureAttempts === 0 ? 0 : captureStored / totalCaptureAttempts,
                skipReasons: captureSkipReasons,
            },
            recall: {
                requested: recallRequested,
                injected: recallInjected,
                returnedResults: recallReturnedResults,
                hitRate: recallRequested === 0 ? 0 : recallReturnedResults / recallRequested,
                injectionRate: recallRequested === 0 ? 0 : recallInjected / recallRequested,
                auto: {
                    requested: autoRecallRequested,
                    injected: autoRecallInjected,
                    returnedResults: autoRecallReturnedResults,
                    hitRate: autoRecallRequested === 0 ? 0 : autoRecallReturnedResults / autoRecallRequested,
                    injectionRate: autoRecallRequested === 0 ? 0 : autoRecallInjected / autoRecallRequested,
                },
                manual: {
                    requested: manualRecallRequested,
                    returnedResults: manualRecallReturnedResults,
                    hitRate: manualRecallRequested === 0 ? 0 : manualRecallReturnedResults / manualRecallRequested,
                },
                manualRescueRatio: autoRecallRequested === 0 ? 0 : manualRecallRequested / autoRecallRequested,
            },
            feedback: {
                missing: feedbackMissing,
                wrong: feedbackWrong,
                useful: {
                    positive: feedbackUsefulPositive,
                    negative: feedbackUsefulNegative,
                    helpfulRate: totalUsefulFeedback === 0 ? 0 : feedbackUsefulPositive / totalUsefulFeedback,
                },
                falsePositiveRate: captureStored === 0 ? 0 : feedbackWrong / captureStored,
                falseNegativeRate: totalCaptureAttempts === 0 ? 0 : feedbackMissing / totalCaptureAttempts,
            },
            duplicates: {
                flaggedCount,
                consolidatedCount,
            },
        };
    }
    calculateTrend(current, previous, currentSamples, previousSamples) {
        const MIN_SAMPLES = 5;
        if (previous === undefined || currentSamples < MIN_SAMPLES || previousSamples < MIN_SAMPLES) {
            return { direction: "insufficient-data", percentageChange: 0 };
        }
        if (previous === 0) {
            return current > 0
                ? { direction: "improving", percentageChange: 100 }
                : { direction: "stable", percentageChange: 0 };
        }
        const pctChange = ((current - previous) / previous) * 100;
        if (Math.abs(pctChange) <= 5) {
            return { direction: "stable", percentageChange: Math.round(pctChange * 10) / 10 };
        }
        const direction = pctChange > 0 ? "improving" : "declining";
        return { direction, percentageChange: Math.round(pctChange * 10) / 10 };
    }
    generateInsights(summary) {
        const insights = [];
        if (summary.recall.requested > 0 && summary.recall.hitRate < 0.5) {
            insights.push("Consider refining memory capture quality or query specificity");
        }
        if (summary.capture.considered > 0) {
            const skipRate = summary.capture.skipped / (summary.capture.stored + summary.capture.skipped);
            if (skipRate > 0.5) {
                insights.push("High skip rate may indicate duplicate content or embedding issues");
            }
        }
        if (summary.feedback.useful.positive + summary.feedback.useful.negative > 0) {
            if (summary.feedback.useful.helpfulRate < 0.7) {
                insights.push("Memory quality could improve with more explicit feedback");
            }
        }
        if (insights.length === 0) {
            insights.push("Learning effectiveness is within healthy ranges");
        }
        return insights;
    }
    getIndexHealth() {
        return {
            vector: this.indexState.vector,
            fts: this.indexState.fts,
            ftsError: this.indexState.ftsError || undefined,
            vectorRetries: this.indexState.vectorRetries,
            ftsRetries: this.indexState.ftsRetries,
            dimensionMismatch: this.indexState.dimensionMismatch,
            expectedDim: this.indexState.expectedDim,
            actualDim: this.indexState.actualDim,
        };
    }
    // DIMENSION_MISMATCH_DETECT: the "vector" column is an Arrow
    // FixedSizeList whose width is fixed forever by the first row ever
    // written to the table (LanceDB/Arrow enforce a uniform width per
    // column) — NOT by whatever `vectorDim` a later write claims in its
    // bookkeeping column. Reading it back via table.schema() is the only
    // reliable way to know the table's true, physical embedding dimension.
    async getPhysicalVectorDim() {
        const table = this.requireTable();
        const schema = await table.schema();
        const vectorField = schema.fields.find((field) => field.name === "vector");
        const listSize = vectorField?.type?.listSize;
        return typeof listSize === "number" ? listSize : null;
    }
    // DIMENSION_MISMATCH_REPAIR: a dimension mismatch is a whole-table
    // structural problem (the physical column width is table-wide, not
    // scope-scoped), so the repair must span every scope present, not just
    // the caller's current scope.
    async listDistinctScopes() {
        const table = this.requireTable();
        const rows = await table.query().select(["scope"]).limit(SCAN_LIMIT).toArray();
        return [...new Set(rows.map((row) => String(row.scope ?? "")).filter((scope) => scope.length > 0))];
    }
    invalidateScope(scope) {
        this.scopeVersions.set(scope, (this.scopeVersions.get(scope) ?? 0) + 1);
    }
    async getCachedScopes(scopes) {
        // TIMING_SPANS (1.4.7): the scope cache decides whether a search pays a
        // full table read + tokenize + IDF rebuild. spanExtra.cacheMiss marks
        // reloads so search latency can be attributed to cache misses.
        const spanExtra = {};
        const stop = startSpan("store.getCachedScopes");
        try {
            return await this._getCachedScopes(scopes, spanExtra);
        }
        finally {
            stop(spanExtra.cacheMiss !== undefined ? { cacheMiss: spanExtra.cacheMiss } : undefined);
        }
    }
    async _getCachedScopes(scopes, spanExtra = {}) {
        if (!this.cacheConfig.enabled) {
            spanExtra.cacheMiss = true;
            const allRecords = [];
            const allTokenized = [];
            const allNorms = new Map();
            for (const scope of scopes) {
                const records = await this.readByScopes([scope]);
                allRecords.push(...records);
                const tokenized = records.map((record) => tokenize(record.text));
                allTokenized.push(...tokenized);
                for (const record of records) {
                    allNorms.set(record.id, vecNorm(record.vector));
                }
            }
            const idf = computeIdf(allTokenized);
            return { records: allRecords, tokenized: allTokenized, idf, norms: allNorms, lastAccessTimestamp: Date.now() };
        }
        const allRecords = [];
        const allTokenized = [];
        const allNorms = new Map();
        for (const scope of scopes) {
            const currentVersion = this.scopeVersions.get(scope) ?? 0;
            let entry = this.scopeCache.get(scope);
            const maxAgeMs = Number.isFinite(this.cacheConfig.staleAfterMs) ? this.cacheConfig.staleAfterMs : 0;
            const staleByAge = maxAgeMs > 0 && (entry ? Date.now() - (entry.loadedAt ?? entry.lastAccessTimestamp) > maxAgeMs : false);
            if (!entry || entry.version !== currentVersion || staleByAge) {
                spanExtra.cacheMiss = true;
                if (entry) {
                    this.cacheStats.evictions++;
                }
                const records = await this.readByScopes([scope]);
                let sortedRecords = records;
                if (records.length > this.cacheConfig.maxRecordsPerScope) {
                    // RETENTION_SCORING (1.5.5): truncation used to keep only
                    // the N NEWEST records, so a valuable old memory
                    // (important, verified, positively fed back) was silently
                    // dropped from search the moment enough newer records
                    // landed — identical treatment to throwaway fragments.
                    // With retention weights configured (index.js sets them
                    // from retrieval.*), the survivors are the top-N by a
                    // composite retention score (recency × importance ×
                    // feedback × citation bonus) with timestamp as the
                    // deterministic tiebreak; "wrong" citations score -1 and
                    // are evicted first. Unconfigured stores keep the legacy
                    // recency-only behavior.
                    log("warn", `[store] scope cache truncated: ${scope} has ${records.length} records but maxRecordsPerScope=${this.cacheConfig.maxRecordsPerScope}; only the top ${this.cacheConfig.maxRecordsPerScope} by retention score are searchable until the limit is raised`);
                    if (this.retentionScoringConfig) {
                        const weights = this.retentionScoringConfig;
                        const feedbackMap = (weights.feedbackWeight ?? 0) > 0
                            ? await this.getMemoryFeedbackStatsMap(records.map((r) => r.id), [scope])
                            : new Map();
                        sortedRecords = records
                            .map((record) => ({ record, retention: computeRetentionScore(record, feedbackMap.get(record.id), weights) }))
                            .sort((a, b) => b.retention - a.retention || b.record.timestamp - a.record.timestamp)
                            .slice(0, this.cacheConfig.maxRecordsPerScope)
                            .map((s) => s.record);
                    }
                    else {
                        sortedRecords = [...records].sort((a, b) => b.timestamp - a.timestamp).slice(0, this.cacheConfig.maxRecordsPerScope);
                    }
                }
                const tokenized = sortedRecords.map((record) => tokenize(record.text));
                const idf = computeIdf(tokenized);
                const norms = new Map();
                for (const record of sortedRecords) {
                    norms.set(record.id, vecNorm(record.vector));
                }
                entry = { records: sortedRecords, tokenized, idf, norms, loadedAt: Date.now(), lastAccessTimestamp: Date.now(), version: currentVersion };
                this.scopeCache.set(scope, entry);
                this.cacheStats.misses++;
                this.enforceMaxScopes();
            }
            else {
                entry.lastAccessTimestamp = Date.now();
                this.cacheStats.hits++;
            }
            allRecords.push(...entry.records);
            allTokenized.push(...entry.tokenized);
            for (const [id, norm] of entry.norms) {
                allNorms.set(id, norm);
            }
        }
        const idf = scopes.length === 1 && this.scopeCache.has(scopes[0])
            ? this.scopeCache.get(scopes[0]).idf
            : computeIdf(allTokenized);
        const cached = { records: allRecords, tokenized: allTokenized, idf, norms: allNorms, lastAccessTimestamp: Date.now() };
        // FUZZY_CHANNEL (1.4.2): reuse the per-scope entry index when the
        // request is single-scope (the common path); multi-scope requests
        // build a merged index on each call. Threshold changes rebuild.
        if (scopes.length === 1 && this.scopeCache.has(scopes[0])) {
            const entry = this.scopeCache.get(scopes[0]);
            if (entry?.fuse) {
                cached.fuse = entry.fuse;
            }
        }
        return cached;
    }
    // FUZZY_CHANNEL (1.4.2): lazily build (and cache) the fuse.js index over
    // the records a search is about to score. Built once per scope-cache
    // entry and reused across searches; rebuilt when the threshold changes or
    // the cache entry is invalidated (the entry itself is replaced on
    // invalidation, so this never serves stale text).
    getFuzzyIndex(cached, scopes, threshold) {
        if (cached.fuse && cached.fuse.threshold === threshold) {
            return cached.fuse;
        }
        const fuse = buildFuseIndex(cached.records, threshold);
        fuse.threshold = threshold;
        cached.fuse = fuse;
        if (scopes.length === 1 && this.scopeCache.has(scopes[0])) {
            this.scopeCache.get(scopes[0]).fuse = fuse;
        }
        return fuse;
    }
    enforceMaxScopes() {
        while (this.scopeCache.size > this.cacheConfig.maxScopes) {
            let lruScope = null;
            let lruTimestamp = Infinity;
            for (const [scope, entry] of this.scopeCache) {
                if (entry.lastAccessTimestamp < lruTimestamp) {
                    lruTimestamp = entry.lastAccessTimestamp;
                    lruScope = scope;
                }
            }
            if (lruScope) {
                this.scopeCache.delete(lruScope);
                this.cacheStats.evictions++;
            }
        }
    }
    requireTable() {
        if (!this.table) {
            throw new Error("MemoryStore is not initialized");
        }
        return this.table;
    }
    requireEventTable() {
        if (!this.eventTable) {
            throw new Error("MemoryStore event table is not initialized");
        }
        return this.eventTable;
    }
    async ensureEpisodicTaskTable(vectorDim) {
        if (this.episodicTaskTable)
            return;
        if (this.episodicTaskTablePromise)
            return this.episodicTaskTablePromise;
        this.episodicTaskTablePromise = this._ensureEpisodicTaskTable();
        try {
            return await this.episodicTaskTablePromise;
        }
        finally {
            this.episodicTaskTablePromise = null;
        }
    }
    async _ensureEpisodicTaskTable() {
        const EPISODIC_TABLE_NAME = "episodic_tasks";
        try {
            this.episodicTaskTable = await this.connection.openTable(EPISODIC_TABLE_NAME);
            const schema = await this.episodicTaskTable.schema();
            const fieldNames = schema.fields.map((f) => f.name);
            if (!fieldNames.includes("taskDescriptionVector")) {
                await this.episodicTaskTable.addColumns([{ name: "taskDescriptionVector", valueSql: "NULL" }]);
            }
            // EPISODIC_SCHEMA (1.1.7): failureType/errorMessage are declared in
            // the record zod type and read by suggestRetryBudget, but never
            // existed as columns — table.add() used to silently widen the
            // schema on write, while table.update() (used since ATOMIC_UPDATE)
            // requires the column to already exist. Migrate them explicitly.
            const missingEpisodic = [];
            if (!fieldNames.includes("failureType")) {
                missingEpisodic.push({ name: "failureType", valueSql: "CAST(NULL AS STRING)" });
            }
            if (!fieldNames.includes("errorMessage")) {
                missingEpisodic.push({ name: "errorMessage", valueSql: "CAST(NULL AS STRING)" });
            }
            if (missingEpisodic.length > 0) {
                await this.episodicTaskTable.addColumns(missingEpisodic);
            }
        }
        catch {
            const bootstrap = {
                id: "__bootstrap__",
                sessionId: "",
                scope: "global",
                taskId: "",
                state: "pending",
                startTime: 0,
                endTime: 0,
                commandsJson: "[]",
                validationOutcomesJson: "[]",
                successPatternsJson: "[]",
                retryAttemptsJson: "[]",
                recoveryStrategiesJson: "[]",
                metadataJson: "{}",
                taskDescriptionVector: undefined,
                failureType: undefined,
                errorMessage: undefined,
            };
            this.episodicTaskTable = await this.connection.createTable(EPISODIC_TABLE_NAME, [bootstrap]);
            await this.episodicTaskTable.delete("id = '__bootstrap__'");
            // undefined-valued bootstrap fields are dropped by Arrow schema
            // inference, so create the nullable columns explicitly.
            await this.episodicTaskTable.addColumns([
                { name: "taskDescriptionVector", valueSql: "NULL" },
                { name: "failureType", valueSql: "CAST(NULL AS STRING)" },
                { name: "errorMessage", valueSql: "CAST(NULL AS STRING)" },
            ]);
        }
    }
    requireEpisodicTaskTable() {
        if (!this.episodicTaskTable) {
            throw new Error("MemoryStore episodic task table is not initialized");
        }
        return this.episodicTaskTable;
    }
    async createTaskEpisode(record) {
        await this.ensureEpisodicTaskTable(384);
        await this.requireEpisodicTaskTable().add([record]);
    }
    async updateTaskState(taskId, state, scope, failureType, errorMessage) {
        await this.ensureEpisodicTaskTable(384);
        const table = this.requireEpisodicTaskTable();
        const rows = await table.query().where(`taskId = '${escapeSql(taskId)}' AND scope = '${escapeSql(scope)}'`).toArray();
        if (rows.length === 0)
            return false;
        const existing = rows[0];
        // ATOMIC_UPDATE (1.1.7): was delete+add; single update commit now.
        const values = {
            state,
            failureType: failureType ?? null,
            errorMessage: errorMessage ?? null,
        };
        if (state !== "running" && state !== "pending") {
            values.endTime = Date.now();
        }
        await table.update({
            where: `id = '${escapeSql(existing.id)}'`,
            values,
        });
        return true;
    }
    async getTaskEpisode(taskId, scope) {
        await this.ensureEpisodicTaskTable(384);
        const rows = await this.requireEpisodicTaskTable()
            .query()
            .where(`taskId = '${escapeSql(taskId)}' AND scope = '${escapeSql(scope)}'`)
            .toArray();
        if (rows.length === 0)
            return null;
        return validateEpisodicRecord(rows[0]);
    }
    async queryTaskEpisodes(scope, state, sinceTimestamp) {
        await this.ensureEpisodicTaskTable(384);
        const table = this.requireEpisodicTaskTable();
        let whereClause = `scope = '${escapeSql(scope)}'`;
        if (state) {
            whereClause += ` AND state = '${escapeSql(state)}'`;
        }
        if (sinceTimestamp) {
            whereClause += ` AND startTime >= ${sinceTimestamp}`;
        }
        // EPISODE_SCAN_ORDER (1.5.0): order by startTime DESC so client-side
        // slices mean "most recent N". Older episodes remain reachable by
        // passing a larger limit (bounded here by EPISODE_SCAN_LIMIT, the
        // READ_CAP_FIX cap from 1.4.3 — memory_kpi aggregates must still see
        // every row, not just a capped prefix).
        const rows = await table.query().where(whereClause).orderBy(EPISODE_SCAN_ORDER).limit(EPISODE_SCAN_LIMIT).toArray();
        return validateEpisodicRecordArray(rows);
    }
    /**
     * Generic helper for appending items to an episodic task's JSON array field.
     * Centralizes the read-parse-push-write pattern across all add*Episode
     * methods. ATOMIC_UPDATE (1.1.7): write is a single table.update (one
     * commit) instead of read → delete → add (two commits).
     * EPISODE_WRITE_LOCK: the read-modify-write is not atomic across awaits —
     * two overlapping hook invocations (e.g. parallel bash tool calls in one
     * turn both firing tool.execute.after) both read the same baseline and the
     * second write erases the first's append (verified: 19/20 lost updates
     * under concurrent calls). Serialized per (scope, taskId) with a
     * promise-chain mutex; in-process locking suffices because every write for
     * one episode row flows through this single MemoryStore instance.
     * KEYED_WRITE_LOCK (generic form, shared with updateMemoryUsage): caller
     * supplies the lock key; the chain tail is retained so late arrivals queue
     * behind in-flight jobs and self-clean once they are the last entry.
     */
    keyedWriteLocks = new Map();
    async withKeyLock(key, fn) {
        const prev = this.keyedWriteLocks.get(key) ?? Promise.resolve();
        const job = prev.then(fn);
        const tail = job.catch(() => { });
        this.keyedWriteLocks.set(key, tail);
        try {
            return await job;
        }
        finally {
            if (this.keyedWriteLocks.get(key) === tail) {
                this.keyedWriteLocks.delete(key);
            }
        }
    }
    async withEpisodeLock(taskId, scope, fn) {
        return this.withKeyLock(`episode\u0000${scope}\u0000${taskId}`, fn);
    }
    async appendToEpisodeField(taskId, scope, fieldName, parser, serializer, newItem, itemEnricher) {
        return this.withEpisodeLock(taskId, scope, async () => {
            await this.ensureEpisodicTaskTable(384);
            const table = this.requireEpisodicTaskTable();
            const rows = await table.query().where(`taskId = '${escapeSql(taskId)}' AND scope = '${escapeSql(scope)}'`).toArray();
            if (rows.length === 0)
                return false;
            const existing = validateEpisodicRecord(rows[0]);
            const items = parser(existing[fieldName] || "[]");
            const enrichedItem = itemEnricher ? itemEnricher(newItem) : newItem;
            items.push(enrichedItem);
            await table.update({
                where: `id = '${escapeSql(existing.id)}'`,
                values: { [fieldName]: serializer(items) },
            });
            return true;
        });
    }
    async addCommandToEpisode(taskId, scope, command) {
        return this.appendToEpisodeField(taskId, scope, "commandsJson", (raw) => parseJsonObject(raw, []), (items) => JSON.stringify(items), command);
    }
    async addValidationOutcome(taskId, scope, outcome) {
        return this.appendToEpisodeField(taskId, scope, "validationOutcomesJson", (raw) => parseJsonObject(raw, []), (items) => JSON.stringify(items), outcome);
    }
    async addSuccessPatterns(taskId, scope, patterns) {
        // EPISODE_WRITE_LOCK: same read-modify-write race as appendToEpisodeField.
        return this.withEpisodeLock(taskId, scope, async () => {
            await this.ensureEpisodicTaskTable(384);
            const table = this.requireEpisodicTaskTable();
            const rows = await table.query().where(`taskId = '${escapeSql(taskId)}' AND scope = '${escapeSql(scope)}'`).toArray();
            if (rows.length === 0)
                return false;
            const existing = rows[0];
            const existingPatterns = parseJsonObject(existing.successPatternsJson, []);
            const allPatterns = [...existingPatterns, ...patterns];
            await table.update({
                where: `id = '${escapeSql(existing.id)}'`,
                values: { successPatternsJson: JSON.stringify(allPatterns) },
            });
            return true;
        });
    }
    async findSimilarTasks(scope, taskDescription, minSimilarity = 0.5) {
        await this.ensureEpisodicTaskTable(384);
        const table = this.requireEpisodicTaskTable();
        const rows = await table.query().where(`scope = '${escapeSql(scope)}' AND state = 'success'`).toArray();
        const episodes = validateEpisodicRecordArray(rows);
        // TASK_VECTOR_DEAD_CODE (1.1.7): the taskDescriptionVector branch was
        // never reachable — createTaskEpisode never writes a vector, and the
        // column is declared at 384 dims while the real embedder is 1536, so
        // `length === queryVector.length` never matched. Keyword matching is
        // the only live path; the vector branch (and its queryVector parameter)
        // is removed. Callers no longer need to embed the query — the
        // parameter's removal also deletes two wasted per-call embedder calls
        // (index.js system-transform + similar_task_recall tool).
        const keywords = taskDescription.toLowerCase().split(/\s+/).filter((k) => k.length > 2);
        const scored = episodes.map((ep) => {
            const metadata = parseJsonObject(ep.metadataJson, {});
            const description = (metadata.description || "").toLowerCase();
            const taskId = ep.taskId.toLowerCase();
            const commands = parseJsonObject(ep.commandsJson, []).join(" ").toLowerCase();
            const text = `${taskId} ${description} ${commands}`;
            let matchCount = 0;
            for (const kw of keywords) {
                if (text.includes(kw))
                    matchCount++;
            }
            const similarity = keywords.length > 0 ? matchCount / keywords.length : 0;
            return { episode: ep, similarity };
        });
        return scored
            .filter((s) => s.similarity >= minSimilarity)
            .sort((a, b) => b.similarity - a.similarity)
            .map((s) => s.episode);
    }
    async extractSuccessPatternsFromScope(scope) {
        await this.ensureEpisodicTaskTable(384);
        const table = this.requireEpisodicTaskTable();
        const rows = await table.query().where(`scope = '${escapeSql(scope)}' AND state = 'success'`).toArray();
        const episodes = validateEpisodicRecordArray(rows);
        const commandSequenceCount = new Map();
        const toolCount = new Map();
        for (const ep of episodes) {
            const commands = parseJsonObject(ep.commandsJson, []);
            if (commands.length > 0) {
                const seq = commands.join(" | ");
                commandSequenceCount.set(seq, (commandSequenceCount.get(seq) || 0) + 1);
            }
            // Extract tools from commands (simple heuristic)
            for (const cmd of commands) {
                const toolMatch = cmd.match(/^(npm|yarn|pnpm|npx|cargo|go|pytest|jest|tsc|eslint|prettier)/);
                if (toolMatch) {
                    toolCount.set(toolMatch[1], (toolCount.get(toolMatch[1]) || 0) + 1);
                }
            }
        }
        const patterns = [];
        // Create patterns from frequent command sequences
        for (const [seq, count] of commandSequenceCount) {
            const commands = seq.split(" | ");
            const confidence = Math.min(0.5 + (count * 0.1), 1.0);
            patterns.push({
                pattern: {
                    commands,
                    tools: commands.map(c => c.split(" ")[0]).filter(Boolean),
                    confidence,
                    extractedAt: Date.now(),
                },
                count,
            });
        }
        return patterns.sort((a, b) => b.count - a.count);
    }
    async addRetryAttempt(taskId, scope, attempt) {
        // RETRY_ATTEMPT_COUNT (1.3.5): was a blind push via
        // appendToEpisodeField — attemptNumber was never provided by any
        // caller, so retry_budget_suggest always saw attempts.length === 0.
        // Compute the 1-based attempt number from the existing array so the
        // retry-budget median is over real values. Also the only live writer
        // (tool.execute.after validation failures) now wired in index.js.
        // EPISODE_WRITE_LOCK: same read-modify-write race as appendToEpisodeField.
        return this.withEpisodeLock(taskId, scope, async () => {
            await this.ensureEpisodicTaskTable(384);
            const table = this.requireEpisodicTaskTable();
            const rows = await table.query().where(`taskId = '${escapeSql(taskId)}' AND scope = '${escapeSql(scope)}'`).toArray();
            if (rows.length === 0)
                return false;
            const existing = rows[0];
            const items = JSON.parse(existing.retryAttemptsJson || "[]");
            items.push({
                ...attempt,
                attemptNumber: items.length + 1,
                timestamp: Date.now(),
            });
            await table.update({
                where: `id = '${escapeSql(existing.id)}'`,
                values: { retryAttemptsJson: JSON.stringify(items) },
            });
            return true;
        });
    }
    // EPISODE_RECALL_USED (1.3.5): stamps metadata.recallUsed on the session's
    // task episode so calculateMemoryLift can separate tasks that used recall
    // from tasks that didn't (the field existed but nothing ever set it, so
    // memory_kpi always reported "no-recall-data").
    async markEpisodeRecallUsed(taskId, scope) {
        await this.ensureEpisodicTaskTable(384);
        const table = this.requireEpisodicTaskTable();
        const rows = await table.query().where(`taskId = '${escapeSql(taskId)}' AND scope = '${escapeSql(scope)}'`).toArray();
        if (rows.length === 0)
            return false;
        const existing = rows[0];
        let metadata = {};
        try {
            metadata = JSON.parse(existing.metadataJson || "{}");
        }
        catch {
            metadata = {};
        }
        metadata.recallUsed = true;
        await table.update({
            where: `id = '${escapeSql(existing.id)}'`,
            values: { metadataJson: JSON.stringify(metadata) },
        });
        return true;
    }
    async addRecoveryStrategy(taskId, scope, strategy) {
        return this.appendToEpisodeField(taskId, scope, "recoveryStrategiesJson", (raw) => parseJsonObject(raw, []), (items) => JSON.stringify(items), strategy, (item) => ({ ...item, attemptedAt: Date.now() }));
    }
    async suggestRetryBudget(scope, minSamples = 3) {
        await this.ensureEpisodicTaskTable(384);
        const table = this.requireEpisodicTaskTable();
        // EPISODE_SCAN_ORDER (1.5.0): same recency ordering as
        // queryTaskEpisodes — failedEpisodes[0] must be the MOST RECENT
        // failure (the reference error), not an arbitrary scan-order row.
        const rows = await table.query().where(`scope = '${escapeSql(scope)}' AND state = 'failed'`).orderBy(EPISODE_SCAN_ORDER).limit(EPISODE_SCAN_LIMIT).toArray();
        const failedEpisodes = validateEpisodicRecordArray(rows);
        if (failedEpisodes.length < minSamples) {
            return null;
        }
        const retryCounts = [];
        let sameErrorCount = 0;
        const firstError = failedEpisodes[0]?.errorMessage;
        for (const ep of failedEpisodes) {
            // RETRY_BUDGET_PARSE (1.4.5): retryAttemptsJson is the JSON-encoded
            // array (z.string() contract in types.js) — .length on the raw
            // string counted CHARACTERS ("[]" → 2), inflating the median into
            // triple-digit suggestedRetries and making shouldStop fire for
            // episodes that never retried. Parse defensively; a malformed row
            // is excluded from the median instead of masquerading as data.
            let attempts;
            try {
                const parsed = JSON.parse(ep.retryAttemptsJson || "[]");
                attempts = Array.isArray(parsed) ? parsed : [];
            }
            catch {
                continue;
            }
            retryCounts.push(attempts.length);
            if (ep.errorMessage === firstError && attempts.length > 0) {
                sameErrorCount++;
            }
        }
        if (retryCounts.length === 0) {
            return null;
        }
        const sorted = [...retryCounts].sort((a, b) => a - b);
        // floor(n/2) is the consistent upper-middle for both parities
        // (n=1→0, n=2→1, n=4→2, n=5→2) — the RETRY_BUDGET_PARSE test locks
        // the even-n behavior.
        const median = sorted[Math.floor(sorted.length / 2)];
        const suggestedRetries = median + 1;
        const confidence = Math.min(0.5 + (retryCounts.length * 0.1), 1.0);
        const shouldStop = sameErrorCount >= 3;
        const stopReason = shouldStop ? "Multiple retries failed with same error" : undefined;
        return {
            suggestedRetries,
            confidence,
            basedOnCount: retryCounts.length,
            shouldStop,
            stopReason,
        };
    }
    async suggestRecoveryStrategies(scope, taskId) {
        await this.ensureEpisodicTaskTable(384);
        const table = this.requireEpisodicTaskTable();
        const suggestions = [];
        const failedRows = await table.query().where(`scope = '${escapeSql(scope)}' AND state = 'failed'`).toArray();
        const failedEpisodes = validateEpisodicRecordArray(failedRows);
        const successRows = await table.query().where(`scope = '${escapeSql(scope)}' AND state = 'success'`).toArray();
        const successEpisodes = validateEpisodicRecordArray(successRows);
        if (failedEpisodes.length >= 3 && successEpisodes.length > 0) {
            const failedTaskIds = failedEpisodes.map(e => e.taskId);
            const similarSuccess = successEpisodes.find(e => {
                const eId = e.taskId.toLowerCase();
                return failedTaskIds.some(fId => eId.includes(fId) || fId.includes(eId));
            });
            if (similarSuccess) {
                const commands = parseJsonObject(similarSuccess.commandsJson, []);
                if (commands.length > 0) {
                    suggestions.push({
                        strategy: `Try: ${commands[0]}`,
                        reason: "Similar task succeeded with this approach",
                        confidence: 0.7,
                        basedOnTask: similarSuccess.taskId,
                    });
                }
            }
        }
        const recentFailed = failedEpisodes.filter(e => Date.now() - e.startTime < 3600000);
        if (recentFailed.length >= 2) {
            suggestions.push({
                strategy: "Consider exponential backoff",
                reason: "Multiple failures in short timeframe",
                confidence: 0.6,
            });
        }
        return suggestions;
    }
    async calculateRetryToSuccessRate(scope, days = 30) {
        const sinceTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;
        const failedTasks = await this.queryTaskEpisodes(scope, "failed", sinceTimestamp);
        const successTasks = await this.queryTaskEpisodes(scope, "success", sinceTimestamp);
        if (failedTasks.length === 0) {
            return { status: "no-failed-tasks", rate: 0, totalFailedTasks: 0, succeededAfterRetry: 0, sampleCount: 0 };
        }
        const totalFailed = failedTasks.length;
        const succeededAfterRetry = successTasks.filter((t) => {
            // RETRY_TO_SUCCESS_PARSE (1.6.2): unguarded JSON.parse — one
            // malformed retryAttemptsJson row made memory_kpi throw
            // (suggestRetryBudget got the same guard in RETRY_BUDGET_PARSE
            // (1.4.5); this path didn't). Malformed or non-array rows are
            // treated as no attempts.
            let retries = [];
            try {
                const parsed = JSON.parse(t.retryAttemptsJson || "[]");
                if (Array.isArray(parsed))
                    retries = parsed;
            }
            catch { /* malformed row: no attempts */ }
            return retries.some((r) => r.outcome === "success");
        }).length;
        const sampleCount = totalFailed + succeededAfterRetry;
        if (sampleCount < 5) {
            return { status: "insufficient-data", rate: 0, totalFailedTasks: totalFailed, succeededAfterRetry, sampleCount };
        }
        const rate = totalFailed > 0 ? succeededAfterRetry / totalFailed : 0;
        return { status: "ok", rate, totalFailedTasks: totalFailed, succeededAfterRetry, sampleCount };
    }
    async calculateMemoryLift(scope, days = 30) {
        const sinceTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;
        const allTasks = await this.queryTaskEpisodes(scope, undefined, sinceTimestamp);
        const withRecall = [];
        const withoutRecall = [];
        for (const task of allTasks) {
            const usedRecall = this.taskUsedRecall(task);
            const isSuccess = task.state === "success";
            if (usedRecall) {
                withRecall.push({ success: isSuccess });
            }
            else {
                withoutRecall.push({ success: isSuccess });
            }
        }
        if (withRecall.length === 0) {
            return { status: "no-recall-data", lift: 0, successRateWithRecall: 0, successRateWithoutRecall: 0, withRecallCount: 0, withoutRecallCount: withoutRecall.length };
        }
        if (withRecall.length < 5 || withoutRecall.length < 5) {
            return { status: "insufficient-data", lift: 0, successRateWithRecall: 0, successRateWithoutRecall: 0, withRecallCount: withRecall.length, withoutRecallCount: withoutRecall.length };
        }
        const rateWith = withRecall.filter((t) => t.success).length / withRecall.length;
        const rateWithout = withoutRecall.length > 0 ? withoutRecall.filter((t) => t.success).length / withoutRecall.length : 0;
        const lift = rateWithout > 0 ? (rateWith - rateWithout) / rateWithout : 0;
        return { status: "ok", lift, successRateWithRecall: rateWith, successRateWithoutRecall: rateWithout, withRecallCount: withRecall.length, withoutRecallCount: withoutRecall.length };
    }
    taskUsedRecall(task) {
        const metadata = parseMetadata(task.metadataJson);
        if (metadata.recallUsed === true)
            return true;
        try {
            const outcomes = JSON.parse(task.validationOutcomesJson || "[]");
            return outcomes.some((o) => o.type === "recall");
        }
        catch {
            return false;
        }
    }
    async getKpiSummary(scope, days = 30) {
        const retryToSuccess = await this.calculateRetryToSuccessRate(scope, days);
        const memoryLift = await this.calculateMemoryLift(scope, days);
        return {
            scope,
            periodDays: days,
            retryToSuccess,
            memoryLift,
        };
    }
    async readEventsByScopes(scopes) {
        const table = this.requireEventTable();
        if (scopes.length === 0)
            return [];
        const whereExpr = scopes.map((scope) => `scope = '${escapeSql(scope)}'`).join(" OR ");
        const rows = await table
            .query()
            .where(`(${whereExpr})`)
            .select([
            "id",
            "type",
            "scope",
            "sessionID",
            "timestamp",
            "memoryId",
            "text",
            "outcome",
            "skipReason",
            "resultCount",
            "injected",
            "source",
            "feedbackType",
            "helpful",
            "reason",
            "labelsJson",
            "metadataJson",
            "sourceSessionId",
            "confidenceDelta",
            "relatedMemoryId",
            "context",
        ])
            .orderBy(SCAN_ORDER)
            .limit(SCAN_LIMIT)
            .toArray();
        return rows
            .map((row) => normalizeEventRow(row))
            .filter((row) => row !== null);
    }
    /**
     * Get feedback stats for a set of memory IDs.
     * Returns a map of memoryId -> feedback stats.
     * Only considers feedback within the last 30 days.
     */
    // FEEDBACK_STATS_CACHE (perf review): getMemoryFeedbackStatsMap used to
    // build a fresh `memoryId = 'x' OR memoryId = 'y' OR ...` clause sized to
    // the ENTIRE candidate set (up to maxRecordsPerScope, default 1000) and
    // re-query the events table for it on every _search call — and
    // feedbackWeight defaults to 0.3 (on), so this ran on every recall turn
    // and every manual memory_search, uncached, unlike the vector/BM25/fuzzy
    // channels which reuse the scope cache. The scope+type+timestamp filter
    // alone already bounds the row count to actual feedback event volume,
    // independent of candidate count, so cache the per-scope raw aggregate
    // (not the derived rate/factor, since multi-scope calls need to sum raw
    // counts across scopes before deriving those) and filter to the
    // requested memoryIds in memory afterward — zero behavior change, just
    // fewer/cheaper queries.
    async computeFeedbackStatsForScope(scope) {
        const rawStats = new Map();
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const table = this.requireEventTable();
        const rows = await table
            .query()
            .where(`scope = '${escapeSql(scope)}' AND type = 'feedback' AND timestamp >= ${thirtyDaysAgo}`)
            .select([
            "memoryId",
            "feedbackType",
            "helpful",
        ])
            .orderBy(SCAN_ORDER)
            .limit(this.feedbackStatsScanLimit)
            .toArray();
        for (const row of rows) {
            const memoryId = row.memoryId;
            const feedbackType = row.feedbackType;
            const helpful = row.helpful;
            if (!rawStats.has(memoryId)) {
                rawStats.set(memoryId, { helpful: 0, unhelpful: 0, wrong: 0 });
            }
            const stats = rawStats.get(memoryId);
            if (feedbackType === "wrong") {
                stats.wrong += 1;
            }
            else if (feedbackType === "useful") {
                if (helpful === 1) {
                    stats.helpful += 1;
                }
                else if (helpful === 0) {
                    stats.unhelpful += 1;
                }
            }
        }
        return rawStats;
    }
    async getFeedbackStatsForScope(scope) {
        if (!this.cacheConfig.enabled) {
            return await this.computeFeedbackStatsForScope(scope);
        }
        const currentVersion = this.feedbackVersions.get(scope) ?? 0;
        const cached = this.feedbackStatsCache.get(scope);
        const maxAgeMs = Number.isFinite(this.cacheConfig.staleAfterMs) ? this.cacheConfig.staleAfterMs : 0;
        const staleByAge = maxAgeMs > 0 && cached ? Date.now() - cached.loadedAt > maxAgeMs : false;
        if (cached && cached.version === currentVersion && !staleByAge) {
            cached.lastAccessTimestamp = Date.now();
            return cached.rawStats;
        }
        const rawStats = await this.computeFeedbackStatsForScope(scope);
        this.feedbackStatsCache.set(scope, {
            rawStats,
            version: currentVersion,
            loadedAt: Date.now(),
            lastAccessTimestamp: Date.now(),
        });
        this.enforceMaxFeedbackScopes();
        return rawStats;
    }
    enforceMaxFeedbackScopes() {
        while (this.feedbackStatsCache.size > this.cacheConfig.maxScopes) {
            let lruScope = null;
            let lruTimestamp = Infinity;
            for (const [scope, entry] of this.feedbackStatsCache) {
                if (entry.lastAccessTimestamp < lruTimestamp) {
                    lruTimestamp = entry.lastAccessTimestamp;
                    lruScope = scope;
                }
            }
            if (lruScope) {
                this.feedbackStatsCache.delete(lruScope);
            }
        }
    }
    async getMemoryFeedbackStatsMap(memoryIds, scopes) {
        const feedbackStats = new Map();
        if (memoryIds.length === 0 || scopes.length === 0)
            return feedbackStats;
        const idSet = new Set(memoryIds);
        const rawTotals = new Map();
        for (const scope of scopes) {
            const perScope = await this.getFeedbackStatsForScope(scope);
            for (const [memoryId, stats] of perScope) {
                if (!idSet.has(memoryId))
                    continue;
                const totals = rawTotals.get(memoryId) ?? { helpful: 0, unhelpful: 0, wrong: 0 };
                totals.helpful += stats.helpful;
                totals.unhelpful += stats.unhelpful;
                totals.wrong += stats.wrong;
                rawTotals.set(memoryId, totals);
            }
        }
        // Calculate feedback factor for each memory
        for (const [memoryId, stats] of rawTotals) {
            const totalFeedback = stats.helpful + stats.unhelpful;
            const helpfulRate = totalFeedback > 0 ? stats.helpful / totalFeedback : 0.5; // Neutral if no feedback
            const wrongPenalty = Math.min(0.3, stats.wrong * 0.1);
            const feedbackFactor = 1 + (helpfulRate - 0.5) * 2 - wrongPenalty;
            feedbackStats.set(memoryId, {
                memoryId,
                helpful: stats.helpful,
                unhelpful: stats.unhelpful,
                wrong: stats.wrong,
                helpfulRate,
                feedbackFactor,
            });
        }
        return feedbackStats;
    }
    async readByScopesIncludingMerged(scopes) {
        const table = this.requireTable();
        if (scopes.length === 0)
            return [];
        const whereExpr = scopes.map((scope) => `scope = '${escapeSql(scope)}'`).join(" OR ");
        const rows = await table
            .query()
            .where(`(${whereExpr})`)
            .select([
            "id",
            "text",
            "vector",
            "category",
            "scope",
            "importance",
            "timestamp",
            "lastRecalled",
            "recallCount",
            "projectCount",
            "schemaVersion",
            "embeddingModel",
            "vectorDim",
            "metadataJson",
            "userId",
            "teamId",
            "sourceSessionId",
            "confidence",
            "tags",
            "status",
            "parentId",
            "citationSource",
            "citationTimestamp",
            "citationStatus",
            "citationChain",
        ])
            .orderBy(SCAN_ORDER)
            .limit(SCAN_LIMIT)
            .toArray();
        return rows
            .map((row) => normalizeRow(row))
            .filter((row) => row !== null);
    }
    // GRAPH_STORE_PHASE2B: fetch full records for a small id set (graph
    // expansion candidates) — same normalization + status filtering as
    // readByScopes, but the query is bounded by id instead of scanning the
    // whole scope, so a recall never pays for a full-scope read.
    async findRecordsByIds(ids, scopes) {
        const unique = ids && ids.length > 0 ? [...new Set(ids)] : [];
        if (unique.length === 0 || !scopes || scopes.length === 0)
            return [];
        const table = this.requireTable();
        const idExpr = unique.map((id) => `id = '${escapeSql(id)}'`).join(" OR ");
        const whereExpr = scopes.map((scope) => `scope = '${escapeSql(scope)}'`).join(" OR ");
        const rows = await table
            .query()
            .where(`(${idExpr}) AND (${whereExpr}) AND (status != 'disabled' OR status IS NULL OR status = '') AND NOT (status = 'merged') AND NOT (status = 'digested') AND NOT (metadataJson LIKE '%"status":"merged"%')`)
            .select([
            "id",
            "text",
            "vector",
            "category",
            "scope",
            "importance",
            "timestamp",
            "lastRecalled",
            "recallCount",
            "projectCount",
            "schemaVersion",
            "embeddingModel",
            "vectorDim",
            "metadataJson",
            "userId",
            "teamId",
            "sourceSessionId",
            "confidence",
            "tags",
            "status",
            "parentId",
            "citationSource",
            "citationTimestamp",
            "citationStatus",
            "citationChain",
        ])
            .limit(unique.length)
            .toArray();
        return rows
            .map((row) => normalizeRow(row))
            .filter((row) => row !== null);
    }
    // MEMORY_LIFECYCLE_TOOLS: export/import/summarize support (0.9).
    // exportAllRecords — full-fidelity dump of EVERY row in the given scopes,
    // including disabled / merged / digested. This is the ONLY read path that
    // does not filter on status (a backup must capture everything).
    async exportAllRecords(scopes) {
        const table = this.requireTable();
        if (scopes.length === 0)
            return [];
        const whereExpr = scopes.map((scope) => `scope = '${escapeSql(scope)}'`).join(" OR ");
        const rows = await table
            .query()
            .where(`(${whereExpr})`)
            .select([
            "id",
            "text",
            "vector",
            "category",
            "scope",
            "importance",
            "timestamp",
            "lastRecalled",
            "recallCount",
            "projectCount",
            "schemaVersion",
            "embeddingModel",
            "vectorDim",
            "metadataJson",
            "userId",
            "teamId",
            "sourceSessionId",
            "confidence",
            "tags",
            "status",
            "parentId",
            "citationSource",
            "citationTimestamp",
            "citationStatus",
            "citationChain",
        ])
            .orderBy(SCAN_ORDER)
            .toArray();
        return rows
            .map((row) => normalizeRow(row))
            .filter((row) => row !== null);
    }
    // findRawRecordsByIds — id-bounded fetch with NO status filtering (raw
    // rows, used by markDigested / import-replace, which must see rows that
    // the filtered read paths hide).
    async findRawRecordsByIds(ids, scopes) {
        const unique = ids && ids.length > 0 ? [...new Set(ids)] : [];
        if (unique.length === 0 || !scopes || scopes.length === 0)
            return [];
        const table = this.requireTable();
        const idExpr = unique.map((id) => `id = '${escapeSql(id)}'`).join(" OR ");
        const whereExpr = scopes.map((scope) => `scope = '${escapeSql(scope)}'`).join(" OR ");
        const rows = await table
            .query()
            .where(`(${idExpr}) AND (${whereExpr})`)
            .select([
            "id",
            "text",
            "vector",
            "category",
            "scope",
            "importance",
            "timestamp",
            "lastRecalled",
            "recallCount",
            "projectCount",
            "schemaVersion",
            "embeddingModel",
            "vectorDim",
            "metadataJson",
            "userId",
            "teamId",
            "sourceSessionId",
            "confidence",
            "tags",
            "status",
            "parentId",
            "citationSource",
            "citationTimestamp",
            "citationStatus",
            "citationChain",
        ])
            .limit(unique.length)
            .toArray();
        return rows
            .map((row) => normalizeRow(row))
            .filter((row) => row !== null);
    }
    // markDigested — flip N memories to status "digested" (hidden from recall)
    // and stamp metadata with which digest absorbed them. Atomic per-row
    // table.update, matches the ATOMIC_UPDATE_MEMORY_USAGE pattern.
    async markDigested(ids, digestId, scopes) {
        const unique = ids && ids.length > 0 ? [...new Set(ids)] : [];
        if (unique.length === 0 || !digestId || !scopes || scopes.length === 0)
            return 0;
        const existing = await this.findRawRecordsByIds(unique, scopes);
        let updated = 0;
        for (const record of existing) {
            let metadata = {};
            try {
                metadata = JSON.parse(record.metadataJson || "{}");
            }
            catch {
                metadata = {};
            }
            metadata.digestedInto = digestId;
            metadata.digestedAt = Date.now();
            await this.requireTable().update({
                where: `id = '${escapeSql(record.id)}'`,
                values: { status: "digested", metadataJson: JSON.stringify(metadata) },
            });
            this.invalidateScope(record.scope);
            updated += 1;
            this.notifyGraphRemoved(record.id);
        }
        return updated;
    }
    // DIGEST_EXPIRY_RESTORE (1.6.2): when a digest is HARD-deleted after
    // digestMaxAgeDays (sweepExpiredMemories), its digested originals used to
    // stay status:"digested" with digestedInto pointing at the deleted id —
    // permanently hidden from recall with no restore path. Restore them
    // (status active + metadata flags cleared + graph links re-indexed) so
    // the originals become recallable again; a later sweep may re-digest
    // them if they still qualify. Returns the number of restored memories.
    async unDigestOriginals(digestId, scopes) {
        if (!digestId)
            return 0;
        const table = this.requireTable();
        const filter = `metadataJson LIKE '%"digestedInto":"${escapeSql(digestId)}"%'`;
        const fullFilter = Array.isArray(scopes) && scopes.length > 0
            ? `(${filter}) AND (${scopes.map((scope) => `scope = '${escapeSql(scope)}'`).join(" OR ")})`
            : filter;
        const rows = await table.query().where(fullFilter).limit(SCAN_LIMIT).toArray();
        let restored = 0;
        for (const record of rows) {
            let metadata = {};
            try {
                metadata = JSON.parse(record.metadataJson || "{}");
            }
            catch {
                metadata = {};
            }
            delete metadata.digestedInto;
            delete metadata.digestedAt;
            await table.update({
                where: `id = '${escapeSql(record.id)}'`,
                values: { status: "active", metadataJson: JSON.stringify(metadata) },
            });
            this.invalidateScope(record.scope);
            // Restore graph links (notifyGraphRemoved stripped them at
            // digest time) so recall boost/expand see the originals again.
            try {
                this.graph?.indexMemory(record.id, record.text, record.timestamp ?? Date.now());
            }
            catch (error) {
                log("warn", `[store] graph indexMemory during un-digest failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            restored += 1;
        }
        return restored;
    }
    async readByScopes(scopes) {
        const table = this.requireTable();
        if (scopes.length === 0)
            return [];
        const whereExpr = scopes.map((scope) => `scope = '${escapeSql(scope)}'`).join(" OR ");
        const rows = await table
            .query()
            .where(`(${whereExpr}) AND (status != 'disabled' OR status IS NULL OR status = '') AND NOT (status = 'merged') AND NOT (status = 'digested') AND NOT (metadataJson LIKE '%"status":"merged"%')`)
            .select([
            "id",
            "text",
            "vector",
            "category",
            "scope",
            "importance",
            "timestamp",
            "lastRecalled",
            "recallCount",
            "projectCount",
            "schemaVersion",
            "embeddingModel",
            "vectorDim",
            "metadataJson",
            "userId",
            "teamId",
            "sourceSessionId",
            "confidence",
            "tags",
            "status",
            "parentId",
            "citationSource",
            "citationTimestamp",
            "citationStatus",
            "citationChain",
        ])
            .orderBy(SCAN_ORDER)
            .limit(SCAN_LIMIT)
            .toArray();
        return rows
            .map((row) => normalizeRow(row))
            .filter((row) => row !== null);
    }
    // GRAPH_BACKFILL_ALL (1.3.5): the one-time graph backfill previously
    // read only ["global"], so project-scoped memories (scoping:"project")
    // never entered the entity graph. Reads every active row across ALL
    // scopes with the same status filter as readByScopes.
    async readAllActive() {
        const table = this.requireTable();
        const rows = await table
            .query()
            .where(`(status != 'disabled' OR status IS NULL OR status = '') AND NOT (status = 'merged') AND NOT (status = 'digested') AND NOT (metadataJson LIKE '%"status":"merged"%')`)
            .select([
            "id",
            "text",
            "vector",
            "category",
            "scope",
            "importance",
            "timestamp",
            "lastRecalled",
            "recallCount",
            "projectCount",
            "schemaVersion",
            "embeddingModel",
            "vectorDim",
            "metadataJson",
            "userId",
            "teamId",
            "sourceSessionId",
            "confidence",
            "tags",
            "status",
            "parentId",
            "citationSource",
            "citationTimestamp",
            "citationStatus",
            "citationChain",
        ])
            .orderBy(SCAN_ORDER)
            .limit(SCAN_LIMIT)
            .toArray();
        return rows
            .map((row) => normalizeRow(row))
            .filter((row) => row !== null);
    }
    async ensureIndexes() {
        const table = this.requireTable();
        // INDEX_USAGE_FIX (1.1.7): the FTS "text" index was created here but
        // NO code path ever issued an ftsSearch()/fullTextSearch() against it
        // (all search runs in-memory over the scope cache), so it was pure
        // build + per-write rebuild overhead. Removed. The vector index IS
        // consumed by findSimilarVectors (consolidation ANN), so it stays.
        await this.createVectorIndexWithRetry(table);
    }
    /**
     * Returns true if the error message indicates a LanceDB retryable commit conflict,
     * meaning another concurrent process may have already created the same index.
     */
    isCommitConflict(errorMsg) {
        return (errorMsg.includes("Retryable commit conflict") ||
            errorMsg.includes("preempted by concurrent transaction"));
    }
    /**
     * Create vector index with exponential backoff retry and existence check.
     * Handles concurrent-process commit conflicts by re-verifying index existence
     * after each conflict error, and adds jitter to avoid thundering-herd re-collision.
     */
    async createVectorIndexWithRetry(table) {
        const maxRetries = 3;
        const baseDelay = 500;
        const existingIndices = await table.listIndices();
        if (existingIndices.some(idx => idx.name.startsWith("vector"))) {
            log("info", "[store] Vector index already exists, skipping creation");
            this.indexState.vector = true;
            return;
        }
        const rowCount = await table.countRows();
        if (rowCount < MemoryStore.MIN_ROWS_FOR_INDEX) {
            log("debug", `[store] Vector index deferral (below ${MemoryStore.MIN_ROWS_FOR_INDEX}): ${rowCount} rows`);
            log("info", `[store] Deferring vector index creation: ${rowCount} rows found (need ≥ ${MemoryStore.MIN_ROWS_FOR_INDEX})`);
            this.indexState.vector = false;
            return;
        }
        log("debug", `[store] Vector index creation eligible: ${rowCount} rows (min ${MemoryStore.MIN_ROWS_FOR_INDEX})`);
        let lastErrorMsg = "";
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            this.indexState.vectorRetries = attempt + 1;
            const attemptStart = Date.now();
            try {
                // Scale IVF partitions to dataset size (sqrt heuristic). LanceDB's
                // 256-partition default trains 256-way KMeans even on tiny stores,
                // producing "more than 10% of clusters are empty" warnings.
                const numPartitions = Math.min(256, Math.max(4, Math.pow(2, Math.round(Math.log2(Math.sqrt(rowCount))))));
                if (this.lancedb && "Index" in this.lancedb) {
                    const anyLance = this.lancedb;
                    const cfg = anyLance.Index?.ivfPq
                        ? { config: anyLance.Index.ivfPq({ numPartitions }) }
                        : undefined;
                    await table.createIndex("vector", cfg);
                }
                else {
                    await table.createIndex("vector");
                }
                log("debug", `[store] Vector index createIndex returned on attempt ${attempt + 1} in ${Date.now() - attemptStart}ms (${numPartitions} partitions)`);
                log("info", `[store] Vector index created successfully on attempt ${attempt + 1}`);
                this.indexState.vector = true;
                return;
            }
            catch (error) {
                lastErrorMsg = error instanceof Error ? error.message : String(error);
                log("debug", `[store] Vector index createIndex attempt ${attempt + 1}/${maxRetries} failed after ${Date.now() - attemptStart}ms: ${lastErrorMsg}`);
                // Commit conflict: another process may have just created the index — re-verify.
                if (this.isCommitConflict(lastErrorMsg)) {
                    const updatedIndices = await table.listIndices();
                    if (updatedIndices.some(idx => idx.name.startsWith("vector"))) {
                        log("info", `[store] Vector index created by concurrent process, adopting it (attempt ${attempt + 1})`);
                        this.indexState.vector = true;
                        return;
                    }
                }
                if (attempt < maxRetries - 1) {
                    // Jitter prevents thundering-herd re-collision among concurrent processes.
                    const delay = baseDelay * Math.pow(2, attempt) + Math.random() * baseDelay;
                    log("debug", `[store] Vector index retry ${attempt + 1}/${maxRetries} scheduled in ${Math.round(delay)}ms`);
                    log("warn", `[store] Vector index creation failed (attempt ${attempt + 1}/${maxRetries}): ${lastErrorMsg}. Retrying in ${Math.round(delay)}ms...`);
                    await new Promise((resolve) => setTimeout(resolve, delay));
                }
            }
        }
        // Final-pass existence check: the last retry's conflict may have caused another
        // process to succeed even though our own call threw.
        const finalIndices = await table.listIndices();
        if (finalIndices.some(idx => idx.name.startsWith("vector"))) {
            log("info", "[store] Vector index found on final check (created by concurrent process), adopting it");
            this.indexState.vector = true;
            return;
        }
        log("error", `[store] Vector index creation failed after ${maxRetries} attempts: ${lastErrorMsg}. Falling back to in-memory search.`);
        this.indexState.vector = false;
    }
    /**
     * FTS index creation was removed in 1.1.7 (INDEX_USAGE_FIX): nothing in
     * the codebase ever ran an ftsSearch()/fullTextSearch(), so the "text"
     * index was dead weight (build cost + per-write index maintenance).
     * indexState.fts fields are retained for getIndexHealth() consumers.
     */
    async ensureMemoriesTableCompatibility() {
        const table = this.requireTable();
        const schema = await table.schema();
        const fieldNames = new Set(schema.fields.map((field) => field.name));
        const missing = [];
        if (!fieldNames.has("lastRecalled")) {
            missing.push({ name: "lastRecalled", valueSql: "CAST(0 AS BIGINT)" });
        }
        if (!fieldNames.has("recallCount")) {
            missing.push({ name: "recallCount", valueSql: "CAST(0 AS INT)" });
        }
        if (!fieldNames.has("projectCount")) {
            missing.push({ name: "projectCount", valueSql: "CAST(0 AS INT)" });
        }
        if (!fieldNames.has("userId")) {
            missing.push({ name: "userId", valueSql: "CAST(NULL AS STRING)" });
        }
        if (!fieldNames.has("teamId")) {
            missing.push({ name: "teamId", valueSql: "CAST(NULL AS STRING)" });
        }
        if (!fieldNames.has("sourceSessionId")) {
            missing.push({ name: "sourceSessionId", valueSql: "CAST(NULL AS STRING)" });
        }
        if (!fieldNames.has("confidence")) {
            missing.push({ name: "confidence", valueSql: "CAST(NULL AS DOUBLE)" });
        }
        if (!fieldNames.has("tags")) {
            missing.push({ name: "tags", valueSql: "CAST(NULL AS STRING)" });
        }
        if (!fieldNames.has("status")) {
            missing.push({ name: "status", valueSql: "CAST('active' AS STRING)" });
        }
        if (!fieldNames.has("parentId")) {
            missing.push({ name: "parentId", valueSql: "CAST(NULL AS STRING)" });
        }
        if (!fieldNames.has("citationSource")) {
            missing.push({ name: "citationSource", valueSql: "CAST(NULL AS STRING)" });
        }
        if (!fieldNames.has("citationTimestamp")) {
            missing.push({ name: "citationTimestamp", valueSql: "CAST(NULL AS BIGINT)" });
        }
        if (!fieldNames.has("citationStatus")) {
            missing.push({ name: "citationStatus", valueSql: "CAST(NULL AS STRING)" });
        }
        if (!fieldNames.has("citationChain")) {
            missing.push({ name: "citationChain", valueSql: "CAST(NULL AS STRING)" });
        }
        if (missing.length === 0) {
            return;
        }
        try {
            await table.addColumns(missing);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const names = missing.map((col) => col.name).join(", ");
            throw new Error(`Failed to patch ${TABLE_NAME} schema for columns [${names}]: ${reason}`);
        }
    }
    async ensureEventTableCompatibility() {
        const table = this.requireEventTable();
        const schema = await table.schema();
        const fieldNames = new Set(schema.fields.map((field) => field.name));
        const missing = [];
        if (!fieldNames.has(EVENTS_SOURCE_COLUMN)) {
            missing.push({ name: EVENTS_SOURCE_COLUMN, valueSql: "CAST(NULL AS STRING)" });
        }
        if (!fieldNames.has("sourceSessionId")) {
            missing.push({ name: "sourceSessionId", valueSql: "CAST(NULL AS STRING)" });
        }
        if (!fieldNames.has("confidenceDelta")) {
            missing.push({ name: "confidenceDelta", valueSql: "CAST(NULL AS DOUBLE)" });
        }
        if (!fieldNames.has("relatedMemoryId")) {
            missing.push({ name: "relatedMemoryId", valueSql: "CAST(NULL AS STRING)" });
        }
        if (!fieldNames.has("context")) {
            missing.push({ name: "context", valueSql: "CAST(NULL AS STRING)" });
        }
        if (missing.length === 0) {
            return;
        }
        try {
            await table.addColumns(missing);
        }
        catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            const names = missing.map((col) => col.name).join(", ");
            throw new Error(`Failed to patch ${EVENTS_TABLE_NAME} schema for columns [${names}]: ${reason}`);
        }
    }
}
function normalizeRow(row) {
    const vectorRaw = row.vector;
    const vector = Array.isArray(vectorRaw) ? vectorRaw.map((item) => Number(item)) : Array.from((vectorRaw ?? []));
    if (typeof row.id !== "string" || typeof row.text !== "string" || typeof row.scope !== "string") {
        return null;
    }
    const tagsRaw = row.tags;
    // TAGS_PARSE_GUARD: tags is a STRING column, but a legacy/lossy write can
    // leave a non-JSON string here ("a,b" via Array.prototype.toString).
    // JSON.parse must never throw out of normalizeRow — that would take down
    // every readByScopes-based read for the whole table. Fall back to undefined
    // (same pattern as the citationChain parse below).
    const parsedTags = (() => {
        if (typeof tagsRaw === "string" && tagsRaw.length > 0) {
            try {
                return JSON.parse(tagsRaw);
            }
            catch {
                return undefined;
            }
        }
        return Array.isArray(tagsRaw) ? tagsRaw : undefined;
    })();
    return {
        id: row.id,
        text: row.text,
        vector,
        category: row.category ?? "other",
        scope: row.scope,
        importance: Number(row.importance ?? 0.5),
        timestamp: Number(row.timestamp ?? Date.now()),
        lastRecalled: Number(row.lastRecalled ?? 0),
        recallCount: Number(row.recallCount ?? 0),
        projectCount: Number(row.projectCount ?? 0),
        schemaVersion: Number(row.schemaVersion ?? 1),
        embeddingModel: String(row.embeddingModel ?? "unknown"),
        vectorDim: Number(row.vectorDim ?? vector.length),
        metadataJson: String(row.metadataJson ?? "{}"),
        userId: typeof row.userId === "string" && row.userId.length > 0 ? row.userId : undefined,
        teamId: typeof row.teamId === "string" && row.teamId.length > 0 ? row.teamId : undefined,
        sourceSessionId: typeof row.sourceSessionId === "string" && row.sourceSessionId.length > 0 ? row.sourceSessionId : undefined,
        confidence: typeof row.confidence === "number" ? row.confidence : undefined,
        tags: parsedTags,
        status: row.status ?? "active",
        parentId: typeof row.parentId === "string" && row.parentId.length > 0 ? row.parentId : undefined,
        citationSource: typeof row.citationSource === "string" && row.citationSource.length > 0 ? row.citationSource : undefined,
        citationTimestamp: typeof row.citationTimestamp === "number" ? row.citationTimestamp : undefined,
        citationStatus: typeof row.citationStatus === "string" && row.citationStatus.length > 0 ? row.citationStatus : undefined,
        citationChain: (() => {
            if (!row.citationChain)
                return undefined;
            if (Array.isArray(row.citationChain))
                return row.citationChain;
            if (typeof row.citationChain === "string" && row.citationChain.length > 0) {
                try {
                    return JSON.parse(row.citationChain);
                }
                catch {
                    return undefined;
                }
            }
            return undefined;
        })(),
    };
}
function normalizeEventRow(row) {
    if (typeof row.id !== "string" || typeof row.type !== "string" || typeof row.scope !== "string") {
        return null;
    }
    const base = {
        id: row.id,
        scope: row.scope,
        sessionID: typeof row.sessionID === "string" && row.sessionID.length > 0 ? row.sessionID : undefined,
        timestamp: Number(row.timestamp ?? Date.now()),
        memoryId: typeof row.memoryId === "string" && row.memoryId.length > 0 ? row.memoryId : undefined,
        text: typeof row.text === "string" && row.text.length > 0 ? row.text : undefined,
        metadataJson: String(row.metadataJson ?? "{}"),
    };
    if (row.type === "capture") {
        return {
            ...base,
            type: "capture",
            outcome: row.outcome === "stored" || row.outcome === "skipped" ? row.outcome : "considered",
            skipReason: typeof row.skipReason === "string" && row.skipReason.length > 0
                ? row.skipReason
                : undefined,
        };
    }
    if (row.type === "recall") {
        const sourceRaw = typeof row.source === "string" && row.source.length > 0 ? row.source : "system-transform";
        const source = sourceRaw === "manual-search" ? "manual-search" : "system-transform";
        return {
            ...base,
            type: "recall",
            resultCount: Number(row.resultCount ?? 0),
            injected: Boolean(row.injected),
            source,
        };
    }
    if (row.type === "feedback") {
        const helpfulValue = Number(row.helpful ?? -1);
        // EVENT_JSON_PARSE_GUARD: labelsJson/context are STRING columns, but a
        // legacy or lossy write can leave non-JSON text in them. JSON.parse
        // must never throw out of normalizeEventRow — one bad feedback row
        // would otherwise break readEventsByScopes and every event-derived
        // tool (memory_effectiveness, memory_dashboard, listEvents). Same
        // degrade-silently pattern as normalizeRow's TAGS_PARSE_GUARD.
        const labels = (() => {
            if (typeof row.labelsJson === "string" && row.labelsJson.length > 0) {
                try {
                    const parsed = JSON.parse(row.labelsJson);
                    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
                }
                catch {
                    return [];
                }
            }
            return [];
        })();
        const contextRaw = row.context;
        const parsedContext = typeof contextRaw === "string" && contextRaw.length > 0
            ? (() => {
                try {
                    return JSON.parse(contextRaw);
                }
                catch {
                    return undefined;
                }
            })()
            : undefined;
        return {
            ...base,
            type: "feedback",
            feedbackType: row.feedbackType === "missing" || row.feedbackType === "wrong" ? row.feedbackType : "useful",
            helpful: helpfulValue < 0 ? undefined : helpfulValue === 1,
            labels,
            reason: typeof row.reason === "string" && row.reason.length > 0 ? row.reason : undefined,
            sourceSessionId: typeof row.sourceSessionId === "string" && row.sourceSessionId.length > 0 ? row.sourceSessionId : undefined,
            confidenceDelta: typeof row.confidenceDelta === "number" ? row.confidenceDelta : undefined,
            relatedMemoryId: typeof row.relatedMemoryId === "string" && row.relatedMemoryId.length > 0 ? row.relatedMemoryId : undefined,
            context: parsedContext,
        };
    }
    return null;
}
function escapeSql(value) {
    return value.replace(/'/g, "''");
}
function buildRankMap(items, scoreOf) {
    const ranked = [...items].sort((a, b) => scoreOf(b) - scoreOf(a));
    const ranks = new Map();
    for (let i = 0; i < ranked.length; i += 1) {
        ranks.set(ranked[i].record.id, i + 1);
    }
    return ranks;
}
// FUZZY_CHANNEL (1.4.2): fuse.js index over memory text. ignoreLocation
// keeps substring matches relevant, ignoreDiacritics tolerates accents, and
// threshold (default 0.5) drops results whose match score is too weak.
function buildFuseIndex(records, threshold = 0.5) {
    return new Fuse(records, {
        keys: ["text"],
        includeScore: true,
        ignoreLocation: true,
        ignoreDiacritics: true,
        threshold,
    });
}
function normalizeChannelWeights(vectorWeight, bm25Weight, fuzzyWeight = 0) {
    const sum = vectorWeight + bm25Weight + fuzzyWeight;
    if (sum <= 0) {
        return { vectorWeight: 0.5, bm25Weight: 0.5, fuzzyWeight: 0 };
    }
    return {
        vectorWeight: vectorWeight / sum,
        bm25Weight: bm25Weight / sum,
        fuzzyWeight: fuzzyWeight / sum,
    };
}
function computeRecencyMultiplier(timestamp, halfLifeHours) {
    const now = Date.now();
    const ageMs = Math.max(0, now - timestamp);
    const ageHours = ageMs / 3_600_000;
    if (ageHours === 0)
        return 1;
    const decay = Math.pow(0.5, ageHours / halfLifeHours);
    return 0.5 + 0.5 * decay;
}
function clampImportance(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.max(0, Math.min(1, value));
}
function clampImportanceWeight(value) {
    if (!Number.isFinite(value))
        return 0.4;
    return Math.max(0, Math.min(2, value));
}
// RETENTION_SCORING (1.5.5): composite, query-independent retention score for
// scope-cache truncation. Reuses the exact ranking primitives (recency
// multiplier with its 0.5 soft floor, importance factor, feedback factor) so
// a memory that ranks well also survives cache truncation. citationStatus
// "wrong" is a confirmed-bad signal (explicit user/system feedback) and is
// evicted first, unconditionally; "verified" earns a modest survival bonus.
// feedbackStats is the getMemoryFeedbackStatsMap entry (undefined = neutral).
export function computeRetentionScore(record, feedbackStats, weights = {}) {
    if (record.citationStatus === "wrong") {
        return -1;
    }
    const halfLifeHours = Number.isFinite(weights.recencyHalfLifeHours) ? Math.max(1, weights.recencyHalfLifeHours) : 72;
    const importanceWeight = clampImportanceWeight(weights.importanceWeight);
    const feedbackWeight = Math.max(0, Math.min(1, weights.feedbackWeight ?? 0));
    // Unknown timestamps are treated as fresh (never evicted for age alone);
    // computeRecencyMultiplier with NaN would poison the sort order.
    const recency = computeRecencyMultiplier(Number.isFinite(record.timestamp) ? record.timestamp : Date.now(), halfLifeHours);
    const importance = 1 + importanceWeight * clampImportance(record.importance);
    const feedback = feedbackWeight > 0 && feedbackStats
        ? 1 + feedbackWeight * (feedbackStats.feedbackFactor - 1)
        : 1;
    const citationBonus = record.citationStatus === "verified" ? 1.2 : 1;
    return recency * importance * feedback * citationBonus;
}
function computeIdf(docs) {
    const df = new Map();
    for (const doc of docs) {
        const seen = new Set(doc);
        for (const token of seen) {
            df.set(token, (df.get(token) ?? 0) + 1);
        }
    }
    const totalDocs = Math.max(1, docs.length);
    const idf = new Map();
    for (const [token, count] of df.entries()) {
        idf.set(token, Math.log(1 + (totalDocs - count + 0.5) / (count + 0.5)));
    }
    return idf;
}
function vecNorm(v) {
    let sum = 0;
    for (let i = 0; i < v.length; i += 1) {
        sum += v[i] * v[i];
    }
    return Math.sqrt(sum);
}
function bm25LikeScore(query, doc, idf) {
    if (query.length === 0 || doc.length === 0)
        return 0;
    const tf = new Map();
    for (const token of doc) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
    }
    const avgDocLen = 120;
    const k1 = 1.2;
    const b = 0.75;
    let score = 0;
    for (const token of query) {
        const freq = tf.get(token) ?? 0;
        if (freq === 0)
            continue;
        const tokenIdf = idf.get(token) ?? 0.1;
        const numerator = freq * (k1 + 1);
        const denominator = freq + k1 * (1 - b + (b * doc.length) / avgDocLen);
        score += tokenIdf * (numerator / denominator);
    }
    return 1 - Math.exp(-score);
}
function extractRecalledProjects(metadataJson) {
    try {
        const metadata = JSON.parse(metadataJson);
        if (metadata && Array.isArray(metadata.recalledProjects)) {
            return new Set(metadata.recalledProjects);
        }
    }
    catch {
        // ignore parse errors
    }
    return new Set();
}
function parseMetadata(metadataJson) {
    try {
        return JSON.parse(metadataJson);
    }
    catch {
        return {};
    }
}
// MEMORY_LIFECYCLE_TOOLS: offline extractive summarization for store-level
// digests (no LLM — sentence scoring by entity density / length / position).
// Returns { text, sentenceCount, sourceCount } or null when no usable text.
export function extractiveDigest(texts, targetChars = 500, entityNames = [], sourceLabel = "") {
    const safeTexts = Array.isArray(texts)
        ? texts.filter((t) => typeof t === "string" && t.trim().length > 0)
        : [];
    if (safeTexts.length === 0)
        return null;
    const entitySet = new Set(Array.isArray(entityNames) ? entityNames : []);
    const sentences = [];
    for (let textIndex = 0; textIndex < safeTexts.length; textIndex += 1) {
        const parts = safeTexts[textIndex]
            .split(/(?<=[.!?])\s+/)
            .map((p) => p.trim())
            .filter((p) => p.length > 0);
        const isFirstText = textIndex === 0;
        const isLastText = textIndex === safeTexts.length - 1;
        for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
            const part = parts[partIndex];
            const words = part.split(/\s+/).filter(Boolean);
            const wordCount = words.length;
            if (wordCount < 4 || wordCount > 60)
                continue;
            let score = 1;
            if (isFirstText && partIndex === 0)
                score += 1.5;
            if (isLastText && partIndex === parts.length - 1)
                score += 1.2;
            if (partIndex === 0)
                score += 0.8;
            for (const w of words) {
                if (entitySet.has(w.toLowerCase()) || entitySet.has(w.replace(/[^a-z0-9._-]/gi, "").toLowerCase()))
                    score += 0.5;
            }
            for (const keyword of ["config", "fix", "bug", "shipped", "deploy", "restart", "works", "failed", "install", "default", "memory", "graph", "plugin"]) {
                if (part.toLowerCase().includes(keyword))
                    score += 0.15;
            }
            sentences.push({ text: part, score });
        }
    }
    sentences.sort((a, b) => b.score - a.score);
    const header = `SUMMARY${sourceLabel ? ` (${sourceLabel})` : ""} — ${safeTexts.length} memories`;
    const headerPart = `${header}\n`;
    let budget = Math.max(120, targetChars - headerPart.length);
    const chosen = [];
    let used = 0;
    for (const sentence of sentences) {
        if (used + sentence.text.length + 3 > budget)
            continue;
        chosen.push(sentence.text);
        used += sentence.text.length + 3;
        if (chosen.length >= 12)
            break;
    }
    if (chosen.length === 0) {
        const fallback = safeTexts[0].slice(0, budget);
        return { text: `${headerPart}${fallback}`, sentenceCount: 1, sourceCount: safeTexts.length };
    }
    return { text: `${headerPart}${chosen.map((s) => `- ${s}`).join("\n")}`, sentenceCount: chosen.length, sourceCount: safeTexts.length };
}
// MEMORY_RETENTION (1.0): pure candidate selection for the digest-then-hide
// expiry sweep. A memory is expired when ALL of:
//   - status is unset/"active" (never disabled/merged/digested)
//   - category is not protected (default: "digest") and metadataJson.pinned !== true
//   - importance >= minImportance
//   - older than minAgeDays AND unused for unusedDays, where "unused" is
//     measured from lastRecalled, or from timestamp when never recalled
//     (so junk that was never surfaced IS expirable — unlike getUnusedGlobalMemories).
export function retentionCandidates(records, opts = {}) {
    const unusedDays = Math.max(1, Number(opts.unusedDays ?? 60));
    const minAgeDays = Math.max(1, Number(opts.minAgeDays ?? 180));
    const minImportance = Number(opts.minImportance ?? 0);
    const rawProtected = opts.protectedCategories;
    const protectedCategories = new Set(Array.isArray(rawProtected)
        ? rawProtected.filter((c) => typeof c === "string")
        : (typeof rawProtected === "string" ? [rawProtected] : ["digest"]));
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const ageCutoff = now - minAgeDays * DAY_MS;
    const unusedCutoff = now - unusedDays * DAY_MS;
    return records.filter((r) => {
        if (r.status && r.status !== "active")
            return false;
        if (protectedCategories.has(r.category))
            return false;
        const timestamp = Number(r.timestamp ?? 0);
        if (timestamp <= 0 || timestamp > ageCutoff)
            return false;
        const importance = Number(r.importance ?? 0);
        if (importance < minImportance)
            return false;
        const lastRecalled = Number(r.lastRecalled ?? 0);
        const lastUse = lastRecalled > 0 ? lastRecalled : timestamp;
        if (lastUse > unusedCutoff)
            return false;
        let metadata = {};
        try {
            metadata = JSON.parse(r.metadataJson || "{}");
        }
        catch { }
        if (metadata.pinned === true)
            return false;
        return true;
    });
}

// DIGEST_EXPIRY (1.4.3): digests older than maxAgeDays are hard-expired by
// the retention sweep (sweepExpiredMemories). Digests are active rows with
// category "digest"; pinned ones are kept. Pure selector so the sweep can
// unit-test its eligibility rule.
export function expiredDigestCandidates(records, maxAgeDays) {
    const days = Math.max(1, Number(maxAgeDays ?? 365));
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return records.filter((r) => {
        if (r.category !== "digest")
            return false;
        if (r.status && r.status !== "active")
            return false;
        const ts = Number(r.timestamp ?? 0);
        if (ts <= 0 || ts > cutoff)
            return false;
        try {
            const meta = JSON.parse(r.metadataJson || "{}");
            if (meta.pinned === true)
                return false;
        }
        catch { }
        return true;
    });
}
