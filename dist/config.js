import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { clamp, expandHomePath, parseJsonObject, toBoolean, toNumber } from "./utils.js";
import { log } from "./logger.js";
const DEFAULT_DB_PATH = "~/.opencode/memory/lancedb";
const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const SIDECAR_FILE = "opencode-memory-pro.json";
export function resolveMemoryConfig(config, worktree) {
    const legacyRaw = (config?.memory ?? {});
    const sidecarRaw = loadSidecarConfig(worktree);
    const raw = mergeMemoryConfig(legacyRaw, sidecarRaw);
    const embeddingRaw = (raw.embedding ?? {});
    const retrievalRaw = (raw.retrieval ?? {});
    const modeRaw = firstString(process.env.OPENCODE_MEMORY_PRO_RETRIEVAL_MODE, retrievalRaw.mode) ?? "hybrid";
    const mode = modeRaw === "vector" ? "vector" : "hybrid";
    const provider = firstString(process.env.OPENCODE_MEMORY_PRO_PROVIDER, raw.provider) ?? "opencode-memory-pro";
    const dbPath = expandHomePath(firstString(process.env.OPENCODE_MEMORY_PRO_DB_PATH, raw.dbPath) ?? DEFAULT_DB_PATH);
    const vectorWeight = clamp(toNumber(process.env.OPENCODE_MEMORY_PRO_VECTOR_WEIGHT ?? retrievalRaw.vectorWeight, 0.7), 0, 1);
    const bm25Weight = clamp(toNumber(process.env.OPENCODE_MEMORY_PRO_BM25_WEIGHT ?? retrievalRaw.bm25Weight, 0.3), 0, 1);
    // FUZZY_CHANNEL (1.4.2): fuse.js fuzzy-match channel participates in the
    // RRF merge alongside vector + BM25. Weight 0 disables it entirely.
    const fuzzyWeight = clamp(toNumber(process.env.OPENCODE_MEMORY_PRO_FUZZY_WEIGHT ?? retrievalRaw.fuzzyWeight, 0.15), 0, 1);
    const fuzzyThreshold = clamp(toNumber(process.env.OPENCODE_MEMORY_PRO_FUZZY_THRESHOLD ?? retrievalRaw.fuzzyThreshold, 0.5), 0, 1);
    const weightSum = vectorWeight + bm25Weight + fuzzyWeight;
    const normalizedVectorWeight = weightSum > 0 ? vectorWeight / weightSum : 0.7;
    const normalizedBm25Weight = weightSum > 0 ? bm25Weight / weightSum : 0.3;
    const normalizedFuzzyWeight = weightSum > 0 ? fuzzyWeight / weightSum : 0;
    // RRF_K_CLAMP (1.6.2): rrfK had a floor but NO upper clamp — an absurdly
    // large value (e.g. 1e9) made every RRF score collapse toward 1/(k+rank)≈0
    // then ×(rrfK+1) → a flat 1.0 across ALL results, destroying the merge.
    // Bound to [1, 1000] (default 60; 1000 already flattens ranking, far
    // beyond any real intent).
    const rrfK = Math.max(1, Math.min(1000, Math.floor(toNumber(process.env.OPENCODE_MEMORY_PRO_RRF_K ?? retrievalRaw.rrfK, 60))));
    const recencyBoost = toBoolean(process.env.OPENCODE_MEMORY_PRO_RECENCY_BOOST ?? retrievalRaw.recencyBoost, true);
    const recencyHalfLifeHours = Math.max(1, toNumber(process.env.OPENCODE_MEMORY_PRO_RECENCY_HALF_LIFE_HOURS ?? retrievalRaw.recencyHalfLifeHours, 72));
    const importanceWeight = clamp(toNumber(process.env.OPENCODE_MEMORY_PRO_IMPORTANCE_WEIGHT ?? retrievalRaw.importanceWeight, 0.4), 0, 2);
    const feedbackWeight = clamp(toNumber(process.env.OPENCODE_MEMORY_PRO_FEEDBACK_WEIGHT ?? retrievalRaw.feedbackWeight, 0.3), 0, 1);
    const embeddingProvider = resolveEmbeddingProvider(firstString(process.env.OPENCODE_MEMORY_PRO_EMBEDDING_PROVIDER, embeddingRaw.provider));
    const embeddingModel = embeddingProvider === "openai"
        ? firstString(process.env.OPENCODE_MEMORY_PRO_OPENAI_MODEL, process.env.OPENCODE_MEMORY_PRO_EMBEDDING_MODEL, embeddingRaw.model)
        : firstString(process.env.OPENCODE_MEMORY_PRO_EMBEDDING_MODEL, embeddingRaw.model) ?? "nomic-embed-text";
    const embeddingBaseUrl = embeddingProvider === "openai"
        ? firstString(process.env.OPENCODE_MEMORY_PRO_OPENAI_BASE_URL, embeddingRaw.baseUrl) ?? DEFAULT_OPENAI_BASE_URL
        : firstString(process.env.OPENCODE_MEMORY_PRO_OLLAMA_BASE_URL, embeddingRaw.baseUrl) ?? DEFAULT_OLLAMA_BASE_URL;
    const embeddingApiKey = embeddingProvider === "openai"
        ? firstString(process.env.OPENCODE_MEMORY_PRO_OPENAI_API_KEY, embeddingRaw.apiKey)
        : undefined;
    const timeoutEnv = embeddingProvider === "openai"
        ? process.env.OPENCODE_MEMORY_PRO_OPENAI_TIMEOUT_MS ?? process.env.OPENCODE_MEMORY_PRO_EMBEDDING_TIMEOUT_MS
        : process.env.OPENCODE_MEMORY_PRO_EMBEDDING_TIMEOUT_MS;
    const timeoutRaw = timeoutEnv ?? embeddingRaw.timeoutMs;
    const retryRaw = (embeddingRaw.retry ?? {});
    const retryEnabled = toBoolean(process.env.OPENCODE_MEMORY_PRO_EMBEDDING_RETRY_ENABLED ?? retryRaw.enabled, true);
    const retryMaxAttempts = Math.max(1, Math.floor(toNumber(process.env.OPENCODE_MEMORY_PRO_EMBEDDING_RETRY_MAX_ATTEMPTS ?? retryRaw.maxAttempts, 3)));
    const retryInitialDelayMs = Math.max(100, Math.floor(toNumber(process.env.OPENCODE_MEMORY_PRO_EMBEDDING_RETRY_INITIAL_DELAY_MS ?? retryRaw.initialDelayMs, 1000)));
    const retryBackoffMultiplier = Math.max(1, toNumber(process.env.OPENCODE_MEMORY_PRO_EMBEDDING_RETRY_BACKOFF_MULTIPLIER ?? retryRaw.backoffMultiplier, 2));
    const injection = resolveInjectionConfig(raw, process.env);
    const dedup = resolveDedupConfig(raw, process.env);
    const graph = resolveGraphConfig(raw, process.env);
    // LLM_CAPTURE (1.1): capture mode + LLM settings for SDK-transport
    // extraction/summarization. See resolveCaptureConfig.
    const capture = resolveCaptureConfig(raw, process.env);
    // MEMORY_LIFECYCLE_TOOLS: offline store-level summarization (0.9) —
    // extractive digests of old memories. See resolveSummarizeConfig.
    const summarize = resolveSummarizeConfig(raw, process.env);
    const resolvedConfig = {
        provider,
        dbPath,
        embedding: {
            provider: embeddingProvider,
            model: embeddingModel ?? "",
            baseUrl: embeddingBaseUrl,
            apiKey: embeddingApiKey,
            timeoutMs: Math.max(500, Math.floor(toNumber(timeoutRaw, 6000))),
            retry: {
                enabled: retryEnabled,
                maxAttempts: retryMaxAttempts,
                initialDelayMs: retryInitialDelayMs,
                backoffMultiplier: retryBackoffMultiplier,
            },
        },
        retrieval: {
            mode,
            vectorWeight: normalizedVectorWeight,
            bm25Weight: normalizedBm25Weight,
            fuzzyWeight: normalizedFuzzyWeight,
            fuzzyThreshold,
            minScore: clamp(toNumber(process.env.OPENCODE_MEMORY_PRO_MIN_SCORE ?? retrievalRaw.minScore, 0.3), 0, 1),
            rrfK,
            recencyBoost,
            recencyHalfLifeHours,
            importanceWeight,
            feedbackWeight,
        },
        injection,
        dedup,
        graph,
        summarize,
        capture,
        // SCOPING_TOGGLE: "global" (default) collapses all scopes to "global"
        // (single-user mode); "project" restores upstream per-project scoping.
        scoping: (process.env.OPENCODE_MEMORY_PRO_SCOPING ?? raw.scoping ?? "global") === "project" ? "project" : "global",
        includeGlobalScope: toBoolean(process.env.OPENCODE_MEMORY_PRO_INCLUDE_GLOBAL_SCOPE ?? raw.includeGlobalScope, true),
        globalDetectionThreshold: Math.max(1, Math.floor(toNumber(process.env.OPENCODE_MEMORY_PRO_GLOBAL_DETECTION_THRESHOLD ?? raw.globalDetectionThreshold, 2))),
        globalDiscountFactor: clamp(toNumber(process.env.OPENCODE_MEMORY_PRO_GLOBAL_DISCOUNT_FACTOR ?? raw.globalDiscountFactor, 0.7), 0, 1),
        unusedDaysThreshold: Math.max(1, Math.floor(toNumber(process.env.OPENCODE_MEMORY_PRO_UNUSED_DAYS_THRESHOLD ?? raw.unusedDaysThreshold, 30))),
        minCaptureChars: Math.max(30, Math.floor(toNumber(process.env.OPENCODE_MEMORY_PRO_MIN_CAPTURE_CHARS ?? raw.minCaptureChars, 80))),
        maxEntriesPerScope: Math.max(50, Math.floor(toNumber(process.env.OPENCODE_MEMORY_PRO_MAX_ENTRIES_PER_SCOPE ?? raw.maxEntriesPerScope, 3000))),
        retention: resolveRetentionConfig(raw, process.env, { recencyHalfLifeHours, importanceWeight, feedbackWeight }),
        logging: resolveLoggingConfig(raw, process.env),
    };
    validateEmbeddingConfig(resolvedConfig.embedding);
    return resolvedConfig;
}
// LOGGING_CONFIG (1.1.4): level = minimum level emitted (debug|info|warn|error),
// file = append-only crash-surviving log sink. Environment overrides always win
// so an emergency OPENCODE_MEMORY_PRO_LOG_FILE works before sidecar resolution.
function resolveLoggingConfig(raw, env) {
    const loggingRaw = (raw.logging ?? {});
    const levelRaw = firstString(env.OPENCODE_MEMORY_PRO_LOG_LEVEL, loggingRaw.level) ?? "info";
    const level = levelRaw === "debug" || levelRaw === "warn" || levelRaw === "error" || levelRaw === "info" ? levelRaw : "info";
    return {
        level,
        file: firstString(env.OPENCODE_MEMORY_PRO_LOG_FILE, loggingRaw.file) ?? null,
    };
}
function resolveEmbeddingProvider(raw) {
    if (!raw || raw === "ollama")
        return "ollama";
    if (raw === "openai")
        return "openai";
    throw new Error(`[opencode-memory-pro] Invalid embedding provider "${raw}". Expected "ollama" or "openai".`);
}
function resolveInjectionMode(raw) {
    if (raw === "fixed" || raw === "budget" || raw === "adaptive")
        return raw;
    return "fixed";
}
function resolveSummarizationMode(raw) {
    if (raw === "none" || raw === "truncate" || raw === "extract" || raw === "auto")
        return raw;
    return "none";
}
function resolveCodeTruncationMode(raw) {
    if (raw === "smart" || raw === "signature" || raw === "preserve")
        return raw;
    return "smart";
}
function resolveDedupConfig(raw, env) {
    const dedupRaw = (raw.dedup ?? {});
    const enabled = toBoolean(env.OPENCODE_MEMORY_PRO_DEDUP_ENABLED ?? dedupRaw.enabled, true);
    const writeThreshold = clamp(toNumber(env.OPENCODE_MEMORY_PRO_DEDUP_WRITE_THRESHOLD ?? dedupRaw.writeThreshold, 0.92), 0.0, 1.0);
    const consolidateThreshold = clamp(toNumber(env.OPENCODE_MEMORY_PRO_DEDUP_CONSOLIDATE_THRESHOLD ?? dedupRaw.consolidateThreshold, 0.95), 0.0, 1.0);
    // DEDUP_CLAMP_LOG (1.6.2): the clamp warning compared candidateLimit
    // against the RAW CONFIG value only — with an in-range ENV override set,
    // it logged a misleading "clamped from 50 to 30" when nothing was
    // clamped. Compare against the EFFECTIVE raw value (env wins) so the
    // warn fires only when the actual source was out of bounds.
    const rawCandidateLimit = toNumber(env.OPENCODE_MEMORY_PRO_DEDUP_CANDIDATE_LIMIT ?? dedupRaw.candidateLimit, 50);
    const candidateLimit = clamp(rawCandidateLimit, 10, 200);
    if (candidateLimit !== rawCandidateLimit) {
        log("warn", `[config] dedup.candidateLimit clamped from ${rawCandidateLimit} to ${candidateLimit}`);
    }
    return { enabled, writeThreshold, consolidateThreshold, candidateLimit };
}
// LLM_CAPTURE (1.1): capture mode + LLM settings. mode is "heuristics"
// (keyword-driven, offline, zero LLM — exactly the historical pipeline) or
// "llm" (SDK-transport structured extraction + LLM-written digests). The LLM
// is addressed by opencode provider ID + model ID; opencode owns routing,
// auth, and base URLs, so the plugin never sees an API key or baseUrl.
// Defaults point at the user's chosen summarization model.
function resolveCaptureConfig(raw, env) {
    const captureRaw = (raw.capture ?? {});
    const llmRaw = (captureRaw.llm ?? {});
    const modeRaw = firstString(env.OPENCODE_MEMORY_PRO_CAPTURE_MODE, captureRaw.mode) ?? "heuristics";
    const mode = modeRaw === "llm" ? "llm" : "heuristics";
    return {
        mode,
        llm: {
            provider: firstString(env.OPENCODE_MEMORY_PRO_CAPTURE_LLM_PROVIDER, llmRaw.provider) ?? "openrouter",
            model: firstString(env.OPENCODE_MEMORY_PRO_CAPTURE_LLM_MODEL, llmRaw.model) ?? "z-ai/glm-5.3-flash",
        },
    };
}
// GRAPH_STORE_PHASE1 marker: resolves the offline entity graph settings
function resolveGraphConfig(raw, env) {
    const graphRaw = (raw.graph ?? {});
    const enabled = toBoolean(env.OPENCODE_MEMORY_PRO_GRAPH_ENABLED ?? graphRaw.enabled, true);
    const boostLambda = clamp(toNumber(env.OPENCODE_MEMORY_PRO_GRAPH_BOOST_LAMBDA ?? graphRaw.boostLambda, 0.3), 0, 1);
    const dbPath = expandHomePath(firstString(env.OPENCODE_MEMORY_PRO_GRAPH_DB_PATH, graphRaw.dbPath) ?? "~/.opencode/memory/graph.db");
    const maxEntitiesPerMemory = Math.max(5, Math.floor(toNumber(graphRaw.maxEntitiesPerMemory, 20)));
    const maxEdgeProvenance = Math.max(5, Math.floor(toNumber(graphRaw.maxEdgeProvenance, 20)));
    // GRAPH_STORE_PHASE2: typed-relation extraction ("X uses Y", "X depends on Z", ...)
    // on top of the co-occurrence graph. On by default; env override available.
    const typedEdges = toBoolean(env.OPENCODE_MEMORY_PRO_GRAPH_TYPED_EDGES ?? graphRaw.typedEdges, true);
    // GRAPH_STORE_PHASE2B: graph-expansion recall (BFS from query entities).
    // PRECISION_TUNING (1.6.0): expansion recall is OFF by default — measured
    // on the live store (scripts/precision-tune.mjs) it injected tangentially
    // related memories into top-5 (expansionNoiseTop5=12 → 0) and suppressed
    // MRR@5 (0.556 → 0.917 with boost-only). Entity co-occurrence boost
    // (boostLambda) stays on; expansion is opt-in via config/env.
    const expansionEnabled = toBoolean(env.OPENCODE_MEMORY_PRO_GRAPH_EXPANSION_ENABLED ?? graphRaw.expansionEnabled, false);
    const maxHops = Math.min(4, Math.max(1, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_GRAPH_MAX_HOPS ?? graphRaw.maxHops, 2))));
    const expansionLimit = Math.max(1, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_GRAPH_EXPANSION_LIMIT ?? graphRaw.expansionLimit, 5)));
    const expansionLambda = clamp(toNumber(env.OPENCODE_MEMORY_PRO_GRAPH_EXPANSION_LAMBDA ?? graphRaw.expansionLambda, 0.3), 0, 1);
    return { enabled, dbPath, boostLambda, maxEntitiesPerMemory, maxEdgeProvenance, typedEdges, expansionEnabled, maxHops, expansionLimit, expansionLambda };
}
// RETENTION_SCORING (1.5.5): weights for scope-cache truncation ("which
// records survive when a scope exceeds maxRecordsPerScope"). Defaults to the
// resolved retrieval weights (so "what ranks well ≈ what survives"), but
// retention.scoring.* can diverge from retrieval.* — protecting old valuable
// memories in the cache without altering live search ranking. Env overrides
// always win (emergency tuning before sidecar resolution).
function resolveRetentionScoring(raw, env, retrievalWeights) {
    const scoringRaw = (raw.retention?.scoring) ?? {};
    return {
        recencyHalfLifeHours: Math.max(1, toNumber(env.OPENCODE_MEMORY_PRO_RETENTION_SCORING_RECENCY_HALF_LIFE_HOURS ?? scoringRaw.recencyHalfLifeHours, retrievalWeights.recencyHalfLifeHours)),
        importanceWeight: clamp(toNumber(env.OPENCODE_MEMORY_PRO_RETENTION_SCORING_IMPORTANCE_WEIGHT ?? scoringRaw.importanceWeight, retrievalWeights.importanceWeight), 0, 2),
        feedbackWeight: clamp(toNumber(env.OPENCODE_MEMORY_PRO_RETENTION_SCORING_FEEDBACK_WEIGHT ?? scoringRaw.feedbackWeight, retrievalWeights.feedbackWeight), 0, 1),
    };
}
// MEMORY_RETENTION (1.0): memory-level digest-then-hide expiry, layered on top
// of the events-table TTL. A memory is expired when it is old enough
// (minAgeDays) AND unused for unusedDays (lastRecalled, or timestamp if never
// recalled), then folded into an extractive digest and marked status:"digested"
// (hidden from recall, never deleted). minGroupSize = smallest per-category
// group that earns a digest; targetChars = digest length; minImportance =
// importance floor (protects high-value rows); protectedCategories = never
// expired (default: digests themselves).
function resolveRetentionConfig(raw, env, retrievalWeights) {
    const rawRetention = raw.retention ?? {};
    let eventsDays = Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_RETENTION_EVENTS_DAYS ?? rawRetention.effectivenessEventsDays, 90));
    if (eventsDays < 0) {
        log("warn", `[config] retention.effectivenessEventsDays cannot be negative (${eventsDays}), using 90`);
        eventsDays = 90;
    }
    const memoryRaw = rawRetention.memory ?? {};
    const protectedRaw = memoryRaw.protectedCategories;
    const memory = {
        enabled: toBoolean(env.OPENCODE_MEMORY_PRO_RETENTION_MEMORY_ENABLED ?? memoryRaw.enabled, true),
        unusedDays: Math.min(3650, Math.max(30, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_RETENTION_MEMORY_UNUSED_DAYS ?? memoryRaw.unusedDays, 60)))),
        minAgeDays: Math.min(3650, Math.max(30, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_RETENTION_MEMORY_MIN_AGE_DAYS ?? memoryRaw.minAgeDays, 180)))),
        minGroupSize: Math.min(100, Math.max(1, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_RETENTION_MEMORY_MIN_GROUP_SIZE ?? memoryRaw.minGroupSize, 2)))),
        targetChars: Math.min(2000, Math.max(100, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_RETENTION_MEMORY_TARGET_CHARS ?? memoryRaw.targetChars, 500)))),
        minImportance: clamp(toNumber(env.OPENCODE_MEMORY_PRO_RETENTION_MEMORY_MIN_IMPORTANCE ?? memoryRaw.minImportance, 0.3), 0, 1),
        // PROTECTED_CATEGORIES_EMPTY (1.6.2): an explicit [] used to fall back to
        // the ["digest"] default, so digest protection could not be disabled.
        // Absent → default ["digest"]; any present array (including []) is
        // honored verbatim (string-filtered).
        protectedCategories: protectedRaw === undefined
            ? ["digest"]
            : (Array.isArray(protectedRaw) ? protectedRaw.filter((c) => typeof c === "string") : ["digest"]),
    };
    return {
        effectivenessEventsDays: eventsDays,
        memory,
        // RETENTION_SCORING (1.5.5): defaults from the resolved retrieval
        // weights; see resolveRetentionScoring.
        scoring: resolveRetentionScoring(raw, env, retrievalWeights),
    };
}
// MEMORY_LIFECYCLE_TOOLS: defaults for the offline digest summarizer (0.9).
    // minAgeDays = how old a memory must be before it is digest-eligible;
    // minGroupSize = smallest group that earns a digest; targetChars = digest
    // length; replace = whether originals are marked "digested" (hidden from
    // recall) once absorbed.
    function resolveSummarizeConfig(raw, env) {
        const summarizeRaw = (raw.summarize ?? {});
        return {
            enabled: toBoolean(env.OPENCODE_MEMORY_PRO_SUMMARIZE_ENABLED ?? summarizeRaw.enabled, true),
            minAgeDays: Math.min(3650, Math.max(7, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_SUMMARIZE_MIN_AGE_DAYS ?? summarizeRaw.minAgeDays, 30)))),
            minGroupSize: Math.min(100, Math.max(2, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_SUMMARIZE_MIN_GROUP_SIZE ?? summarizeRaw.minGroupSize, 3)))),
            targetChars: Math.min(2000, Math.max(100, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_SUMMARIZE_TARGET_CHARS ?? summarizeRaw.targetChars, 500)))),
            replace: toBoolean(env.OPENCODE_MEMORY_PRO_SUMMARIZE_REPLACE ?? summarizeRaw.replace, false),
        };
    }
    function resolveInjectionConfig(raw, env) {
    const injectionRaw = (raw.injection ?? {});
    const codeSummarizationRaw = (injectionRaw.codeSummarization ?? {});
    return {
        mode: resolveInjectionMode(env.OPENCODE_MEMORY_PRO_INJECTION_MODE ?? injectionRaw.mode),
        maxMemories: Math.max(1, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_MAX_MEMORIES ?? injectionRaw.maxMemories, 3))),
        minMemories: Math.max(1, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_MIN_MEMORIES ?? injectionRaw.minMemories, 1))),
        budgetTokens: Math.max(256, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_BUDGET_TOKENS ?? injectionRaw.budgetTokens, 4096))),
        maxCharsPerMemory: Math.max(100, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_MAX_CHARS ?? injectionRaw.maxCharsPerMemory, 1200))),
        summarization: resolveSummarizationMode(env.OPENCODE_MEMORY_PRO_INJECTION_SUMMARIZATION ?? injectionRaw.summarization),
        summaryTargetChars: Math.max(50, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_SUMMARY_TARGET_CHARS ?? injectionRaw.summaryTargetChars, 300))),
        scoreDropTolerance: clamp(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_SCORE_DROP_TOLERANCE ?? injectionRaw.scoreDropTolerance, 0.15), 0, 1),
        injectionFloor: clamp(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_FLOOR ?? injectionRaw.injectionFloor, 0.2), 0, 1),
        codeSummarization: {
            enabled: toBoolean(env.OPENCODE_MEMORY_PRO_CODE_SUMMARIZATION_ENABLED ?? codeSummarizationRaw.enabled, true),
            pureCodeThreshold: Math.max(100, Math.floor(toNumber(codeSummarizationRaw.pureCodeThreshold, 500))),
            maxCodeLines: Math.max(5, Math.floor(toNumber(codeSummarizationRaw.maxCodeLines, 15))),
            codeTruncationMode: resolveCodeTruncationMode(codeSummarizationRaw.codeTruncationMode),
            preserveComments: toBoolean(codeSummarizationRaw.preserveComments, true),
            preserveImports: toBoolean(codeSummarizationRaw.preserveImports, false),
        },
        taskTypeProfiles: {
            coding: {
                maxMemories: Math.max(1, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_CODING_MAX_MEMORIES, 4))),
                budgetTokens: Math.max(256, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_CODING_BUDGET_TOKENS, 5120))),
                summaryTargetChars: Math.max(50, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_CODING_SUMMARY_CHARS, 400))),
                categoryWeights: { decision: 1.5, entity: 1.2, fact: 1.0, preference: 0.8, other: 0.5 },
            },
            documentation: {
                maxMemories: Math.max(1, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_DOCS_MAX_MEMORIES, 3))),
                budgetTokens: Math.max(256, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_DOCS_BUDGET_TOKENS, 3072))),
                summaryTargetChars: Math.max(50, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_DOCS_SUMMARY_CHARS, 500))),
                categoryWeights: { decision: 1.4, fact: 1.3, entity: 1.2, preference: 0.8, other: 0.5 },
            },
            review: {
                maxMemories: Math.max(1, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_REVIEW_MAX_MEMORIES, 3))),
                budgetTokens: Math.max(256, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_REVIEW_BUDGET_TOKENS, 4096))),
                summaryTargetChars: Math.max(50, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_REVIEW_SUMMARY_CHARS, 300))),
                categoryWeights: { preference: 1.4, decision: 1.2, entity: 1.0, fact: 0.9, other: 0.5 },
            },
            release: {
                maxMemories: Math.max(1, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_RELEASE_MAX_MEMORIES, 4))),
                budgetTokens: Math.max(256, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_RELEASE_BUDGET_TOKENS, 6144))),
                summaryTargetChars: Math.max(50, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_RELEASE_SUMMARY_CHARS, 350))),
                categoryWeights: { decision: 1.5, entity: 1.3, fact: 1.2, preference: 0.8, other: 0.5 },
            },
            general: {
                maxMemories: Math.max(1, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_GENERAL_MAX_MEMORIES, 3))),
                budgetTokens: Math.max(256, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_GENERAL_BUDGET_TOKENS, 4096))),
                summaryTargetChars: Math.max(50, Math.floor(toNumber(env.OPENCODE_MEMORY_PRO_INJECTION_GENERAL_SUMMARY_CHARS, 300))),
                categoryWeights: { decision: 1.3, fact: 1.0, entity: 1.0, preference: 0.9, other: 0.5 },
            },
        },
    };
}
function validateEmbeddingConfig(embedding) {
    if (embedding.provider !== "openai")
        return;
    if (!embedding.apiKey) {
        throw new Error("[opencode-memory-pro] OpenAI embedding provider requires apiKey. Set embedding.apiKey or OPENCODE_MEMORY_PRO_OPENAI_API_KEY.");
    }
    if (!embedding.model) {
        throw new Error("[opencode-memory-pro] OpenAI embedding provider requires model. Set embedding.model or OPENCODE_MEMORY_PRO_OPENAI_MODEL.");
    }
}
function loadSidecarConfig(worktree) {
    if (process.env.OPENCODE_MEMORY_PRO_SKIP_SIDECAR === "true") {
        return {};
    }
    const configPath = firstString(process.env.OPENCODE_MEMORY_PRO_CONFIG_PATH);
    const candidates = [
        join(expandHomePath("~/.opencode"), SIDECAR_FILE),
        join(expandHomePath("~/.config/opencode"), SIDECAR_FILE),
        worktree ? join(worktree, ".opencode", SIDECAR_FILE) : undefined,
        configPath,
    ];
    let merged = {};
    for (const candidate of candidates) {
        if (!candidate)
            continue;
        const parsed = readConfigFile(candidate);
        if (parsed) {
            merged = mergeMemoryConfig(merged, parsed);
        }
    }
    return merged;
}
function readConfigFile(filePath) {
    const expanded = expandHomePath(filePath);
    if (!existsSync(expanded))
        return null;
    try {
        return parseJsonObject(readFileSync(expanded, "utf8"), {});
    }
    catch {
        return null;
    }
}
export function mergeMemoryConfig(base, override) {
    return {
        ...base,
        ...override,
        embedding: {
            ...(base.embedding ?? {}),
            ...(override.embedding ?? {}),
        },
        retrieval: {
            ...(base.retrieval ?? {}),
            ...(override.retrieval ?? {}),
        },
        injection: {
            ...(base.injection ?? {}),
            ...(override.injection ?? {}),
            codeSummarization: {
                ...((base.injection ?? {}).codeSummarization ?? {}),
                ...((override.injection ?? {}).codeSummarization ?? {}),
            },
        },
        dedup: {
            ...(base.dedup ?? {}),
            ...(override.dedup ?? {}),
        },
        graph: {
            ...(base.graph ?? {}),
            ...(override.graph ?? {}),
        },
        capture: {
            ...(base.capture ?? {}),
            ...(override.capture ?? {}),
            llm: {
                ...((base.capture ?? {}).llm ?? {}),
                ...((override.capture ?? {}).llm ?? {}),
            },
        },
        // CONFIG_MERGE_FIX (1.2.1): retention/summarize/logging were replaced
        // wholesale by a sidecar fragment — a sidecar that only sets e.g.
        // retention.memory silently dropped every other legacy retention key
        // (effectivenessEventsDays, protectedCategories, ...). Matches the
        // deep-merge pattern used for embedding/retrieval/injection/dedup.
        retention: {
            ...(base.retention ?? {}),
            ...(override.retention ?? {}),
            memory: {
                ...((base.retention ?? {}).memory ?? {}),
                ...((override.retention ?? {}).memory ?? {}),
            },
            // RETENTION_SCORING (1.5.5): deep-merge retention.scoring so a
            // sidecar fragment that only sets e.g. importanceWeight doesn't
            // drop the other scoring keys.
            scoring: {
                ...((base.retention ?? {}).scoring ?? {}),
                ...((override.retention ?? {}).scoring ?? {}),
            },
        },
        summarize: {
            ...(base.summarize ?? {}),
            ...(override.summarize ?? {}),
        },
        logging: {
            ...(base.logging ?? {}),
            ...(override.logging ?? {}),
        },
    };
}
function firstString(...values) {
    for (const value of values) {
        if (typeof value === "string" && value.trim().length > 0) {
            return value.trim();
        }
    }
    return undefined;
}
