import { tool } from "@opencode-ai/plugin";
import { deriveProjectScope, buildScopeFilter, resolveScope } from "../scope.js";
import { generateId, toNumber } from "../utils.js";
import { getEmbedderHealth } from "../embedder.js";
import { extractiveDigest, retentionCandidates, expiredDigestCandidates } from "../store.js";
import { requestLLMDigest } from "../llm.js";
import { getLlmHealth } from "../llm.js";
import { log } from "../logger.js";
import { getTimingStats } from "../timing.js";
import { isTcpPortAvailable } from "../ports.js";
function unavailableMessage(provider) {
    return `Memory store unavailable (${provider} embedding may be offline). Will retry automatically.`;
}
// DEGRADED_FLAGS (1.3.9): report what the user is missing for full features.
// Returns a list of human-readable strings, empty when running at full strength.
function computeDegradedFlags(state, embedderHealth, graphStats) {
    const flags = [];
    const emb = state.config?.embedding ?? {};
    if (state.config?.capture?.mode === "llm") {
        const cap = state.config.capture;
        if (!cap?.llm?.provider || !cap?.llm?.model) {
            flags.push("llm-capture-unconfigured: capture.mode=llm but capture.llm.provider/model is missing — capture will fall back to heuristics");
        }
    }
    if (emb.provider === "openai" && !emb.apiKey) {
        flags.push("embedding-api-key-missing: embedding.provider=openai but no apiKey (or OPENCODE_MEMORY_PRO_OPENAI_API_KEY) is set — recall will fall back to BM25-only");
    }
    if (emb.provider !== "openai" && !(emb.baseUrl ?? "")) {
        flags.push("embedding-baseurl-missing: embedding.provider=ollama but no baseUrl (defaults to http://127.0.0.1:11434) — recall will fall back to BM25-only");
    }
    if (graphStats && graphStats.enabled === false && state.config?.graph?.enabled) {
        flags.push("graph-disabled: graph.enabled=true but the graph store did not initialize (check graph.dbPath)");
    }
    if (state.config?.capture?.llm?.provider && state.config?.capture?.llm?.model && getLlmHealth().status === "error") {
        flags.push("llm-unhealthy: last LLM capture/digest call failed — falling back to heuristics/extractive digests");
    }
    const idx = state.store?.getIndexHealth?.();
    if (idx?.dimensionMismatch) {
        flags.push(`embedding-dimension-mismatch: embedder produces ${idx.actualDim}-dim vectors but the ` +
            `store is fixed at ${idx.expectedDim}-dim — new writes are being silently corrupted and ` +
            `dedup/consolidation are silently disabled. Run memory_reembed (dryRun:false, confirm:true) to repair.`);
    }
    return flags;
}
// LLM_CAPTURE (1.1): mode-aware digest builder shared by memory_summarize
// and the retention sweep. capture.mode === "llm" → abstractive LLM digest
// via an ephemeral SDK session (falls back to the offline extractive digest
// on any failure); otherwise the historical extractive digest. The returned
// object carries digest.llm so callers can stamp provenance.
export async function buildGroupDigest(state, group, targetChars, groupKey, entityNames) {
    const texts = group.map((r) => r.text);
    const cfg = state.config?.capture;
    if (cfg?.mode === "llm" && state.client) {
        try {
            const llmDigest = await requestLLMDigest(state.client, cfg.llm, texts, targetChars, groupKey);
            if (llmDigest && llmDigest.text) {
                return { text: llmDigest.text, sourceCount: llmDigest.sourceCount ?? group.length, llm: true };
            }
        }
        catch (error) {
            log("warn", `[digest] llm digest failed for "${groupKey}": ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const digest = extractiveDigest(texts, targetChars, Array.from(entityNames ?? []), groupKey);
    return digest ? { ...digest, llm: false } : null;
}
// DIGEST_SCOPE_FOLLOWS_MEMBERS (1.6.1): with scoping="project" +
// includeGlobalScope, a digest group can mix active-scope and global
// records. The digest must live where EVERY member is visible: if any
// member is not in the active scope, store the digest in "global" —
// otherwise other projects lose those (global) memories from recall with
// no replacement (their originals were markDigested'd while the digest sat
// in whichever project swept first). Pure project groups keep their digest
// in the active scope (no global pollution).
function digestScopeForGroup(group, activeScope) {
    for (const r of group) {
        if (r.scope !== activeScope) {
            return "global";
        }
    }
    return activeScope;
}
// EMBEDDING_CONFIG_REEMBED (1.4.5): the dimension-mismatch repair core,
// shared by the memory_reembed tool and the plugin's automatic repair path
// (initializeStore in index.js). A mismatch happens when embedding config
// changed to a different-output-dimension model without resetting the store
// — LanceDB silently coerces new writes into the old fixed-width vector
// column instead of rejecting them. The vector column's physical width is
// fixed for the whole table (set by the first row ever written), not
// per-scope, so this operates on every scope in the store — unlike every
// other tool here, it does not take a `scope` argument. Backs up first
// (always) so the operation is never riskier than memory_export followed by
// memory_import(replace). Returns a result object the callers serialize.
export async function repairEmbeddingDimension(state, actualDim) {
    const expectedDim = await state.store.getPhysicalVectorDim();
    if (expectedDim === null || expectedDim === actualDim) {
        return {
            mismatch: false,
            expectedDim,
            actualDim,
            message: "No dimension mismatch detected. Nothing to repair.",
        };
    }
    const scopes = await state.store.listDistinctScopes();
    const records = await state.store.exportAllRecords(scopes);
    // BACKUP_ALWAYS_FIRST: same JSON shape as memory_export, so
    // memory_import can restore from it independently if anything below
    // fails partway through.
    const fs = await import("node:fs");
    const dbDirEnd = state.config.dbPath.lastIndexOf("/");
    const backupDir = (dbDirEnd > 0 ? state.config.dbPath.slice(0, dbDirEnd) : ".") + "/backups";
    await fs.promises.mkdir(backupDir, { recursive: true }).catch(() => { });
    const backupPath = `${backupDir}/reembed-repair-${Date.now()}.json`;
    await fs.promises.writeFile(backupPath, JSON.stringify({
        format: "opencode-memory-pro/backup",
        version: 1,
        exportedAt: new Date().toISOString(),
        provider: state.config.provider,
        dbPath: state.config.dbPath,
        reason: "pre-reembed-repair-backup",
        fromDim: expectedDim,
        toDim: actualDim,
        scopes,
        count: records.length,
        memories: records,
    }, null, 2));
    await state.store.connection.dropTable("memories");
    state.store.table = null;
    await state.store.init(actualDim);
    let repaired = 0;
    let failed = 0;
    const failures = [];
    for (const record of records) {
        try {
            const vector = await state.embedder.embed(record.text || "");
            await state.store.put({
                ...record,
                vector,
                vectorDim: vector.length,
                embeddingModel: state.embedder.model,
            });
            repaired += 1;
        }
        catch (error) {
            failed += 1;
            failures.push({ id: record.id, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    await state.store.ensureIndexes();
    return {
        mismatch: true,
        fromDim: expectedDim,
        toDim: actualDim,
        scopes,
        recordCount: records.length,
        backupPath,
        repaired,
        failed,
        failures,
        message: failed > 0
            ? `Repaired ${repaired}/${records.length}. ${failed} failed but remain intact in the ` +
                `backup at ${backupPath} — re-run memory_reembed once the embedder issue is fixed.`
            : `Repaired all ${repaired} memories at ${actualDim}-dim. Backup retained at ${backupPath}.`,
    };
}
export function createMemoryTools(state) {
    return {
        memory_search: tool({
            description: "Search long-term memory using hybrid retrieval",
            args: {
                query: tool.schema.string().min(1),
                limit: tool.schema.number().int().min(1).max(20).default(5),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                let queryVector = [];
                let embedderFailed = false;
                try {
                    queryVector = await state.embedder.embed(args.query);
                }
                catch (error) {
                    embedderFailed = true;
                    queryVector = [];
                }
                const isFallback = embedderFailed || queryVector.length === 0;
                const effectiveVectorWeight = isFallback ? 0 : (state.config.retrieval.mode === "vector" ? 1 : state.config.retrieval.vectorWeight);
                const effectiveBm25Weight = isFallback ? 1 : (state.config.retrieval.mode === "vector" ? 0 : state.config.retrieval.bm25Weight);
                // FUZZY_CHANNEL (1.4.2): fuzzy stays on in the bm25-only
                // fallback (that's when typo tolerance helps most); it is
                // disabled only in explicit vector-only mode.
                const effectiveFuzzyWeight = state.config.retrieval.mode === "vector" ? 0 : state.config.retrieval.fuzzyWeight;
                if (isFallback) {
                    log("info", "Using BM25-only search (embedder unavailable)");
                }
                const results = await state.store.search({
                    query: args.query,
                    queryVector,
                    scopes,
                    limit: args.limit ?? 5,
                    vectorWeight: effectiveVectorWeight,
                    bm25Weight: effectiveBm25Weight,
                    fuzzyWeight: effectiveFuzzyWeight,
                    fuzzyThreshold: state.config.retrieval.fuzzyThreshold,
                    minScore: state.config.retrieval.minScore,
                    rrfK: state.config.retrieval.rrfK,
                    recencyBoost: state.config.retrieval.recencyBoost,
                    recencyHalfLifeHours: state.config.retrieval.recencyHalfLifeHours,
                    importanceWeight: state.config.retrieval.importanceWeight,
                    feedbackWeight: state.config.retrieval.feedbackWeight,
                    globalDiscountFactor: state.config.globalDiscountFactor,
                });
                // GRAPH_STORE_PHASE1: entity co-occurrence boost (same factor
                // as the system-transform recall path).
                let graphBoostedResults = results;
                if (state.config.graph?.enabled && state.graph?.enabled) {
                    try {
                        graphBoostedResults = state.graph.boostResults(args.query, results, state.config.graph.boostLambda);
                    }
                    catch {
                    }
                }
                // GRAPH_STORE_PHASE2B: graph-expansion recall. BFS from the
                // query's entities up to graph.maxHops; memories reachable via
                // the graph but NOT text/vector-matched are merged in with a
                // graph-origin score below the weakest real match, so the
                // multi-hop "query mentions config.js → also surface dedup/
                // retention memories" behavior works.
                const graphExpanded = [];
                if (state.config.graph?.enabled && state.graph?.enabled && state.config.graph.expansionEnabled !== false) {
                    try {
                        const candidates = state.graph.expandRecall(args.query, {
                            maxHops: state.config.graph.maxHops,
                            expansionLimit: state.config.graph.expansionLimit,
                            expansionLambda: state.config.graph.expansionLambda,
                        });
                        if (candidates.length > 0) {
                            const expandedRecords = await state.store.findRecordsByIds(candidates.map((c) => c.memoryId), scopes);
                            const recordById = new Map(expandedRecords.map((r) => [r.id, r]));
                            const existingIds = new Set(results.map((r) => r.record.id));
                            const floorScore = results.length > 0
                                ? Math.min(...results.map((r) => r.score))
                                : state.config.retrieval.minScore;
                            for (const candidate of candidates) {
                                const record = recordById.get(candidate.memoryId);
                                if (!record || existingIds.has(record.id))
                                    continue;
                                graphExpanded.push({
                                    record,
                                    score: floorScore * candidate.scoreFactor,
                                    vectorScore: 0,
                                    bm25Score: 0,
                                    graphBFS: { hops: candidate.hops, relation: candidate.relation, typed: candidate.typed, path: candidate.path },
                                });
                            }
                        }
                    }
                    catch {
                    }
                }
                const searchLimit = args.limit ?? 5;
                const effectiveLimit = graphExpanded.length > 0
                    ? searchLimit + (state.config.graph?.expansionLimit ?? 5)
                    : searchLimit;
                const recencyHalfLifeHours = Math.max(1, state.config.retrieval.recencyHalfLifeHours ?? 72);
                const finalResults = [...graphBoostedResults, ...graphExpanded]
                    .slice()
                    .sort((a, b) => b.score - a.score)
                    .slice(0, effectiveLimit);
                state.lastRecall = {
                    timestamp: Date.now(),
                    query: args.query,
                    results: finalResults.map((r) => {
                        // RECENCY_FACTORS (1.2.0): was a display stub
                        // (ageHours:0/withinHalfLife:true/decayFactor:1).
                        // Same formula as store.explainMemory so the factors
                        // agree with memory_why / memory_explain_recall.
                        const ageHours = (Date.now() - r.record.timestamp) / 3_600_000;
                        return {
                            memoryId: r.record.id,
                            score: r.score,
                            factors: {
                                relevance: { overall: r.score, vectorScore: r.vectorScore, bm25Score: r.bm25Score },
                                recency: { timestamp: r.record.timestamp, ageHours, withinHalfLife: ageHours <= recencyHalfLifeHours, decayFactor: Math.exp(-ageHours / recencyHalfLifeHours) },
                                citation: r.record.citationSource ? { source: r.record.citationSource, status: r.record.citationStatus ?? "pending" } : undefined,
                                importance: r.record.importance,
                                scope: { memoryScope: r.record.scope, matchesCurrentScope: r.record.scope === activeScope, isGlobal: r.record.scope === "global" },
                                graph: r.graphBFS ? { bfs: { hops: r.graphBFS.hops, relation: r.graphBFS.relation, typed: r.graphBFS.typed } }
                                    : r.graphBoost ? { boost: r.graphBoost, overlap: r.graphOverlap ?? 0 } : undefined,
                            },
                        };
                    }),
                };
                await state.store.putEvent({
                    id: generateId(),
                    type: "recall",
                    source: "manual-search",
                    scope: activeScope,
                    sessionID: context.sessionID,
                    timestamp: Date.now(),
                    resultCount: finalResults.length,
                    injected: false,
                    metadataJson: JSON.stringify({ source: "manual-search" }),
                });
                if (finalResults.length === 0)
                    return "No relevant memory found.";
                // FIRE_AND_FORGET_USAGE (perf review): this used to await
                // updateMemoryUsage sequentially per result, blocking the
                // tool's return on `limit` round trips. Nothing downstream
                // reads the result, and the auto-recall path (index.js) has
                // always fired these without awaiting — match that here so
                // manual memory_search isn't slower than auto-recall for the
                // same usage-tracking side effect.
                for (const result of finalResults) {
                    state.store.updateMemoryUsage(result.record.id, activeScope, scopes).catch(() => { });
                }
                return finalResults
                    .map((item, idx) => {
                    const percent = Math.round(item.score * 100);
                    // Same degrade-silently rule as store.js's parse guards: one
                    // record with malformed metadataJson must not throw the
                    // whole memory_search output away.
                    let meta = {};
                    try {
                        meta = JSON.parse(item.record.metadataJson || "{}");
                    }
                    catch { }
                    const duplicateMarker = meta.isPotentialDuplicate ? " (duplicate)" : "";
                    const citationInfo = item.record.citationSource
                        ? ` [${item.record.citationSource}|${item.record.citationStatus ?? "pending"}]`
                        : "";
                    const graphMarker = item.graphBoost
                        ? ` [graph+${Math.round((item.graphBoost - 1) * 100)}%/${item.graphOverlap} entities]`
                        : item.graphBFS
                            ? ` [graph-bfs: ${item.graphBFS.hops} hop${item.graphBFS.hops === 1 ? "" : "s"}]`
                            : "";
                    return `${idx + 1}. [${item.record.id}]${duplicateMarker}${citationInfo}${graphMarker} (${item.record.scope}) ${item.record.text} [${percent}%]`;
                })
                    .join("\n");
            },
        }),
        memory_delete: tool({
            description: "Delete one memory entry by id",
            args: {
                id: tool.schema.string().min(8),
                scope: tool.schema.string().optional(),
                confirm: tool.schema.boolean().default(false),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                if (!args.confirm) {
                    return "Rejected: memory_delete requires confirm=true.";
                }
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                // FORCE_DELETE_HIDDEN (1.3.8): was deleteById, whose readByScopes
                // filter excludes disabled/merged rows — so memory_delete could
                // never permanently delete a memory that was soft-deleted first.
                // deleteByIdForce sees those hidden rows (see memory_forget).
                // DELETE_FORCE_SCOPE (1.6.2): pass the scope filter so the hard
                // delete is scoped to the current scope instead of all scopes.
                const deleted = await state.store.deleteByIdForce(args.id, scopes);
                return deleted ? `Deleted memory ${args.id}.` : `Memory ${args.id} not found in current scope.`;
            },
        }),
        memory_clear: tool({
            description: "Clear all memories in a scope (requires confirm=true)",
            args: {
                scope: tool.schema.string(),
                confirm: tool.schema.boolean().default(false),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                if (!args.confirm) {
                    return "Rejected: destructive clear requires confirm=true.";
                }
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const count = await state.store.clearScope(activeScope);
                return `Cleared ${count} memories from scope ${activeScope}.`;
            },
        }),
        memory_stats: tool({
            description: "Show memory provider status and index health",
            args: {
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const scope = resolveScope(args.scope, context.directory || context.worktree);
                const entries = await state.store.list(scope, 20);
                // MEMORY_STATS_EMBEDDER_GUARD (1.6.2): state.embedder.dim()
                // throws after its retries when the embedder is down, which used
                // to make memory_stats — the one diagnostic tool that should
                // report "embedder offline" — error out instead. Degrade to a
                // null dimension (and null incompatible-vector count) so the
                // tool still returns a full report with embedderHealth showing
                // the outage.
                let embedderDim = null;
                let embedderOffline = false;
                try {
                    embedderDim = await state.embedder.dim();
                }
                catch (error) {
                    embedderOffline = true;
                    log("warn", `embedder unavailable during memory_stats: ${error?.message ?? String(error)}`);
                }
                const incompatibleVectors = embedderOffline
                    ? null
                    : await state.store.countIncompatibleVectors(buildScopeFilter(scope, state.config.includeGlobalScope), embedderDim);
                const health = state.store.getIndexHealth();
                const embedderHealth = getEmbedderHealth();
                const llmHealth = getLlmHealth();
                const searchMode = embedderHealth.fallbackActive ? "bm25-only" : state.config.retrieval.mode;
                const eventTtl = state.config.retention
                    ? await state.store.getEventTtlStatus()
                    : { enabled: false, retentionDays: 90, expiredCount: 0, scopeBreakdown: {} };
                const graphStats = state.config.graph?.enabled && state.graph?.enabled
                    ? state.graph.stats()
                    : { enabled: false, entities: 0, memoryMappings: 0, edges: 0 };
                // MEMORY_RETENTION (1.0): report how many memories currently
                // qualify for the digest-then-hide expiry sweep (dry-run).
                const memoryRetention = { enabled: false, unusedDays: 0, minAgeDays: 0, digestMaxAgeDays: 0, expiredCandidates: 0, digestsEligible: 0 };
                if (state.config.retention?.memory?.enabled !== false) {
                    try {
                        const sweep = await sweepExpiredMemories(state, { scope, dryRun: true });
                        memoryRetention.enabled = true;
                        memoryRetention.unusedDays = sweep.unusedDays ?? 0;
                        memoryRetention.minAgeDays = sweep.minAgeDays ?? 0;
                        memoryRetention.digestMaxAgeDays = sweep.digestMaxAgeDays ?? 0;
                        memoryRetention.expiredCandidates = sweep.eligible ?? 0;
                        memoryRetention.digestsEligible = sweep.digestsEligible ?? 0;
                    }
                    catch { }
                }
                return JSON.stringify({
                    provider: state.config.provider,
                    dbPath: state.config.dbPath,
                    scope,
                    recentCount: entries.length,
                    incompatibleVectors,
                    index: health,
                    fuzzy: {
                        enabled: (state.config.retrieval.fuzzyWeight ?? 0) > 0,
                        weight: state.config.retrieval.fuzzyWeight ?? 0,
                        threshold: state.config.retrieval.fuzzyThreshold ?? 0.5,
                    },
                    embeddingModel: state.config.embedding.model,
                    embedderOffline,
                    searchMode,
                    embedderHealth,
                    capture: {
                        mode: state.config.capture?.mode ?? "heuristics",
                        llm: {
                            provider: state.config.capture?.llm?.provider ?? null,
                            model: state.config.capture?.llm?.model ?? null,
                            configured: Boolean(state.config.capture?.llm?.provider && state.config.capture?.llm?.model),
                        },
                        llmHealth,
                    },
                    eventTtl,
                    graph: graphStats,
                    memoryRetention,
                    // TIMING_SPANS (1.4.7): cumulative span stats (count/total/
                    // avg/max per op) since process start, hottest ops first.
                    // Set OPENCODE_MEMORY_PRO_TIMING=1 to also stream each span
                    // to the log as it completes.
                    timing: getTimingStats(),
                    degradedFlags: computeDegradedFlags(state, embedderHealth, graphStats),
                }, null, 2);
            },
        }),
        memory_event_cleanup: tool({
            description: "Clean up expired effectiveness events with optional archival export",
            args: {
                scope: tool.schema.string().optional(),
                dryRun: tool.schema.boolean().optional().default(false),
                archivePath: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                if (!state.config.retention || state.config.retention.effectivenessEventsDays <= 0) {
                    return JSON.stringify({ error: "Event TTL is disabled. Configure retention.effectivenessEventsDays in config." }, null, 2);
                }
                const status = await state.store.getEventTtlStatus();
                // EVENT_CLEANUP_SCOPES (1.2.0): archive and delete must cover
                // the SAME set of events, or expired events outside the active
                // scopes get deleted without ever being archived. Both use the
                // active scope + global (per includeGlobalScope); the old path
                // passed `args.scope` to cleanupExpiredEvents where `undefined`
                // meant ALL scopes (and the store's `scope LIKE 'project:%'`
                // matched every project scope).
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                const cutoffTimestamp = Date.now() - status.retentionDays * 24 * 60 * 60 * 1000;
                if (args.dryRun) {
                    let scopedExpired = status.expiredCount;
                    try {
                        const eventsToArchive = await state.store.readEventsByScopes(scopes);
                        scopedExpired = eventsToArchive.filter((ev) => ev.timestamp < cutoffTimestamp).length;
                    }
                    catch { }
                    return JSON.stringify({
                        wouldDelete: scopedExpired,
                        allScopesExpired: status.expiredCount,
                        scopeBreakdown: status.scopeBreakdown,
                        retentionDays: status.retentionDays,
                        activeScope,
                        message: "Dry run - no events deleted",
                    }, null, 2);
                }
                let archivedCount = 0;
                let archiveFile = undefined;
                if (args.archivePath && status.expiredCount > 0) {
                    try {
                        const eventsToArchive = await state.store.readEventsByScopes(scopes);
                        const expired = eventsToArchive.filter((ev) => ev.timestamp < cutoffTimestamp);
                        const fs = await import("node:fs");
                        const archiveDir = args.archivePath.lastIndexOf("/") > 0 ? args.archivePath.slice(0, args.archivePath.lastIndexOf("/")) : ".";
                        await fs.promises.mkdir(archiveDir, { recursive: true });
                        await fs.promises.writeFile(args.archivePath, JSON.stringify({
                            exportedAt: new Date().toISOString(),
                            retentionDays: status.retentionDays,
                            count: expired.length,
                            scopeBreakdown: status.scopeBreakdown,
                            events: expired,
                        }, null, 2));
                        archivedCount = expired.length;
                        archiveFile = args.archivePath;
                    }
                    catch (error) {
                        return JSON.stringify({ error: `Archive failed: ${error instanceof Error ? error.message : String(error)}` }, null, 2);
                    }
                }
                const deletedCount = await state.store.cleanupExpiredEvents(scopes, status.retentionDays);
                const remainingStatus = await state.store.getEventTtlStatus();
                return JSON.stringify({
                    deletedCount,
                    archivedCount,
                    archiveFile,
                    remainingCount: remainingStatus.expiredCount,
                    retentionDays: status.retentionDays,
                }, null, 2);
            },
        }),
        memory_remember: tool({
            description: "Explicitly store a memory with optional category label",
            args: {
                text: tool.schema.string().min(1),
                category: tool.schema.string().optional(),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                if (args.text.length < state.config.minCaptureChars) {
                    return `Content too short (minimum ${state.config.minCaptureChars} characters).`;
                }
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                let vector = [];
                try {
                    vector = await state.embedder.embed(args.text);
                }
                catch {
                    vector = [];
                }
                if (vector.length === 0) {
                    return "Failed to create embedding vector.";
                }
                const memoryId = generateId();
                const now = Date.now();
                const graphEntities = state.config.graph?.enabled && state.graph?.enabled
                    ? state.graph.extract(args.text)
                    : [];
                await state.store.put({
                    id: memoryId,
                    text: args.text,
                    vector,
                    category: args.category ?? "other",
                    scope: activeScope,
                    importance: 0.7,
                    timestamp: now,
                    lastRecalled: 0,
                    recallCount: 0,
                    projectCount: 0,
                    schemaVersion: 1,
                    embeddingModel: state.config.embedding.model,
                    vectorDim: vector.length,
                    metadataJson: JSON.stringify({
                        source: "explicit-remember",
                        category: args.category,
                        graphEntities: graphEntities.map((e) => e.name),
                    }),
                    sourceSessionId: context.sessionID,
                    citationSource: "explicit-remember",
                    citationTimestamp: now,
                    citationStatus: "pending",
                });
                if (state.config.graph?.enabled && state.graph?.enabled) {
                    try {
                        state.graph.indexMemory(memoryId, args.text, now);
                    }
                    catch {
                    }
                }
                await state.store.putEvent({
                    id: generateId(),
                    type: "capture",
                    outcome: "stored",
                    scope: activeScope,
                    sessionID: context.sessionID,
                    timestamp: Date.now(),
                    memoryId,
                    text: args.text,
                    metadataJson: JSON.stringify({ source: "explicit-remember", category: args.category }),
                    sourceSessionId: context.sessionID,
                });
                return `Stored memory ${memoryId} in scope ${activeScope}.`;
            },
        }),
        memory_forget: tool({
            description: "Remove or disable a memory (soft-delete by default, hard-delete with confirm)",
            args: {
                id: tool.schema.string().min(8),
                force: tool.schema.boolean().default(false),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                if (args.force) {
                    // FORCE_DELETE_HIDDEN (1.3.8): was deleteById, whose
                    // readByScopes filter excludes disabled/merged rows — so
                    // force=true could never permanently delete a memory that
                    // was soft-deleted first.
                    const deleted = await state.store.deleteByIdForce(args.id, scopes);
                    if (!deleted) {
                        return `Memory ${args.id} not found in current scope.`;
                    }
                    await state.store.putEvent({
                        id: generateId(),
                        type: "feedback",
                        // FORGET_FEEDBACK (1.3.5): was feedbackType "useful" with
                        // helpful:false, polluting the unhelpful-recall stats.
                        // "wrong" is the semantically-correct signal (memory
                        // should not be stored) and feeds the false-positive
                        // rate / wrong penalty.
                        feedbackType: "wrong",
                        scope: activeScope,
                        sessionID: context.sessionID,
                        timestamp: Date.now(),
                        memoryId: args.id,
                        reason: "explicit-forget (hard delete)",
                        metadataJson: JSON.stringify({ source: "explicit-forget", hardDelete: true }),
                    });
                    return `Permanently deleted memory ${args.id}.`;
                }
                const softDeleted = await state.store.softDeleteMemory(args.id, scopes);
                if (!softDeleted) {
                    return `Memory ${args.id} not found in current scope.`;
                }
                await state.store.putEvent({
                    id: generateId(),
                    type: "feedback",
                    // FORGET_FEEDBACK (1.3.5): was feedbackType "useful" with
                    // helpful:false, polluting the unhelpful-recall stats.
                    feedbackType: "wrong",
                    scope: activeScope,
                    sessionID: context.sessionID,
                    timestamp: Date.now(),
                    memoryId: args.id,
                    reason: "explicit-forget (soft delete)",
                    metadataJson: JSON.stringify({ source: "explicit-forget", hardDelete: false }),
                });
                return `Soft-deleted (disabled) memory ${args.id}. Use force=true for permanent deletion.`;
            },
        }),
        memory_citation: tool({
            description: "View or update citation information for a memory",
            args: {
                id: tool.schema.string().min(8),
                status: tool.schema.string().optional(),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                const citation = await state.store.getCitation(args.id, scopes);
                if (!citation) {
                    return `Memory ${args.id} not found or has no citation information.`;
                }
                if (args.status) {
                    const validStatuses = ["verified", "pending", "invalid", "expired"];
                    if (!validStatuses.includes(args.status)) {
                        return `Invalid status. Must be one of: ${validStatuses.join(", ")}`;
                    }
                    const updated = await state.store.updateCitation(args.id, scopes, { status: args.status });
                    if (!updated) {
                        return `Failed to update citation for ${args.id}.`;
                    }
                    return `Updated citation status for ${args.id} to ${args.status}.`;
                }
                return JSON.stringify({
                    memoryId: args.id,
                    source: citation.source,
                    timestamp: new Date(citation.timestamp).toISOString(),
                    status: citation.status,
                    chain: citation.chain,
                }, null, 2);
            },
        }),
        memory_validate_citation: tool({
            description: "Validate a citation for a memory and update its status",
            args: {
                id: tool.schema.string().min(8),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                const result = await state.store.validateCitation(args.id, scopes);
                return JSON.stringify({
                    memoryId: args.id,
                    valid: result.valid,
                    status: result.status,
                    reason: result.reason,
                }, null, 2);
            },
        }),
        memory_what_did_you_learn: tool({
            description: "Show recent learning summary with memory counts by category",
            args: {
                days: tool.schema.number().int().min(1).max(90).default(7),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const sinceTimestamp = Date.now() - (args.days ?? 7) * 24 * 60 * 60 * 1000;
                const memories = await state.store.listSince(activeScope, sinceTimestamp, 1000);
                if (memories.length === 0) {
                    return `No memories captured in the past ${args.days} days in scope ${activeScope}.`;
                }
                const categoryCounts = {};
                for (const mem of memories) {
                    categoryCounts[mem.category] = (categoryCounts[mem.category] ?? 0) + 1;
                }
                const total = memories.length;
                const categoryBreakdown = Object.entries(categoryCounts)
                    .map(([cat, count]) => `  - ${cat}: ${count}`)
                    .join("\n");
                const recentSamples = memories.slice(0, 5).map((mem, idx) => {
                    const date = new Date(mem.timestamp).toISOString().split("T")[0];
                    const snippet = mem.text.length > 60 ? `${mem.text.slice(0, 60)}...` : mem.text;
                    return `  ${idx + 1}. [${date}] ${snippet}`;
                }).join("\n");
                return `## Learning Summary (${args.days} days)

**Scope:** ${activeScope}
**Total memories:** ${total}

### By Category
${categoryBreakdown}

### Recent Captures
${recentSamples}
`;
            },
        }),
        memory_why: tool({
            description: "Explain why a specific memory was recalled",
            args: {
                id: tool.schema.string().min(8),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                const explanation = await state.store.explainMemory(args.id, scopes, activeScope, state.config.retrieval.recencyHalfLifeHours, state.config.globalDiscountFactor);
                if (!explanation) {
                    return `Memory ${args.id} not found in current scope.`;
                }
                const f = explanation.factors;
                const recencyText = f.recency.withinHalfLife
                    ? `within ${f.recency.ageHours.toFixed(1)}h half-life`
                    : `beyond half-life (${f.recency.ageHours.toFixed(1)}h old)`;
                const citationText = f.citation
                    ? `${f.citation.source ?? "unknown"}/${f.citation.status ?? "n/a"}`
                    : "N/A";
                const scopeText = f.scope.matchesCurrentScope
                    ? "matches current project"
                    : f.scope.isGlobal
                        ? "from global scope"
                        : "different project scope";
                return `Memory: "${explanation.text.slice(0, 80)}..."
Explanation:
- Recency: ${recencyText} (decay: ${(f.recency.decayFactor * 100).toFixed(0)}%)
- Citation: ${citationText}
- Importance: ${f.importance.toFixed(2)}
- Scope: ${scopeText}`;
            },
        }),
        memory_explain_recall: tool({
            description: "Explain the factors behind the last recall operation in this session",
            args: {
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const lastRecall = state.lastRecall;
                if (!lastRecall) {
                    return "No recent recall to explain. Use memory_search or wait for auto-recall first.";
                }
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                const explanations = [];
                for (const result of lastRecall.results) {
                    const explanation = await state.store.explainMemory(result.memoryId, scopes, activeScope, state.config.retrieval.recencyHalfLifeHours, state.config.globalDiscountFactor);
                    if (!explanation)
                        continue;
                    const f = explanation.factors;
                    const recencyText = f.recency.withinHalfLife
                        ? "recent"
                        : "older";
                    explanations.push(`${result.memoryId.slice(0, 8)}: ${(result.score * 100).toFixed(0)}% relevance, ${recencyText}, ${f.citation?.status ?? "no citation"}`);
                }
                return `## Last Recall Explanation
Query: "${lastRecall.query}"
Results: ${lastRecall.results.length}

${explanations.join("\n")}`;
            },
        }),
        memory_scope_promote: tool({
            description: "Promote a memory from project scope to global scope for cross-project sharing",
            args: {
                id: tool.schema.string().min(8),
                confirm: tool.schema.boolean().default(false),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                if (!args.confirm) {
                    return "Rejected: memory_scope_promote requires confirm=true.";
                }
                const activeScope = deriveProjectScope(context.directory || context.worktree);
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                const exists = await state.store.hasMemory(args.id, scopes);
                if (!exists) {
                    return `Memory ${args.id} not found in current scope.`;
                }
                const updated = await state.store.updateMemoryScope(args.id, "global", scopes);
                if (!updated) {
                    return `Failed to promote memory ${args.id}.`;
                }
                return `Promoted memory ${args.id} to global scope.`;
            },
        }),
        memory_scope_demote: tool({
            description: "Demote a memory from global scope to project scope",
            args: {
                id: tool.schema.string().min(8),
                confirm: tool.schema.boolean().default(false),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                if (!args.confirm) {
                    return "Rejected: memory_scope_demote requires confirm=true.";
                }
                const projectScope = resolveScope(args.scope, context.directory || context.worktree);
                const globalExists = await state.store.hasMemory(args.id, ["global"]);
                if (!globalExists) {
                    return `Memory ${args.id} not found in global scope or is not a global memory.`;
                }
                const updated = await state.store.updateMemoryScope(args.id, projectScope, ["global"]);
                if (!updated) {
                    return `Failed to demote memory ${args.id}.`;
                }
                return `Demoted memory ${args.id} from global to ${projectScope}.`;
            },
        }),
        memory_global_list: tool({
            description: "List all global-scoped memories, optionally filtered by search query or unused status",
            args: {
                query: tool.schema.string().optional(),
                filter: tool.schema.string().optional(),
                limit: tool.schema.number().int().min(1).max(100).default(20),
            },
            execute: async (args) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                let records;
                if (args.filter === "unused") {
                    records = await state.store.getUnusedGlobalMemories(state.config.unusedDaysThreshold, args.limit ?? 20);
                }
                else if (args.query) {
                    let queryVector = [];
                    try {
                        queryVector = await state.embedder.embed(args.query);
                    }
                    catch {
                        queryVector = [];
                    }
                    records = await state.store.search({
                        query: args.query,
                        queryVector,
                        scopes: ["global"],
                        limit: args.limit ?? 20,
                        vectorWeight: 0.7,
                        bm25Weight: 0.3,
                        fuzzyWeight: 0,
                        minScore: 0.2,
                        globalDiscountFactor: 1.0,
                    }).then((results) => results.map((r) => r.record));
                }
                else {
                    records = await state.store.readGlobalMemories(args.limit ?? 20);
                }
                if (records.length === 0) {
                    return "No global memories found.";
                }
                return records
                    .map((record, idx) => {
                    const date = new Date(record.timestamp).toISOString().split("T")[0];
                    const lastRecalled = record.lastRecalled > 0
                        ? new Date(record.lastRecalled).toISOString().split("T")[0]
                        : "never";
                    return `${idx + 1}. [${record.id}] ${record.text.slice(0, 80)}...
  Stored: ${date} | Recalled: ${lastRecalled} | Count: ${record.recallCount} | Projects: ${record.projectCount}`;
                })
                    .join("\n");
            },
        }),
        memory_consolidate: tool({
            description: "Scope-internally merge near-duplicate memories. Use to clean up accumulated duplicates.",
            args: {
                scope: tool.schema.string().optional(),
                confirm: tool.schema.boolean().default(false),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                if (!args.confirm) {
                    return "Rejected: memory_consolidate requires confirm=true.";
                }
                const targetScope = resolveScope(args.scope, context.directory || context.worktree);
                if (state.consolidationInProgress.get(targetScope)) {
                    return JSON.stringify({ scope: targetScope, status: "already_in_progress", message: "Consolidation already in progress for this scope" });
                }
                state.consolidationInProgress.set(targetScope, true);
                try {
                    const result = await state.store.consolidateDuplicates(targetScope, state.config.dedup.consolidateThreshold, state.config.dedup.candidateLimit);
                    return JSON.stringify({ scope: targetScope, ...result }, null, 2);
                }
                finally {
                    state.consolidationInProgress.delete(targetScope);
                }
            },
        }),
        memory_consolidate_all: tool({
            description: "Consolidate duplicates across global scope and current project scope. Used by external cron jobs for daily cleanup.",
            args: {
                confirm: tool.schema.boolean().default(false),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                if (!args.confirm) {
                    return "Rejected: memory_consolidate_all requires confirm=true.";
                }
                const projectScope = deriveProjectScope(context.directory || context.worktree);
                const globalInProgress = state.consolidationInProgress.get("global");
                const projectInProgress = state.consolidationInProgress.get(projectScope);
                if (globalInProgress || projectInProgress) {
                    return JSON.stringify({
                        global: { scope: "global", status: globalInProgress ? "already_in_progress" : "pending" },
                        project: { scope: projectScope, status: projectInProgress ? "already_in_progress" : "pending" },
                        message: "Consolidation already in progress for one or more scopes",
                    });
                }
                state.consolidationInProgress.set("global", true);
                state.consolidationInProgress.set(projectScope, true);
                try {
                    const globalResult = await state.store.consolidateDuplicates("global", state.config.dedup.consolidateThreshold, state.config.dedup.candidateLimit);
                    const projectResult = await state.store.consolidateDuplicates(projectScope, state.config.dedup.consolidateThreshold, state.config.dedup.candidateLimit);
                    return JSON.stringify({
                        global: { scope: "global", ...globalResult },
                        project: { scope: projectScope, ...projectResult },
                    }, null, 2);
                }
                finally {
                    state.consolidationInProgress.delete("global");
                    state.consolidationInProgress.delete(projectScope);
                }
            },
        }),
        memory_port_plan: tool({
            description: "Plan non-conflicting host ports for compose services and optionally persist reservations",
            args: {
                project: tool.schema.string().min(1).optional(),
                services: tool.schema
                    .array(tool.schema.object({
                    name: tool.schema.string().min(1),
                    containerPort: tool.schema.number().int().min(1).max(65535),
                    preferredHostPort: tool.schema.number().int().min(1).max(65535).optional(),
                }))
                    .min(1),
                rangeStart: tool.schema.number().int().min(1).max(65535).default(20000),
                rangeEnd: tool.schema.number().int().min(1).max(65535).default(39999),
                persist: tool.schema.boolean().default(true),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                if ((args.rangeStart ?? 20000) > (args.rangeEnd ?? 39999)) {
                    return "Invalid range: rangeStart must be <= rangeEnd.";
                }
                const project = args.project?.trim() || deriveProjectScope(context.directory || context.worktree);
                const globalRecords = await state.store.list("global", 100000);
                const reservations = [];
                for (const record of globalRecords) {
                    try {
                        const meta = JSON.parse(record.metadataJson || "{}");
                        if (meta.type === "port-reservation") {
                            reservations.push({
                                id: record.id,
                                project: meta.project,
                                service: meta.service,
                                protocol: meta.protocol,
                            });
                        }
                    }
                    catch {
                        // skip invalid records
                    }
                }
                const assignments = [];
                const usedPorts = new Set();
                const warnings = [];
                for (const res of reservations) {
                    try {
                        const record = globalRecords.find(r => r.id === res.id);
                        if (record) {
                            const meta = JSON.parse(record.metadataJson || "{}");
                            usedPorts.add(meta.hostPort);
                        }
                    }
                    catch {
                        // skip
                    }
                }
                for (const service of args.services) {
                    let hostPort = service.preferredHostPort;
                    // PORT_PLAN_TCP_CHECK (1.6.1): the planner used to consult
                    // only persisted reservations — a port bound by a LIVE
                    // process was handed out and compose failed at up time.
                    // isTcpPortAvailable actually binds the candidate (the
                    // ports.js helper was dead code). usedPorts short-circuits
                    // so already-assigned ports are never re-probed.
                    if (!hostPort || usedPorts.has(hostPort) || !(await isTcpPortAvailable(hostPort))) {
                        hostPort = 0;
                        for (let port = args.rangeStart ?? 20000; port <= (args.rangeEnd ?? 39999); port++) {
                            if (!usedPorts.has(port) && await isTcpPortAvailable(port)) {
                                hostPort = port;
                                break;
                            }
                        }
                    }
                    if (hostPort > 0) {
                        usedPorts.add(hostPort);
                        assignments.push({
                            project,
                            service: service.name,
                            containerPort: service.containerPort,
                            hostPort,
                            protocol: "tcp",
                        });
                    }
                    else {
                        warnings.push(`No free host port in range ${args.rangeStart ?? 20000}-${args.rangeEnd ?? 39999} for service ${service.name}`);
                    }
                }
                let persisted = 0;
                if (args.persist) {
                    const keyToOldIds = new Map();
                    for (const reservation of reservations) {
                        const key = `${reservation.project}:${reservation.service}:${reservation.protocol}`;
                        if (!keyToOldIds.has(key)) {
                            keyToOldIds.set(key, []);
                        }
                        keyToOldIds.get(key)?.push(reservation.id);
                    }
                    for (const assignment of assignments) {
                        const key = `${assignment.project}:${assignment.service}:${assignment.protocol}`;
                        const oldIds = keyToOldIds.get(key) ?? [];
                        const text = `PORT_RESERVATION ${assignment.project} ${assignment.service} host=${assignment.hostPort} container=${assignment.containerPort} protocol=${assignment.protocol}`;
                        try {
                            const vector = await state.embedder.embed(text);
                            if (vector.length === 0) {
                                warnings.push(`Skipped persistence for ${assignment.service}: empty embedding vector.`);
                                continue;
                            }
                            await state.store.put({
                                id: generateId(),
                                text,
                                vector,
                                category: "entity",
                                scope: "global",
                                importance: 0.8,
                                timestamp: Date.now(),
                                lastRecalled: 0,
                                recallCount: 0,
                                projectCount: 0,
                                schemaVersion: 1,
                                embeddingModel: state.config.embedding.model,
                                vectorDim: vector.length,
                                metadataJson: JSON.stringify({
                                    source: "port-plan",
                                    type: "port-reservation",
                                    project: assignment.project,
                                    service: assignment.service,
                                    hostPort: assignment.hostPort,
                                    containerPort: assignment.containerPort,
                                    protocol: assignment.protocol,
                                }),
                            });
                            for (const id of oldIds) {
                                await state.store.deleteById(id, ["global"]);
                            }
                            persisted += 1;
                        }
                        catch (error) {
                            warnings.push(`Failed to persist ${assignment.service}: ${error instanceof Error ? error.message : String(error)}`);
                        }
                    }
                }
                return JSON.stringify({
                    project,
                    persistRequested: args.persist,
                    persisted,
                    assignments,
                    warnings,
                }, null, 2);
            },
        }),
        memory_dashboard: tool({
            description: "Show weekly learning dashboard with trends and insights",
            args: {
                days: tool.schema.number().int().min(1).max(90).default(7),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const scope = resolveScope(args.scope, context.directory || context.worktree);
                const dashboard = await state.store.getWeeklyEffectivenessSummary(scope, state.config.includeGlobalScope, args.days ?? 7);
                return JSON.stringify(dashboard, null, 2);
            },
        }),
        memory_kpi: tool({
            description: "Show learning KPI metrics (retry-to-success rate and memory lift)",
            args: {
                days: tool.schema.number().int().min(1).max(365).default(30),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const scope = resolveScope(args.scope, context.directory || context.worktree);
                const kpi = await state.store.getKpiSummary(scope, args.days ?? 30);
                return JSON.stringify(kpi, null, 2);
            },
        }),
        // MEMORY_LIFECYCLE_TOOLS (0.9): export/import/summarize.
        memory_export: tool({
            description: "Backup all memories (incl. disabled/merged/digested) to a JSON file",
            args: {
                path: tool.schema.string().min(1),
                scope: tool.schema.string().optional(),
                dryRun: tool.schema.boolean().optional().default(false),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                const records = await state.store.exportAllRecords(scopes);
                if (args.dryRun) {
                    return JSON.stringify({
                        dryRun: true,
                        wouldExport: records.length,
                        scopes,
                        message: "No file written",
                    }, null, 2);
                }
                const payload = {
                    format: "opencode-memory-pro/backup",
                    version: 1,
                    exportedAt: new Date().toISOString(),
                    provider: state.config.provider,
                    dbPath: state.config.dbPath,
                    scope: activeScope,
                    scopes,
                    count: records.length,
                    memories: records,
                };
                const fs = await import("node:fs");
                try {
                    const exportDir = args.path.lastIndexOf("/") > 0 ? args.path.slice(0, args.path.lastIndexOf("/")) : ".";
                    await fs.promises.mkdir(exportDir, { recursive: true });
                }
                catch {
                }
                await fs.promises.writeFile(args.path, JSON.stringify(payload, null, 2));
                return JSON.stringify({
                    exportedCount: records.length,
                    file: args.path,
                    bytes: (await fs.promises.stat(args.path)).size,
                    scopes,
                }, null, 2);
            },
        }),
        memory_import: tool({
            description: "Restore memories from a memory_export JSON backup (merge skips existing ids, replace overwrites them)",
            args: {
                path: tool.schema.string().min(1),
                scope: tool.schema.string().optional(),
                mode: tool.schema.enum(["merge", "replace"]).optional().default("merge"),
                dryRun: tool.schema.boolean().optional().default(false),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const fs = await import("node:fs");
                let payload;
                try {
                    payload = JSON.parse(await fs.promises.readFile(args.path, "utf8"));
                }
                catch (error) {
                    return JSON.stringify({ error: `Failed to read ${args.path}: ${error instanceof Error ? error.message : String(error)}` }, null, 2);
                }
                if (!Array.isArray(payload?.memories)) {
                    return JSON.stringify({ error: "Not a memory_export backup (missing memories array)" }, null, 2);
                }
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                const source = payload?.memories ?? [];
                let imported = 0;
                let replaced = 0;
                let skipped = 0;
                let failed = 0;
                const failures = [];
                const embedderDim = await state.embedder.dim();
                for (const m of source) {
                    if (typeof m?.id !== "string" || typeof m?.text !== "string") {
                        failed += 1;
                        continue;
                    }
                    try {
                        // IMPORT_EXISTS_RAW (1.3.5): hasMemory only sees ACTIVE
                        // rows, so replace-mode imported a second active row
                        // with the same id when a digested/merged/disabled row
                        // already existed (Lance has no primary key → two
                        // physical rows per id → ambiguous lookups). Check the
                        // raw id and delete the raw row on replace.
                        const existingRows = await state.store.findRawRecordsByIds([m.id], scopes);
                        const exists = existingRows.length > 0;
                        if (exists && args.mode !== "replace") {
                            skipped += 1;
                            continue;
                        }
                        if (args.dryRun) {
                            if (exists) {
                                replaced += 1;
                            }
                            else {
                                imported += 1;
                            }
                            continue;
                        }
                        if (exists) {
                            await state.store.deleteByIdRaw(m.id);
                        }
                        let vector = Array.isArray(m.vector) ? m.vector.map(Number) : [];
                        if (vector.length !== embedderDim) {
                            try {
                                vector = await state.embedder.embed(m.text);
                            }
                            catch {
                                vector = [];
                            }
                        }
                        if (vector.length === 0 || vector.length !== embedderDim) {
                            failed += 1;
                            failures.push({ id: m.id, reason: "embedding unavailable" });
                            continue;
                        }
                        const now = Date.now();
                        await state.store.put({
                            id: m.id,
                            text: m.text,
                            vector,
                            category: typeof m.category === "string" ? m.category : "other",
                            scope: typeof m.scope === "string" ? m.scope : activeScope,
                            importance: typeof m.importance === "number" ? m.importance : 0.5,
                            timestamp: typeof m.timestamp === "number" ? m.timestamp : now,
                            lastRecalled: typeof m.lastRecalled === "number" ? m.lastRecalled : 0,
                            recallCount: typeof m.recallCount === "number" ? m.recallCount : 0,
                            projectCount: typeof m.projectCount === "number" ? m.projectCount : 0,
                            schemaVersion: typeof m.schemaVersion === "number" ? m.schemaVersion : 1,
                            embeddingModel: typeof m.embeddingModel === "string" ? m.embeddingModel : state.config.embedding.model,
                            vectorDim: vector.length,
                            metadataJson: typeof m.metadataJson === "string" ? m.metadataJson : JSON.stringify({ source: "memory_import" }),
                            sourceSessionId: typeof m.sourceSessionId === "string" ? m.sourceSessionId : undefined,
                            citationSource: typeof m.citationSource === "string" ? m.citationSource : undefined,
                            citationTimestamp: typeof m.citationTimestamp === "number" ? m.citationTimestamp : undefined,
                            citationStatus: typeof m.citationStatus === "string" ? m.citationStatus : undefined,
                            citationChain: Array.isArray(m.citationChain) ? m.citationChain : undefined,
                            confidence: typeof m.confidence === "number" ? m.confidence : undefined,
                            tags: Array.isArray(m.tags) ? m.tags : undefined,
                            status: typeof m.status === "string" ? m.status : "active",
                            parentId: typeof m.parentId === "string" ? m.parentId : undefined,
                        });
                        if (state.config.graph?.enabled && state.graph?.enabled && m.text) {
                            try {
                                state.graph.extract(m.text);
                                state.graph.indexMemory(m.id, m.text, typeof m.timestamp === "number" ? m.timestamp : now);
                            }
                            catch {
                            }
                        }
                        if (exists) {
                            replaced += 1;
                        }
                        else {
                            imported += 1;
                        }
                    }
                    catch (error) {
                        failed += 1;
                        failures.push({ id: m.id, reason: error instanceof Error ? error.message : String(error) });
                    }
                }
                return JSON.stringify({
                    mode: args.mode,
                    total: source.length,
                    imported,
                    replaced,
                    skipped,
                    failed,
                    failures: failures.slice(0, 10),
                    scopes,
                }, null, 2);
            },
        }),
        // DIMENSION_MISMATCH_REPAIR: the "vector" column's physical width is
        // fixed for the whole table (set by the first row ever written), not
        // per-scope, so this operates on every scope in the store — unlike
        // every other tool here, it does not take a `scope` argument.
        // Backs up first (always, even dryRun) so the operation is never
        // riskier than memory_export followed by memory_import(replace).
        memory_reembed: tool({
            description: "Detect (and, with confirm:true, repair) an embedding-dimension mismatch between the " +
                "configured embedder and the on-disk vector store. A mismatch happens when embedding.provider " +
                "or embedding.model changed to a different output dimension without resetting the store — " +
                "LanceDB silently corrupts new writes in that state instead of rejecting them, and dedup/" +
                "consolidation silently stop finding neighbors. Repair backs up every memory (all scopes) to " +
                "a JSON file, drops and recreates the memories table at the current embedder's dimension, and " +
                "re-embeds every memory from its stored text under its original id (graph edges and citation " +
                "chains keyed by id stay valid).",
            args: {
                dryRun: tool.schema.boolean().optional().default(true),
                confirm: tool.schema.boolean().optional().default(false),
            },
            execute: async (args) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const actualDim = await state.embedder.dim();
                const expectedDim = await state.store.getPhysicalVectorDim();
                if (expectedDim === null || expectedDim === actualDim) {
                    return JSON.stringify({
                        mismatch: false,
                        actualDim,
                        message: "No dimension mismatch detected. Nothing to repair.",
                    }, null, 2);
                }
                const scopes = await state.store.listDistinctScopes();
                const records = await state.store.exportAllRecords(scopes);
                if (args.dryRun && !args.confirm) {
                    return JSON.stringify({
                        mismatch: true,
                        expectedDim,
                        actualDim,
                        scopes,
                        recordCount: records.length,
                        message: "Dry run — no changes made. Call again with dryRun:false, confirm:true to " +
                            "repair (this drops and rebuilds the memories table; a backup is written first).",
                    }, null, 2);
                }
                if (!args.confirm) {
                    return JSON.stringify({
                        error: "Set confirm:true to actually repair — this drops and rebuilds the memories " +
                            "table (like memory_clear/memory_forget, destructive operations require confirm:true).",
                    }, null, 2);
                }
                // EMBEDDING_CONFIG_REEMBED (1.4.5): shared with the plugin's
                // automatic repair path (initializeStore) — backup → drop →
                // rebuild → re-embed, all under the original ids.
                const result = await repairEmbeddingDimension(state, actualDim);
                return JSON.stringify({
                    mismatch: true,
                    ...result,
                    failures: result.failures.slice(0, 10),
                }, null, 2);
            },
        }),
        memory_summarize: tool({
            description: "Create digests of old memories (store-level summarization). LLM abstractive digests when capture.mode=llm, offline extractive otherwise. Optionally mark originals 'digested' (replace=true) so only the digest remains in recall.",
            args: {
                scope: tool.schema.string().optional(),
                minAgeDays: tool.schema.number().int().min(2).max(3650).optional(),
                groupBy: tool.schema.enum(["category", "none"]).optional().default("category"),
                minGroupSize: tool.schema.number().int().min(2).max(100).optional(),
                targetChars: tool.schema.number().int().min(100).max(2000).optional(),
                replace: tool.schema.boolean().optional(),
                dryRun: tool.schema.boolean().optional().default(false),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const summarizeCfg = state.config.summarize ?? { enabled: true, minAgeDays: 30, minGroupSize: 3, targetChars: 500, replace: false };
                if (summarizeCfg.enabled === false) {
                    return JSON.stringify({ error: "Summarization disabled via config summarize.enabled=false" }, null, 2);
                }
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                const minAgeDays = args.minAgeDays ?? summarizeCfg.minAgeDays;
                const minGroupSize = args.minGroupSize ?? summarizeCfg.minGroupSize;
                const targetChars = args.targetChars ?? summarizeCfg.targetChars;
                const replace = args.replace ?? summarizeCfg.replace;
                const cutoff = Date.now() - minAgeDays * 24 * 60 * 60 * 1000;
                const records = await state.store.readByScopes(scopes);
                const candidates = records.filter((r) => r.timestamp < cutoff && (r.status === undefined || r.status === "active") && r.category !== "digest" && !(r.metadataJson && r.metadataJson.includes('"digestOf"')) && !(r.metadataJson && r.metadataJson.includes('"digestedInto"')));
                if (candidates.length === 0) {
                    return JSON.stringify({ minAgeDays, eligible: 0, groups: 0, digestsCreated: 0, message: "No eligible memories" }, null, 2);
                }
                const groups = new Map();
                if (args.groupBy === "none") {
                    groups.set("all", candidates);
                }
                else {
                    for (const r of candidates) {
                        const key = r.category || "other";
                        if (!groups.has(key))
                            groups.set(key, []);
                        groups.get(key).push(r);
                    }
                }
                const created = [];
                const dryRunSummary = [];
                for (const [groupKey, group] of groups) {
                    if (group.length < minGroupSize)
                        continue;
                    const entityNames = new Set();
                    for (const r of group) {
                        try {
                            const meta = JSON.parse(r.metadataJson || "{}");
                            if (Array.isArray(meta.graphEntities)) {
                                for (const e of meta.graphEntities)
                                    entityNames.add(e);
                            }
                        }
                        catch {
                        }
                    }
                    const digest = args.dryRun
                        ? null
                        : await buildGroupDigest(state, group, targetChars, groupKey, entityNames);
                    const digestText = digest && digest.text
                        ? digest.text
                        : `SUMMARY (${groupKey}) — ${group.length} memories`;
                    const ids = group.map((r) => r.id);
                    if (args.dryRun) {
                        dryRunSummary.push({ group: groupKey, memories: ids.length, digestChars: digestText.length });
                        continue;
                    }
                    const now = Date.now();
                    const digestId = generateId();
                    let vector = [];
                    try {
                        vector = await state.embedder.embed(digestText);
                    }
                    catch {
                        vector = [];
                    }
                    if (vector.length === 0) {
                        // SUMMARIZE_SKIP_GROUP (1.2.0): was a hard abort mid-loop
                        // claiming "no changes made" even when earlier groups had
                        // already been digested/replaced. Skip just this group
                        // (originals stay active) like the retention sweep does.
                        log("warn", `[summarize] embed failed for "${groupKey}" — skipping group (${group.length} memories)`);
                        continue;
                    }
                    await state.store.put({
                        id: digestId,
                        text: digestText,
                        vector,
                        category: "digest",
                        scope: digestScopeForGroup(group, activeScope),
                        importance: 0.6,
                        timestamp: now,
                        lastRecalled: 0,
                        recallCount: 0,
                        projectCount: 0,
                        schemaVersion: 1,
                        embeddingModel: state.config.embedding.model,
                        vectorDim: vector.length,
                        metadataJson: JSON.stringify({
                            source: "memory-summarize",
                            category: groupKey,
                            digestOf: ids,
                            digestKind: digest?.llm ? "llm" : "extractive",
                            digestChars: digestText.length,
                        }),
                        sourceSessionId: context.sessionID,
                        citationSource: "memory-summarize",
                    });
                    if (state.graph?.enabled) {
                        try {
                            state.graph.extract(digestText);
                            state.graph.indexMemory(digestId, digestText, now);
                        }
                        catch {
                        }
                    }
                    let digested = 0;
                    if (replace) {
                        digested = await state.store.markDigested(ids, digestId, scopes);
                    }
                    created.push({
                        digestId,
                        group: groupKey,
                        absorbed: digest?.sourceCount ?? group.length,
                        digested,
                        digestChars: digestText.length,
                    });
                }
                return JSON.stringify({
                    minAgeDays,
                    eligible: candidates.length,
                    groups: created.length + dryRunSummary.length,
                    digestsCreated: created.length,
                    dryRun: args.dryRun ? true : undefined,
                    dryRunSummary,
                    created,
                }, null, 2);
            },
        }),
        // MEMORY_RETENTION (1.0): run the digest-then-hide expiry sweep
        // manually (same rule + action as the automatic session-idle sweep).
        memory_expire: tool({
            description: "Run the memory retention sweep: fold memories that are old AND unused into per-category digests (LLM abstractive when capture.mode=llm, extractive otherwise) and mark the originals 'digested' (hidden from recall, never deleted). dryRun=true lists candidates without changing anything.",
            args: {
                scope: tool.schema.string().optional(),
                unusedDays: tool.schema.number().int().min(30).max(3650).optional(),
                minAgeDays: tool.schema.number().int().min(30).max(3650).optional(),
                digestMaxAgeDays: tool.schema.number().int().min(30).max(3650).optional(),
                minGroupSize: tool.schema.number().int().min(1).max(100).optional(),
                targetChars: tool.schema.number().int().min(100).max(2000).optional(),
                dryRun: tool.schema.boolean().optional().default(false),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                if (state.config.retention?.memory?.enabled === false && args.dryRun !== true) {
                    return JSON.stringify({ error: "Memory retention disabled via config retention.memory.enabled=false" }, null, 2);
                }
                const result = await sweepExpiredMemories(state, {
                    scope: resolveScope(args.scope, context.directory || context.worktree),
                    dryRun: args.dryRun === true,
                    unusedDays: args.unusedDays,
                    minAgeDays: args.minAgeDays,
                    digestMaxAgeDays: args.digestMaxAgeDays,
                    minGroupSize: args.minGroupSize,
                    targetChars: args.targetChars,
                });
                return JSON.stringify(result, null, 2);
            },
        }),
    };
}

// MEMORY_RETENTION (1.0): digest-then-hide expiry sweep — the shared core
// behind the memory_expire tool and the event-driven sweep in index.js
// (session.created/init/idle/compacted/deleted). Groups expired candidates by
// category, builds ONE extractive digest per group ≥ minGroupSize (embedded +
// graph-indexed, stamped source:"memory-retention" + digestOf), then marks the
// originals status:"digested" via store.markDigested (which also strips their
// graph provenance). Never deletes anything — every original is recoverable by
// re-importing a backup or flipping status back to "active".
export async function sweepExpiredMemories(state, opts = {}) {
    const retCfg = state.config?.retention?.memory ?? {
        enabled: true,
        unusedDays: 60,
        minAgeDays: 180,
        minGroupSize: 2,
        targetChars: 500,
        minImportance: 0.3,
        protectedCategories: ["digest"],
        digestMaxAgeDays: 365,
    };
    const enabledOverride = opts.enabledOverride;
    const disabled = enabledOverride === false || (enabledOverride === undefined && retCfg.enabled === false);
    // SWEEP_DRYRUN (1.2.0): a dry run may still list candidates when retention
    // is disabled (memory_expire dryRun preview); only real runs are blocked.
    if (disabled && opts.dryRun !== true) {
        return { enabled: false, unusedDays: retCfg.unusedDays, minAgeDays: retCfg.minAgeDays, eligible: 0, groups: 0, digestsCreated: 0, digested: 0, message: "Memory retention disabled via config retention.memory.enabled=false" };
    }
    if (!state.initialized)
        return { enabled: !disabled, unusedDays: retCfg.unusedDays, minAgeDays: retCfg.minAgeDays, eligible: 0, groups: 0, digestsCreated: 0, digested: 0, message: "Not initialized" };
    const activeScope = opts.scope ?? state.defaultScope ?? "global";
    const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope ?? true);
    const unusedDays = opts.unusedDays ?? retCfg.unusedDays;
    const minAgeDays = opts.minAgeDays ?? retCfg.minAgeDays;
    const minGroupSize = opts.minGroupSize ?? retCfg.minGroupSize;
    const targetChars = opts.targetChars ?? retCfg.targetChars;
    const minImportance = opts.minImportance ?? retCfg.minImportance;
    const protectedCategories = opts.protectedCategories ?? retCfg.protectedCategories;
    // DIGEST_EXPIRY_SAFE_NUM (1.6.2): raw Number() on a malformed
    // digestMaxAgeDays (e.g. "abc") produced NaN; Math.max(1, NaN) = NaN,
    // and `days > NaN` is always false → digest expiry silently became a
    // no-op. toNumber falls back to 365; Math.max guards negatives.
    const digestMaxAgeDaysConfig = toNumber(opts.digestMaxAgeDays ?? retCfg.digestMaxAgeDays ?? 365, 365);
    const digestMaxAgeDays = Math.max(1, Number.isFinite(digestMaxAgeDaysConfig) ? digestMaxAgeDaysConfig : 365);
    const records = await state.store.readByScopes(scopes);
    const candidates = retentionCandidates(records, { unusedDays, minAgeDays, minImportance, protectedCategories });
    // DIGEST_EXPIRY (1.4.3): digests themselves used to live forever as active
    // rows, so the store grew without bound no matter how often the sweep ran.
    // Once a digest passes digestMaxAgeDays (default 365) its source memories
    // are long since digested and its summary is stale — hard-delete it
    // (deleteByIdForce also strips its graph provenance and invalidates the
    // scope cache). Runs even when no new candidates exist (the early return
    // below would otherwise skip cleanup forever). dryRun lists without
    // deleting.
    const staleDigests = expiredDigestCandidates(records, digestMaxAgeDays);
    const dryRun = opts.dryRun === true;
    let digestsExpired = 0;
    const expiredDigests = [];
    if (staleDigests.length > 0 && !dryRun) {
        for (const r of staleDigests) {
            try {
                if (await state.store.deleteByIdForce(r.id)) {
                    digestsExpired += 1;
                    expiredDigests.push({ id: r.id, category: r.category, digestChars: r.text?.length ?? 0 });
                    // DIGEST_EXPIRY_RESTORE (1.6.2): the digest is gone, so
                    // its digested originals must not stay hidden behind a
                    // deleted id — restore them to active recall.
                    const restored = await state.store.unDigestOriginals(r.id, scopes);
                    if (restored > 0) {
                        log("info", `[retention] digest ${r.id} expired; restored ${restored} original(s) to active`);
                    }
                }
            }
            catch (error) {
                log("warn", `[retention] digest expiry failed for "${r.id}": ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    if (candidates.length === 0) {
        return { enabled: !disabled, unusedDays, minAgeDays, digestMaxAgeDays, eligible: 0, groups: 0, digestsCreated: 0, digested: 0, digestsEligible: staleDigests.length, digestsExpired: dryRun ? 0 : digestsExpired, expiredDigests: dryRun ? [] : expiredDigests, dryRun: dryRun ? true : undefined, message: "No expired memories" };
    }
    const groups = new Map();
    for (const r of candidates) {
        const key = r.category || "other";
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push(r);
    }
    const created = [];
    const dryRunSummary = [];
    let digestedTotal = 0;
    for (const [groupKey, group] of groups) {
        if (group.length < minGroupSize)
            continue;
        const entityNames = new Set();
        for (const r of group) {
            try {
                const meta = JSON.parse(r.metadataJson || "{}");
                if (Array.isArray(meta.graphEntities)) {
                    for (const e of meta.graphEntities)
                        entityNames.add(e);
                }
            }
            catch { }
        }
        const digest = dryRun
            ? null
            : await buildGroupDigest(state, group, targetChars, groupKey, entityNames);
        const digestText = digest && digest.text
            ? digest.text
            : `SUMMARY (${groupKey}) — ${group.length} memories`;
        const ids = group.map((r) => r.id);
        if (dryRun) {
            dryRunSummary.push({ group: groupKey, memories: ids.length, digestChars: digestText.length });
            continue;
        }
        const now = Date.now();
        const digestId = generateId();
        let vector = [];
        try {
            vector = await state.embedder.embed(digestText);
        }
        catch (error) {
            log("warn", `[retention] embed failed for "${groupKey}": ${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        if (vector.length === 0)
            continue;
        try {
            await state.store.put({
                id: digestId,
                text: digestText,
                vector,
                category: "digest",
                scope: digestScopeForGroup(group, activeScope),
                importance: 0.6,
                timestamp: now,
                lastRecalled: 0,
                recallCount: 0,
                projectCount: 0,
                schemaVersion: 1,
                embeddingModel: state.config.embedding.model,
                vectorDim: vector.length,
                metadataJson: JSON.stringify({
                    source: "memory-retention",
                    category: groupKey,
                    digestOf: ids,
                    digestKind: digest?.llm ? "llm" : "extractive",
                    digestChars: digestText.length,
                }),
            });
            if (state.graph?.enabled) {
                try {
                    state.graph.extract(digestText);
                    state.graph.indexMemory(digestId, digestText, now);
                }
                catch { }
            }
            const digested = await state.store.markDigested(ids, digestId, scopes);
            digestedTotal += digested;
            created.push({ digestId, group: groupKey, absorbed: digest?.sourceCount ?? group.length, digested, digestChars: digestText.length });
        }
        catch (error) {
            log("warn", `[retention] digest creation failed for "${groupKey}": ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return {
        enabled: !disabled,
        unusedDays,
        minAgeDays,
        digestMaxAgeDays,
        eligible: candidates.length,
        groups: created.length + dryRunSummary.length,
        digestsCreated: created.length,
        digested: digestedTotal,
        digestsEligible: staleDigests.length,
        digestsExpired: dryRun ? 0 : digestsExpired,
        expiredDigests: dryRun ? [] : expiredDigests,
        dryRun: dryRun ? true : undefined,
        dryRunSummary,
        digests: created,
    };
}
