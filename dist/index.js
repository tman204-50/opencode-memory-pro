import { resolveMemoryConfig } from "./config.js";
import { createEmbedder } from "./embedder.js";
import { extractCaptureCandidate } from "./extract.js";
import { extractPreferenceSignals, aggregatePreferences, resolveConflicts, buildPreferenceInjection } from "./preference.js";
import { buildScopeFilter, deriveProjectScope, setScopingConfigSource } from "./scope.js";
import { MemoryStore } from "./store.js";
import { generateId, classifyFailure, parseJsonObject } from "./utils.js";
import { initLogger, configureLogger, log } from "./logger.js";
import { calculateInjectionLimit, createSummarizationConfig, summarizeContent, truncateText } from "./summarize.js";
import { requestLLMCapture, isOwnSession } from "./llm.js";
import { createMemoryTools, createFeedbackTools, createEpisodicTools } from "./tools/index.js";
import { sweepExpiredMemories, repairEmbeddingDimension } from "./tools/memory.js";
import { createGraphStore } from "./graph.js";
import { startSpan } from "./timing.js";
const PLUGIN_VERSION = "1.6.2";
const SCHEMA_VERSION = 1;
// CAPTURE_BUFFER_BOUNDS (1.5.3): the text.complete fragment buffer is bounded
// on both axes. Per-session fragments keep only the last MAX_FRAGMENTS (a
// session whose flush keeps failing must not accumulate text forever), and
// the map keeps only the most recent MAX_SESSIONS — a session.deleted flush
// that runs while init is still deferred intentionally retains its entry for
// retry (CAPTURE_RETRY_ON_DEFERRED), so without the cap abandoned sessions
// would leak entries for the whole process lifetime. Exported as a test seam
// (same pattern as flushAutoCapture/handleSessionIdle).
const CAPTURE_BUFFER_MAX_FRAGMENTS = 200;
const CAPTURE_BUFFER_MAX_SESSIONS = 200;
// ACTIVE_EPISODES_CAP (1.6.2): activeEpisodes grew unbounded while its
// siblings are capped (captureBuffer 200, sessionErrors 500). A lost
// session.deleted event (crash) or a failing updateTaskState (entry
// intentionally retained for retry) leaked entries for the process
// lifetime. FIFO-capped like sessionErrors; the evicted episode row stays
// "running" on disk (telemetry gap, not a leak).
const ACTIVE_EPISODES_MAX = 500;
// V1_PLUGIN_EXPORT (1.5.4): recordCaptureFragment is NOT an `export function`.
// Module namespace exports sort alphabetically, and opencode's legacy plugin
// loader iterates every function export, calling each as a plugin factory with
// (input, options) — the first one to throw aborts loading before the real
// plugin runs. 1.5.3's `export function appendCaptureFragment` sorted before
// "default", so the loader invoked it with input.captureBuffer undefined and
// the plugin never loaded ("undefined is not an object (evaluating
// 'state.captureBuffer.get')"). The default export is now a V1 plugin object
// ({ id, server }) so the loader calls server(input) only, and every test-seam
// export name sorts after "default" (recordCaptureFragment: r > d) so even the
// legacy fallback path would reach the server factory first.
function recordCaptureFragment(state, sessionID, text) {
    let list = state.captureBuffer.get(sessionID);
    if (list === undefined) {
        if (state.captureBuffer.size >= CAPTURE_BUFFER_MAX_SESSIONS) {
            const oldest = state.captureBuffer.keys().next().value;
            if (oldest !== undefined)
                state.captureBuffer.delete(oldest);
        }
        list = [];
    }
    list.push(text);
    if (list.length > CAPTURE_BUFFER_MAX_FRAGMENTS) {
        list = list.slice(-CAPTURE_BUFFER_MAX_FRAGMENTS);
    }
    state.captureBuffer.set(sessionID, list);
}
// Event-driven dedup: run consolidateDuplicates on session.idle (throttled to
// this interval so chatty sessions aren't re-scanning the store every turn)
// and on session.deleted (force=true, bypasses cooldown — final cleanup).
const CONSOLIDATE_COOLDOWN_MS = 30 * 60 * 1000;
// Task-type detection keywords
const TASK_TYPE_KEYWORDS = {
    coding: ["code", "function", "class", "implement", "debug", "fix", "refactor", "api", "bug", "error", "test", "寫程式", "程式", "代碼", "函數"],
    documentation: ["doc", "document", "readme", "comment", "guide", "tutorial", "說明", "文檔", "文"],
    review: ["review", "review code", "pull request", "pr", "merge", "審查", "檢視"],
    release: ["release", "publish", "deploy", "version", "build", "npm", "publish", "發布", "版本"],
    general: [],
};
/**
 * Detect task type from user message
 */
function detectTaskType(messages) {
    // Find the last user message
    let userText = "";
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const msg = messages[i];
        if (msg.info?.role === "user" && msg.parts) {
            userText = msg.parts.filter((p) => p.type === "text").map((p) => p.text).join(" ").toLowerCase();
            break;
        }
    }
    // Score each task type
    const scores = { coding: 0, documentation: 0, review: 0, release: 0, general: 0 };
    for (const [taskType, keywords] of Object.entries(TASK_TYPE_KEYWORDS)) {
        for (const keyword of keywords) {
            if (userText.includes(keyword.toLowerCase())) {
                scores[taskType] += 1;
            }
        }
    }
    // Find the task type with highest score (excluding general)
    let maxScore = 0;
    let detectedType = "general";
    for (const [taskType, score] of Object.entries(scores)) {
        if (taskType !== "general" && score > maxScore) {
            maxScore = score;
            detectedType = taskType;
        }
    }
    return maxScore > 0 ? detectedType : "general";
}
/**
 * Get category weights for a specific task type
 */
function getCategoryWeights(taskType, profiles) {
    return profiles[taskType]?.categoryWeights ?? profiles.general.categoryWeights;
}
// Command-sequence heuristics below mirror the tool-name regex already used
// by store.js's extractSuccessPatternsFromScope (npm|yarn|pnpm|npx|cargo|go|
// pytest|jest|tsc|eslint|prettier), so only real shell commands (the "bash"
// tool) are tracked into episodic history — not every tool call.
const VALIDATION_TYPE_PATTERNS = [
    { type: "type-check", re: /\b(tsc\b|type-?check)/i },
    { type: "test", re: /\b(test|jest|vitest|pytest|mocha|rspec)\b/i },
    { type: "build", re: /\b(build|webpack|rollup|tsup|vite build)\b/i },
];
/**
 * Extract a loggable shell command string from a tool.execute.after input,
 * or null if this tool call isn't a shell command worth tracking in the
 * episode's command history.
 */
function extractCommandText(toolName, args) {
    if (toolName !== "bash")
        return null;
    const command = typeof args?.command === "string" ? args.command.trim() : "";
    return command.length > 0 ? command.slice(0, 500) : null;
}
/**
 * Best-effort detection of a validation outcome (test/build/type-check)
 * from a bash command + its tool output. Uses the tool's metadata exit
 * code when the host exposes one; otherwise falls back to a text heuristic
 * on the captured output. Returns null for commands that aren't validation
 * commands.
 */
function detectValidationOutcome(command, toolOutput) {
    const match = VALIDATION_TYPE_PATTERNS.find((p) => p.re.test(command));
    if (!match)
        return null;
    const output = typeof toolOutput?.output === "string" ? toolOutput.output : "";
    const metadata = (toolOutput?.metadata ?? {});
    const exitCode = typeof metadata.exit === "number"
        ? metadata.exit
        : typeof metadata.exitCode === "number"
            ? metadata.exitCode
            : undefined;
    let status;
    if (exitCode !== undefined) {
        status = exitCode === 0 ? "pass" : "fail";
    }
    else {
        // VALIDATION_OUTCOME_CASE (1.6.2): the failure-signal regex was
        // case-sensitive — lowercase "found 1 error" (real tsc output when
        // metadata.exit is absent) never matched `(^|\s)Error\b`, so a the
        // failure was recorded as pass. /i is safe: the \b0 (failing|failed|
        // errors?) guard below stays case-insensitive, and Error\b still does
        // not match "errors" (word boundary), so zero-count lines can't trip.
        const failureSignal = /(^|\s)(FAIL|Failed|Error|Exception)\b/i.test(output)
            && !/\b0 (failing|failed|errors?)\b/i.test(output);
        status = failureSignal ? "fail" : "pass";
    }
    const errorMatches = output.match(/error TS\d+|✗|FAIL /g);
    return {
        type: match.type,
        status,
        timestamp: Date.now(),
        errorCount: errorMatches ? errorMatches.length : undefined,
        output: output.slice(0, 500),
    };
}
const plugin = async (input) => {
    initLogger(input.client);
    const state = await createRuntimeState(input);
    const hooks = {
        config: async (config) => {
            // SCOPING_CONFIG_SOURCE (1.4.5): share the real opencode config
            // with scope.js — resolveScoping previously passed {} and
            // silently ignored memory.scoping from opencode.json.
            setScopingConfigSource(config);
            const nextConfig = resolveMemoryConfig(config, input.worktree);
            handleEmbeddingConfigChange(state, nextConfig);
            state.config = nextConfig;
            configureLogger(nextConfig.logging ?? {});
            // Startup banner logs after the config hook has armed the file
            // sink (factory-time logging would miss the configured log file);
            // guarded so re-resolutions don't reprint it.
            if (!state.startupLogged) {
                state.startupLogged = true;
                log("info", `Plugin v${PLUGIN_VERSION} initialized`);
                // STARTUP_DEGRADED (1.3.9): one proactive warning when the
                // install can't reach full features, so fresh users know what
                // to configure instead of discovering degraded mode later.
                const missing = [];
                const emb = state.config.embedding ?? {};
                if (state.config.capture?.mode === "llm" && (!state.config.capture?.llm?.provider || !state.config.capture?.llm?.model)) {
                    missing.push("capture.llm.{provider,model} (LLM capture will fall back to heuristics)");
                }
                if (emb.provider === "openai" && !emb.apiKey) {
                    missing.push("embedding.apiKey (recall will fall back to BM25-only)");
                }
                if (emb.provider !== "openai" && !(emb.baseUrl ?? "")) {
                    missing.push("embedding.baseUrl (defaults to http://127.0.0.1:11434)");
                }
                if (missing.length > 0) {
                    log("warn", `Memory plugin running degraded: missing ${missing.join(", ")}. See README "Quick start" for full-feature setup.`);
                }
            }
        },
        event: async ({ event }) => {
            const evt = event;
            // NOTE: This OpenCode version (>=1.x) does not emit "session.start"/
            // "session.end" events (those never existed in the public event bus).
            // The real lifecycle events are "session.created" and "session.deleted",
            // and their sessionID lives at properties.info.id, not properties.sessionID.
            if (evt.type === "session.created") {
                const sid = evt.properties?.info?.id;
                if (sid && !isOwnSession(sid)) {
                    await handleSessionStart(sid, state, input);
                }
                return;
            }
            if (evt.type === "session.error") {
                // Track failures so handleSessionEnd (fired on session.deleted) can
                // report an accurate outcome instead of a hardcoded "unknown".
                // EPISODIC_FAILURE (1.3.0): SDK events carry the error object
                // (ProviderAuthError/UnknownError/MessageAbortedError/ApiError —
                // all expose data.message), so we also keep the raw message and
                // classify it at session end to fill failureType/errorMessage.
                // ERROR_SESSION_ID_FALLBACK (1.3.5): session.error carried the
                // sessionID at properties.sessionID while created/deleted use
                // properties.info.id — if the SDK ever omits one, don't lose
                // the failure classification.
                const sid = evt.properties?.sessionID ?? evt.properties?.info?.id;
                if (sid) {
                    const err = evt.properties?.error;
                    const message = typeof err?.data?.message === "string"
                        ? err.data.message
                        : (typeof err?.message === "string" ? err.message : undefined);
                    state.sessionErrors.set(sid, message
                        ? { failed: true, message }
                        : { failed: true });
                    // Bound growth in case session.deleted never fires for a
                    // given session (e.g. crash) — simple FIFO eviction since
                    // Map iteration order is insertion order in JS.
                    if (state.sessionErrors.size > 500) {
                        const oldestKey = state.sessionErrors.keys().next().value;
                        if (oldestKey !== undefined)
                            state.sessionErrors.delete(oldestKey);
                    }
                }
                return;
            }
            if (evt.type === "session.deleted") {
                const sid = evt.properties?.info?.id;
                if (sid && !isOwnSession(sid)) {
                    // SESSION_DELETED_FLUSH (1.3.5): capture fragments were
                    // only ever flushed on session.idle, so quick sessions
                    // lost their transcript AND leaked their captureBuffer
                    // entry. Flush before the session disappears.
                    try {
                        await flushAutoCapture(sid, state, input.client);
                    }
                    catch (error) {
                        log("warn", `failed to flush capture on session end: ${toErrorMessage(error)}`);
                    }
                    const entry = state.sessionErrors.get(sid);
                    state.sessionErrors.delete(sid);
                    const hadError = entry?.failed === true;
                    await handleSessionEnd(sid, state, hadError ? "failed" : "success", entry?.message);
                    // Session is closing — final dedup pass for its scope. Uses the
                    // session's own directory (Session.info.directory) rather than
                    // client.session.get, which may 404 after deletion. force=true
                    // bypasses the idle cooldown since this is a one-time cleanup.
                    const deletedInfo = evt.properties?.info;
                    const finalScope = deletedInfo?.directory ? deriveProjectScope(deletedInfo.directory) : state.defaultScope;
                    maybeConsolidateDuplicates(state, finalScope, true);
                    maybeSweepExpiredMemories(state, finalScope, true);
                }
                // OWN_SESSION_CLEANUP (1.3.5): the consolidate/sweep calls
                // above used to run UNCONDITIONALLY — including for the
                // plugin's own ephemeral LLM-capture/digest sessions, with
                // force=true bypassing the cooldown. In capture.mode="llm"
                // every LLM round trip paid a full consolidate+retention scan
                // on teardown and could trigger further LLM digests. Own
                // sessions are now skipped entirely (handleSessionEnd guard
                // covers the rest).
                return;
            }
            const sessionID = evt.properties?.sessionID;
            if (!sessionID)
                return;
            if (isOwnSession(sessionID))
                return;
            if (evt.type === "session.idle" || evt.type === "session.compacted") {
                // SESSION_IDLE_FLUSH_GUARD (1.4.5): extracted into a named
                // function so the flush-failure path is unit-testable.
                await handleSessionIdle(sessionID, evt.type, state, input);
            }
        },
        "experimental.text.complete": async (eventInput, eventOutput) => {
            recordCaptureFragment(state, eventInput.sessionID, eventOutput.text);
        },
        // Wires the episodic learning store (addCommandToEpisode/
        // addValidationOutcome) to real tool executions. Previously these
        // store methods existed but were never called from anywhere, so
        // episodic_tasks rows stayed permanently empty and similar_task_recall/
        // retry_budget_suggest/recovery_strategy_suggest always ran on
        // empty data. Only tracks the "bash" tool (real shell commands),
        // matching the tool-name heuristics already used elsewhere in the
        // store for pattern extraction.
        "tool.execute.after": async (toolInput, toolOutput) => {
            const { tool: toolName, sessionID, args } = toolInput;
            if (!sessionID)
                return;
            const entry = state.activeEpisodes.get(sessionID);
            if (!entry)
                return;
            const command = extractCommandText(toolName, args);
            if (!command)
                return;
            await state.ensureInitialized();
            if (!state.initialized)
                return;
            const { taskId, scope: activeScope } = entry;
            try {
                await state.store.addCommandToEpisode(taskId, activeScope, command);
            }
            catch (error) {
                log("warn", `failed to record command in episode: ${toErrorMessage(error)}`);
            }
            const validation = detectValidationOutcome(command, toolOutput);
            if (validation) {
                try {
                    await state.store.addValidationOutcome(taskId, activeScope, validation);
                    // RETRY_ATTEMPT_WIRE (1.3.5): failed validations are the
                    // only real "attempt" signal the plugin sees (same command
                    // family retried in the sessions). Record them so
                    // retry_budget_suggest has data instead of always
                    // answering "1 retry". addRetryAttempt assigns the
                    // 1-based attemptNumber/timestamp.
                    if (validation.status === "fail") {
                        await state.store.addRetryAttempt(taskId, activeScope, {
                            outcome: "failed",
                            errorMessage: (validation.output ?? "").slice(0, 500),
                        });
                    }
                }
                catch (error) {
                    log("warn", `failed to record validation outcome: ${toErrorMessage(error)}`);
                }
            }
        },
        "experimental.chat.system.transform": async (eventInput, eventOutput) => {
            if (!eventInput.sessionID)
                return;
            // OWN_SESSION_RECALL_GUARD (1.6.1): every other hook filters the
            // plugin's own ephemeral LLM sessions (capture/digest); this hook
            // didn't, so recall ran with the extraction transcript as the query
            // and injected a [Memory Recall] block into the extraction prompt —
            // self-amplification (recalled memories echoed back as new captures)
            // plus a wasted embed+search+graph pass on every capture flush.
            if (isOwnSession(eventInput.sessionID))
                return;
            await state.ensureInitialized();
            if (!state.initialized)
                return;
            // MESSAGES_FETCH_ONCE (1.5.3): getLastUserText and the task-type
            // detection inside runRecallPipeline each called
            // client.session.messages — two identical SDK round-trips per
            // recall turn. Fetch once here and hand the messages down.
            const messages = await fetchSessionMessages(eventInput.sessionID, input.client);
            const query = lastUserTextFromMessages(messages);
            if (!query)
                return;
            // TIMING_SPANS (1.4.7): the recall pipeline is extracted into a named
            // function (test seam, mirrors handleSessionIdle) so the timing span
            // covers the whole turn: scope resolution, messages fetch, embed,
            // hybrid search, graph boost/expansion, and injection assembly.
            await runRecallPipeline(eventInput, eventOutput, state, input, query, messages);
        },
        tool: {
            ...createMemoryTools(state),
            ...createFeedbackTools(state),
            ...createEpisodicTools(state),
        },
    };
    return hooks;
};
// RETENTION_SCORING (1.5.5): wires the resolved retention scoring weights
// (defaults from retrieval.*, overridable via retention.scoring.*) into the
// store's scope-cache truncation. Test seam (exported at the bottom, sorts
// after `default`); defensive so the legacy-loader check can invoke it with a
// plugin input and safely no-op.
function wireRetentionScoring(store, resolved) {
    if (!store || !resolved || !resolved.retention?.scoring) {
        return;
    }
    store.setRetentionScoringConfig(resolved.retention.scoring);
}
async function createRuntimeState(input) {
    const resolved = resolveMemoryConfig(undefined, input.worktree);
    const embedder = createEmbedder(resolved.embedding);
    const store = new MemoryStore(resolved.dbPath);
    // SCOPE_CACHE_CAP_WIRE (1.5.9-post): the store's per-scope searchable-cache
    // cap (cacheConfig.maxRecordsPerScope, DEFAULT 1000) is a module-level env
    // constant from MAX_RECORDS_PER_SCOPE, separate from the resolved
    // config.maxEntriesPerScope (default 3000). The two knobs silently
    // disagreed — a scope with 1315 records was searchable only to 1000 —
    // hiding up to (maxEntriesPerScope - 1000) memories from recall. Wire the
    // configured cap through unless the operator explicitly set
    // OPENCODE_MEMORY_PRO_MAX_RECORDS_PER_SCOPE (env keeps precedence).
    wireStoreCacheCap(store, resolved);
    // GRACEFUL_SHUTDOWN: lance runs auto_cleanup_hook in a background tokio
    // task after each commit; exiting without closing the connection cancels
    // it and logs a noisy "task was cancelled" ERROR. Connection close is
    // synchronous, so a process.once("exit") listener is enough.
    process.once("exit", () => {
        try {
            store.close();
        }
        catch (error) {
            log("warn", `[store] shutdown close failed: ${toErrorMessage(error)}`);
        }
    });
    if (resolved.retention) {
        store.setRetentionConfig(resolved.retention);
    }
    // RETENTION_SCORING (1.5.5): feed the retention scoring weights (defaults
    // to retrieval.*, overridable via retention.scoring.*) into the store's
    // scope-cache truncation so cache eviction keeps what should survive —
    // without changing live search ranking.
    wireRetentionScoring(store, resolved);
    const graph = resolved.graph?.enabled ? await createGraphStore(resolved.graph) : null;
    if (graph) {
        try {
            store.attachGraph(graph);
        }
        catch (error) {
            log("warn", `failed to attach graph to store: ${toErrorMessage(error)}`);
        }
    }
    const state = {
        config: resolved,
        embedder,
        store,
        // LLM_CAPTURE (1.1): the opencode SDK client, plumbed into state so
        // tools (digests) and the capture path can open ephemeral sessions.
        client: input.client,
        graph: graph ?? { enabled: false, extract: () => [], boostResults: (_q, r) => r, indexMemory: () => { } },
        defaultScope: deriveProjectScope(input.worktree),
        initialized: false,
        // INIT_SINGLE_FLIGHT (1.4.5): memoizes the in-flight ensureInitialized
        // promise so concurrent callers (session.created, session.idle,
        // system.transform, tool.execute.after) coalesce onto one init instead
        // of each probing the embedder and calling store.init — which raced
        // createTable on a fresh store and leaked the loser's connection.
        initPromise: null,
        startupLogged: false,
        captureBuffer: new Map(),
        activeEpisodes: new Map(),
        // FLUSH_IN_PROGRESS_GUARD (1.6.2): per-session in-flight guard for
        // capture flushes (see _flushAutoCapture).
        flushInProgress: new Set(),
        sessionErrors: new Map(),
        lastRecall: null,
        // PER_SCOPE_COOLDOWN (1.4.0): cooldowns are per-scope (Map keyed by scope)
        // instead of a single shared timestamp — one shared value meant the
        // first scope to consolidate/sweep blocked every other scope for the
        // whole 30-minute cooldown, even scopes that had never run.
        consolidationInProgress: new Map(),
        lastConsolidateAt: new Map(),
        // MEMORY_RETENTION (1.0): digest-then-hide expiry sweep state — same
        // throttle pattern as consolidation (cooldown-gated, one per scope).
        sweepInProgress: new Map(),
        lastSweepAt: new Map(),
        ensureInitialized: async () => {
            if (state.initialized)
                return;
            if (state.initPromise)
                return state.initPromise;
            state.initPromise = (async () => {
                try {
                    await initializeStore(state);
                    if (state.graph?.enabled) {
                        // One-time backfill: index existing memories into the graph
                        // so recall boosts work immediately, not only for new captures.
                        // GRAPH_BACKFILL_ALL (1.3.5): was readByScopes(["global"]),
                        // which skipped every project-scoped memory.
                        try {
                            const records = await state.store.readAllActive();
                            state.graph.reindexMemories(records);
                        }
                        catch (error) {
                            log("warn", `graph backfill failed: ${toErrorMessage(error)}`);
                        }
                    }
                    // MEMORY_RETENTION (1.0): one pass at startup so a long-idle
                    // store gets its expired memories digested without waiting for
                    // the next session.idle event.
                    maybeSweepExpiredMemories(state, state.defaultScope, true).catch(() => { });
                }
                catch (error) {
                    log("warn", `initialization deferred: ${toErrorMessage(error)}`);
                }
                finally {
                    state.initPromise = null;
                }
            })();
            return state.initPromise;
        },
    };
    return state;
}
// EMBEDDING_CONFIG_REEMBED (1.4.5): init + auto-repair, extracted from
// ensureInitialized so the config-change scenario is unit-testable. When the
// embedder's dimension no longer matches the store's physical vector column
// (embedding.provider/model changed to a different-output-size model),
// store.init flags indexState.dimensionMismatch — but LanceDB does NOT reject
// the mismatched write; it silently coerces it into the old fixed-width
// column (corrupting the vector), so proceeding would corrupt every new
// memory. Repair (backup → drop → rebuild → re-embed) before marking the
// store initialized.
export async function initializeStore(state) {
    const dim = await state.embedder.dim();
    await state.store.init(dim);
    if (state.store.indexState?.dimensionMismatch) {
        const result = await repairEmbeddingDimension(state, dim);
        log("warn", `[embedding] dimension mismatch auto-repaired: ${result.message}`);
    }
    state.initialized = true;
}
// TIMING_SPANS (1.4.7): full recall turn, measured end to end. The stop() in
// the finally also fires on early throws, so degraded paths still report time.
async function runRecallPipeline(eventInput, eventOutput, state, input, query, prefetchedMessages) {
    const stop = startSpan("recall.pipeline");
    try {
                // Resolve the session's actual directory rather than the static
                // plugin-init worktree, since a single opencode server process can
                // host sessions across multiple project directories (mirrors the
                // fix already applied to flushAutoCapture/handleSessionStart/Idle).
                // Without this, memories captured under the correct per-session
                // scope become permanently invisible to recall whenever this
                // server's static init worktree diverges from the session's
                // actual directory.
                const activeScope = await resolveSessionScope(eventInput.sessionID, input.client, deriveProjectScope(input.worktree));
                const scopes = buildScopeFilter(activeScope, state.config.includeGlobalScope);
                // MESSAGES_FETCH_ONCE (1.5.3): the system.transform hook fetches
                // once and passes the array down; standalone callers (tests) can
                // omit it and the fetch falls back here.
                let messages = [];
                if (prefetchedMessages === undefined) {
                    try {
                        const unwrapped = unwrapData(await input.client.session.messages({ path: { id: eventInput.sessionID } }));
                        if (Array.isArray(unwrapped)) {
                            messages = unwrapped;
                        }
                    }
                    catch {
                        messages = [];
                    }
                }
                else {
                    messages = prefetchedMessages;
                }
                const taskType = detectTaskType(messages);
                const profile = state.config.injection.taskTypeProfiles[taskType] ?? state.config.injection.taskTypeProfiles.general;
                const categoryWeights = getCategoryWeights(taskType, state.config.injection.taskTypeProfiles);
                let queryVector = [];
                let embedderFailed = false;
                try {
                    queryVector = await state.embedder.embed(query);
                }
                catch (error) {
                    embedderFailed = true;
                    log("warn", `embedding unavailable during recall: ${toErrorMessage(error)}`);
                    queryVector = [];
                }
                const isFallback = embedderFailed || queryVector.length === 0;
                const effectiveVectorWeight = isFallback ? 0 : (state.config.retrieval.mode === "vector" ? 1 : state.config.retrieval.vectorWeight);
                const effectiveBm25Weight = isFallback ? 1 : (state.config.retrieval.mode === "vector" ? 0 : state.config.retrieval.bm25Weight);
                // FUZZY_CHANNEL (1.4.2): auto-recall previously omitted the fuzzy
                // params entirely, and store.search treats absent fuzzyWeight as 0 —
                // so the configured fuzzy channel only ever ran for manual
                // memory_search. Mirror the tools/memory.js semantics: fuzzy stays
                // on in the bm25-only fallback (typo tolerance helps most there)
                // and is disabled only in explicit vector-only mode.
                const effectiveFuzzyWeight = state.config.retrieval.mode === "vector" ? 0 : state.config.retrieval.fuzzyWeight;
                if (isFallback) {
                    log("info", "Using BM25-only search (embedder unavailable)");
                }
                // RECALL_SEARCH_GUARD (1.6.1): every other store call in this
                // hook is guarded (embedder, graph boost/expansion,
                // findSimilarTasks, resolveSessionScope) — store.search was the
                // one unguarded LanceDB read. A transient failure propagated out
                // of the system.transform hook (which has no try/catch) and
                // failed the user's chat turn. Recall is an enhancement: degrade
                // to empty results (flows through to the no-injection early
                // return) instead of breaking the request.
                let results = [];
                try {
                    results = await state.store.search({
                        query,
                        queryVector,
                        scopes,
                        limit: profile.maxMemories * 2,
                        vectorWeight: effectiveVectorWeight,
                        bm25Weight: effectiveBm25Weight,
                        fuzzyWeight: effectiveFuzzyWeight,
                        fuzzyThreshold: state.config.retrieval.fuzzyThreshold,
                        minScore: Math.max(state.config.retrieval.minScore, state.config.injection.injectionFloor),
                        rrfK: state.config.retrieval.rrfK,
                        recencyBoost: state.config.retrieval.recencyBoost,
                        recencyHalfLifeHours: state.config.retrieval.recencyHalfLifeHours,
                        importanceWeight: state.config.retrieval.importanceWeight,
                        feedbackWeight: state.config.retrieval.feedbackWeight,
                        globalDiscountFactor: state.config.globalDiscountFactor,
                    });
                }
                catch (error) {
                    log("warn", `recall search failed: ${toErrorMessage(error)}`);
                }
                // GRAPH_STORE_PHASE1: entity-co-occurrence boost on top of the
                // hybrid score. Multiplicative, conservative (1 + lambda*strength),
                // and a no-op when the graph is disabled or the query has no
                // extractable entities.
            let graphBoostedResults = results;
            if (state.config.graph?.enabled && state.graph?.enabled) {
                // TIMING_SPANS (1.4.7): entity extraction + BFS per recall turn.
                const stopGraphBoost = startSpan("graph.boost");
                try {
                    graphBoostedResults = state.graph.boostResults(query, results, state.config.graph.boostLambda);
                }
                catch (error) {
                    log("warn", `graph boost failed: ${toErrorMessage(error)}`);
                }
                finally {
                    stopGraphBoost({ results: results.length });
                }
            }
                const weightedResults = graphBoostedResults.map((r) => {
                    const catWeight = categoryWeights[r.record.category] ?? 1.0;
                    return { ...r, score: r.score * catWeight };
                }).sort((a, b) => b.score - a.score);
                // GRAPH_STORE_PHASE2B: graph-expansion recall for injection. BFS
                // from the query's entities; reachable memories that did NOT
                // text/vector-match are appended with a graph-origin score below
                // the weakest real match, so they only get injected when the
                // primary recall comes up thin (injectionLimit caps the block).
            const graphExpanded = [];
            if (state.config.graph?.enabled && state.graph?.enabled && state.config.graph.expansionEnabled !== false) {
                // TIMING_SPANS (1.4.7): BFS expansion + findRecordsByIds per turn.
                const stopGraphExpand = startSpan("graph.expand");
                try {
                    const candidates = state.graph.expandRecall(query, {
                        maxHops: state.config.graph.maxHops,
                        expansionLimit: state.config.graph.expansionLimit,
                        expansionLambda: state.config.graph.expansionLambda,
                    });
                        if (candidates.length > 0) {
                            const expandedRecords = await state.store.findRecordsByIds(candidates.map((c) => c.memoryId), scopes);
                            const recordById = new Map(expandedRecords.map((r) => [r.id, r]));
                            const existingIds = new Set(weightedResults.map((r) => r.record.id));
                            const floorScore = weightedResults.length > 0
                                ? Math.min(...weightedResults.map((r) => r.score))
                                : Math.max(state.config.retrieval.minScore, state.config.injection.injectionFloor);
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
                    catch (error) {
                        log("warn", `graph expansion failed: ${toErrorMessage(error)}`);
                    }
                    finally {
                        stopGraphExpand();
                    }
                }
                const mergedResults = [...weightedResults, ...graphExpanded].sort((a, b) => b.score - a.score);
                // RECENCY_FACTORS (1.2.0): was a display stub (ageHours:0/
                // withinHalfLife:true/decayFactor:1) — kept in sync with the
                // manual-search path in tools/memory.js and store.explainMemory.
                const recencyHalfLifeHours = Math.max(1, state.config.retrieval.recencyHalfLifeHours ?? 72);
                state.lastRecall = {
                    timestamp: Date.now(),
                    query,
                    results: mergedResults.map((r) => {
                        const ageHours = (Date.now() - r.record.timestamp) / 3_600_000;
                        return {
                            memoryId: r.record.id,
                            score: r.score,
                            factors: {
                                relevance: { overall: r.score, vectorScore: r.vectorScore, bm25Score: r.bm25Score },
                                recency: { timestamp: r.record.timestamp, ageHours, withinHalfLife: ageHours <= recencyHalfLifeHours, decayFactor: Math.exp(-ageHours / recencyHalfLifeHours) },
                                citation: r.record.citationSource ? { source: r.record.citationSource, status: r.record.citationStatus } : undefined,
                                importance: r.record.importance,
                                scope: { memoryScope: r.record.scope, matchesCurrentScope: r.record.scope === activeScope, isGlobal: r.record.scope === "global" },
                                graph: r.graphBFS ? { bfs: { hops: r.graphBFS.hops, relation: r.graphBFS.relation, typed: r.graphBFS.typed } }
                                    : r.graphBoost ? { boost: r.graphBoost, overlap: r.graphOverlap ?? 0 } : undefined,
                            },
                        };
                    }),
                };
                // Extract preference signals from memories
                // Extract preference signals from memories, bucketed by the MEMORY's own
                // scope. Both filters previously tested activeScope — the same value
                // for both branches — so one profile was always empty and, under
                // scoping:"project" with includeGlobalScope, signals from global
                // memories were misattributed to the project profile (and vice
                // versa). Pair each signal with its record's scope and bucket there;
                // behavior is unchanged in the default global mode (every record is
                // scope "global").
                const allSignals = results.flatMap((r) => extractPreferenceSignals(r.record).map((signal) => ({ signal, memoryScope: r.record.scope })));
                const projectSignals = allSignals.filter((s) => !s.memoryScope.startsWith("global")).map((s) => s.signal);
                const globalSignals = allSignals.filter((s) => s.memoryScope.startsWith("global")).map((s) => s.signal);
                const projectProfile = aggregatePreferences(projectSignals, "project");
                const globalProfile = aggregatePreferences(globalSignals, "global");
                const effectivePreferences = resolveConflicts(projectProfile.preferences, globalProfile.preferences);
                const preferenceInjection = buildPreferenceInjection(effectivePreferences, preferenceInjectionConfig(state.config.injection, profile));
                // Apply injection control with task-type profile
                const injectionConfig = {
                    ...state.config.injection,
                    maxMemories: profile.maxMemories,
                    budgetTokens: profile.budgetTokens,
                    summaryTargetChars: profile.summaryTargetChars,
                };
                const injectionLimit = calculateInjectionLimit(mergedResults, injectionConfig);
                const limitedResults = mergedResults.slice(0, injectionLimit);
                // FIRE_AND_FORGET_RECALL_EVENT (perf review): this used to be
                // awaited, adding a LanceDB table-commit's latency to every
                // single chat turn's system-prompt construction for a
                // telemetry write nothing downstream reads (eventOutput.system
                // is populated from limitedResults regardless of whether this
                // write succeeds). updateMemoryUsage a few lines below has
                // always fired without awaiting for the same reason — match
                // that here.
                state.store.putEvent({
                    id: generateId(),
                    type: "recall",
                    source: "system-transform",
                    scope: activeScope,
                    sessionID: eventInput.sessionID,
                    timestamp: Date.now(),
                    resultCount: limitedResults.length,
                    injected: limitedResults.length > 0,
                    metadataJson: JSON.stringify({
                        source: "system-transform",
                        includeGlobalScope: state.config.includeGlobalScope,
                        injectionMode: state.config.injection.mode,
                        injectionLimit: injectionLimit,
                    }),
                }).catch((error) => log("warn", `[recall] putEvent failed: ${toErrorMessage(error)}`));
                if (limitedResults.length === 0)
                    return;
                for (const result of limitedResults) {
                    state.store.updateMemoryUsage(result.record.id, activeScope, scopes).catch(() => { });
                }
                // EPISODE_RECALL_USED (1.3.5): stamp the session's task episode so
                // memory_kpi's memory-lift metric can actually separate tasks that
                // used recall from tasks that didn't (nothing ever set it before).
                const recallEpisode = state.activeEpisodes.get(eventInput.sessionID);
                if (recallEpisode) {
                    state.store.markEpisodeRecallUsed(recallEpisode.taskId, recallEpisode.scope)
                        .catch((error) => log("warn", `failed to mark episode recall used: ${toErrorMessage(error)}`));
                }
                // Apply summarization if configured
                const summarizationConfig = createSummarizationConfig(state.config.injection);
                const processedResults = limitedResults.map((item) => {
                    if (state.config.injection.summarization === "none") {
                        return { ...item, text: item.record.text };
                    }
                    const summarized = summarizeContent(item.record.text, summarizationConfig);
                    return { ...item, text: summarized.content };
                });
                const blocks = [];
                if (preferenceInjection) {
                    blocks.push(preferenceInjection);
                }
                blocks.push("[Memory Recall - optional historical context]", ...processedResults.map((item, index) => {
                    const citationInfo = item.record.citationSource
                        ? ` [${item.record.citationSource}|${item.record.citationStatus ?? "pending"}]`
                        : "";
                    return `${index + 1}. [${item.record.id}]${citationInfo}${item.graphBFS ? ` [graph-bfs: ${item.graphBFS.hops} hop${item.graphBFS.hops === 1 ? "" : "s"}]` : ""} (${item.record.scope}) ${item.text}`;
                }), "Use these as optional hints only; prioritize current user intent and current repo state.");
                // === Similar Task Recall (Episodic Learning) ===
                // findSimilarTasks matches by keyword only (its vector branch was
                // dead code), so no embedding is needed here — the previous
                // re-embed of the query was computed every recall turn and unused.
                try {
                    const similarTasks = await state.store.findSimilarTasks(activeScope, query, 0.5);
                    if (similarTasks.length > 0) {
                        const taskContext = similarTasks.slice(0, 2).map((ep) => {
                            const commands = parseJsonObject(ep.commandsJson, []);
                            const outcomes = parseJsonObject(ep.validationOutcomesJson, []);
                            const passed = outcomes.filter((o) => o.status === "pass").length;
                            const total = outcomes.length;
                            return `Similar task: ${ep.taskId} (${ep.state}) - Commands: ${commands.slice(0, 3).join(" → ")} - Validations: ${passed}/${total} passed`;
                        });
                        blocks.push("[Similar Task Recall - based on past successful solutions]", ...taskContext, "Consider these approaches for solving the current task.");
                    }
                }
                catch (error) {
                    log("warn", `similar task recall failed: ${toErrorMessage(error)}`);
                }
                eventOutput.system.push(blocks.join("\n\n"));
    }
    finally {
        stop();
    }
}

// MESSAGES_FETCH_ONCE (1.5.3): split the old getLastUserText into a fetch
// (fetchSessionMessages) and a pure extraction (lastUserTextFromMessages) so
// the system.transform hook can fetch once and reuse the same array for both
// the query text and runRecallPipeline's task-type detection.
async function fetchSessionMessages(sessionID, client) {
    try {
        const payload = unwrapData(await client.session.messages({ path: { id: sessionID } }));
        return Array.isArray(payload) ? payload : [];
    }
    catch {
        return [];
    }
}
function lastUserTextFromMessages(payload) {
    for (let i = payload.length - 1; i >= 0; i -= 1) {
        const item = payload[i];
        if (item.info?.role !== "user" || !Array.isArray(item.parts))
            continue;
        const textParts = item.parts.filter((part) => part.type === "text" && typeof part.text === "string");
        const text = textParts.map((part) => part.text).join("\n").trim();
        if (text.length > 0)
            return text;
    }
    return "";
}
async function flushAutoCapture(sessionID, state, client) {
    // TIMING_SPANS (1.4.7): capture flush (LLM or heuristics + store writes)
    // is the main session-idle cost; fragmentCount sizes the work per flush.
    const stop = startSpan("capture.flush");
    const fragmentCount = (state.captureBuffer.get(sessionID) ?? []).length;
    try {
        return await _flushAutoCapture(sessionID, state, client);
    }
    finally {
        stop({ fragmentCount });
    }
}
// FLUSH_IN_PROGRESS_GUARD (1.6.2): a concurrent session.idle + session.deleted
// flush for the SAME session used to both read the same fragments and store
// them twice (duplicate captures; also raced the first flush's deletes). A
// per-session in-flight guard lets only ONE flush consume a snapshot; the
// other no-ops. Fragments appended after the snapshot stay in the buffer.
async function _flushAutoCapture(sessionID, state, client) {
    if (state.flushInProgress?.has(sessionID)) {
        return;
    }
    state.flushInProgress?.add(sessionID);
    try {
        await _flushAutoCaptureGuarded(sessionID, state, client);
    }
    finally {
        state.flushInProgress?.delete(sessionID);
    }
}
// FLUSH_SNAPSHOT_CONSUME (1.6.2): take a SNAPSHOT (copy) of the buffered
// fragments. recordCaptureFragment pushes onto the LIVE array (and can
// reassign it at the 200-fragment cap), so a fragment appended during the
// flush's awaits used to land in the array that the final delete() discarded
// → silent transcript loss, exactly in the path hardened for retention. The
// snapshot drives extraction; consumeBufferedFragments keeps anything
// appended after it for the next flush.
// FLUSH_SNAPSHOT_CONSUME (1.6.2): remove exactly the snapshot's fragments
// from the live buffer, keeping anything appended during the flush.
// Reference-identity: if recordCaptureFragment REASSIGNED the entry at the
// fragment cap mid-flush (list.slice(-200)), the live array is no longer
// the snapshot — all surviving content is post-snapshot, so keep it for the
// next flush rather than dropping it.
function consumeBufferedFragments(state, sessionID, snapshot, snapshotCount) {
    const live = state.captureBuffer.get(sessionID);
    if (live === undefined)
        return;
    if (live === snapshot) {
        // snapshotCount is FROZEN at capture time (snapshot.length grows as
        // the live array is appended to — same reference).
        if (live.length > snapshotCount) {
            state.captureBuffer.set(sessionID, live.slice(snapshotCount));
        }
        else {
            state.captureBuffer.delete(sessionID);
        }
    }
}
async function _flushAutoCaptureGuarded(sessionID, state, client) {
    const liveSnapshot = state.captureBuffer.get(sessionID) ?? [];
    const fragments = liveSnapshot.slice();
    if (fragments.length === 0) {
        await recordCaptureEvent(state, {
            sessionID,
            scope: state.defaultScope,
            outcome: "skipped",
            skipReason: "empty-buffer",
            text: "",
        });
        return;
    }
    const combined = fragments.join("\n").trim();
    const activeScope = await resolveSessionScope(sessionID, client, state.defaultScope);
    await state.ensureInitialized();
    if (!state.initialized) {
        // CAPTURE_RETRY_ON_DEFERRED (1.4.5): keep the fragments in the buffer.
        // The next session.idle/compacted/deleted flush retries them once init
        // recovers; deleting before this guard silently destroyed every
        // buffered fragment for the session after a single transient init
        // failure.
        return;
    }
    // CAPTURE_RETRY_ON_DEFERRED (1.4.5): the buffer owns its fragments until
    // flush provably proceeds past init. Edge: a session.deleted flush while
    // init is still deferred retains the entry (bounded string-array leak)
    // rather than dropping the data.
    //
    // CAPTURE_BUFFER_AFTER_WRITES (1.6.1): the delete used to run HERE, before
    // any of the awaited store writes below (recordCaptureEvent → putEvent,
    // storeCapturedMemory → put, pruneScope). A transient LanceDB failure
    // threw out of _flushAutoCapture with the buffer entry ALREADY deleted —
    // the transcript was gone and the retry-on-next-flush mechanism found an
    // empty buffer. The delete now runs only after every store write succeeds
    // (all return paths reach the delete at the bottom); a throw leaves the
    // fragments in place for the next flush to retry.
    await recordCaptureEvent(state, {
        sessionID,
        scope: activeScope,
        outcome: "considered",
        text: combined,
    });
    // LLM_CAPTURE (1.1): mode "llm" runs structured SDK extraction first.
    // On any failure (provider offline, unparseable reply, empty result) it
    // falls back to the offline heuristics pipeline and records an explicit
    // "llm-fallback" capture event so the degradation is auditable.
    if (state.config.capture?.mode === "llm") {
        let candidates = null;
        try {
            candidates = await requestLLMCapture(client, state.config.capture.llm, combined, sessionID);
        }
        catch (error) {
            log("warn", `[capture] llm extraction failed: ${toErrorMessage(error)}`);
            candidates = null;
        }
        if (candidates && candidates.length > 0) {
            let storedCount = 0;
            let firstId = null;
            for (const cand of candidates) {
                const result = await storeCapturedMemory(state, {
                    sessionID,
                    scope: activeScope,
                    text: truncateText(cand.content, 1200),
                    category: cand.type,
                    importance: cand.importance,
                    source: "llm-capture",
                });
                if (result.id) {
                    storedCount += 1;
                    if (firstId === null)
                        firstId = result.id;
                }
            }
            await recordCaptureEvent(state, {
                sessionID,
                scope: activeScope,
                outcome: storedCount > 0 ? "stored" : "skipped",
                skipReason: storedCount > 0 ? undefined : "llm-no-storable",
                memoryId: firstId,
                text: combined,
            });
            if (storedCount > 0) {
                await state.store.pruneScope(activeScope, state.config.maxEntriesPerScope);
            }
            // CAPTURE_BUFFER_AFTER_WRITES (1.6.1): all store writes above
            // succeeded — safe to drop the buffered fragments.
            consumeBufferedFragments(state, sessionID, liveSnapshot, fragments.length);
            return;
        }
        await recordCaptureEvent(state, {
            sessionID,
            scope: activeScope,
            outcome: "llm-fallback",
            skipReason: candidates === null ? "llm-unavailable" : "llm-empty-result",
            text: combined,
        });
        // LLM_EMPTY_VERDICT (1.3.5): when the LLM ran fine but deliberately
        // returned [] ("nothing here is memory-worthy"), that is a real
        // verdict, not a failure — falling through to the keyword heuristics
        // stored transcript content the LLM explicitly rejected. Only fall
        // back when extraction FAILED (candidates === null).
        if (candidates !== null) {
            // CAPTURE_BUFFER_AFTER_WRITES (1.6.1): LLM returned a real empty
            // verdict — the transcript was considered and rejected; drop it.
            consumeBufferedFragments(state, sessionID, liveSnapshot, fragments.length);
            return;
        }
    }
    const result = extractCaptureCandidate(combined, state.config.minCaptureChars);
    if (!result.candidate) {
        await recordCaptureEvent(state, {
            sessionID,
            scope: activeScope,
            outcome: "skipped",
            skipReason: result.skipReason,
            text: combined,
        });
        // CAPTURE_BUFFER_AFTER_WRITES (1.6.1): considered + skipped — the
        // transcript was processed; drop it.
        consumeBufferedFragments(state, sessionID, liveSnapshot, fragments.length);
        return;
    }
    const stored = await storeCapturedMemory(state, {
        sessionID,
        scope: activeScope,
        text: result.candidate.text,
        category: result.candidate.category,
        importance: result.candidate.importance,
        source: "auto-capture",
    });
    if (!stored.id) {
        await recordCaptureEvent(state, {
            sessionID,
            scope: activeScope,
            outcome: "skipped",
            skipReason: stored.skipReason,
            text: combined,
        });
        // CAPTURE_BUFFER_AFTER_WRITES (1.6.1): considered + skipped — the
        // transcript was processed; drop it.
        consumeBufferedFragments(state, sessionID, liveSnapshot, fragments.length);
        return;
    }
    await recordCaptureEvent(state, {
        sessionID,
        scope: activeScope,
        outcome: "stored",
        memoryId: stored.id,
        text: result.candidate.text,
    });
    await state.store.pruneScope(activeScope, state.config.maxEntriesPerScope);
    // CAPTURE_BUFFER_AFTER_WRITES (1.6.1): all store writes above succeeded —
    // only now is it safe to drop the buffered fragments. A throw anywhere
    // above leaves them in place for the next flush to retry.
    consumeBufferedFragments(state, sessionID, liveSnapshot, fragments.length);
}
// SESSION_IDLE_FLUSH_GUARD (1.4.5): session.idle/session.compacted handling,
// extracted from the event hook so the flush-failure path is unit-testable.
// Mirrors the session.deleted pattern (:211-216): a transient store failure
// inside flushAutoCapture (e.g. putEvent rejecting on a LanceDB hiccup) must
// not propagate out of the plugin's event hook — that aborted the capture AND
// skipped the consolidate/sweep pass for this event. Fragments survive in the
// buffer (CAPTURE_RETRY_ON_DEFERRED) and retry on the next flush.
async function handleSessionIdle(sessionID, eventType, state, input) {
    try {
        await flushAutoCapture(sessionID, state, input.client);
    }
    catch (error) {
        log("warn", `failed to flush capture on session idle: ${toErrorMessage(error)}`);
    }
    // IDLE_SWEEP_DEDUP_DECOUPLE (1.6.2): the consolidate/sweep pass used to be
    // gated on dedup.enabled, so with dedup off the retention sweep NEVER ran
    // on idle/compacted (only init + session.deleted) — wrong coupling, the
    // deleted path (:266-267) already runs both unconditionally. Consolidation
    // self-guards on dedup.enabled (maybeConsolidateDuplicates), and the sweep
    // is retention, not dedup.
    // Use the session's actual directory (not the static plugin-init
    // worktree) since a single opencode server process can host
    // sessions across multiple project directories.
    const activeScope = await resolveSessionScope(sessionID, input.client, state.defaultScope);
    // idle = throttled background pass (cooldown-gated);
    // compacted = explicit compaction, consolidate right away.
    maybeConsolidateDuplicates(state, activeScope, eventType === "session.compacted");
    maybeSweepExpiredMemories(state, activeScope, eventType === "session.compacted");
}
/**
 * Shared capture-store path (used by both heuristics and LLM modes): embed,
 * advisory dedup check, store, graph-index. Returns { id, skipReason } —
 * id null + skipReason when the memory could not be stored (embedding
 * unavailable, empty vector).
 */
async function storeCapturedMemory(state, opts) {
    let vector = [];
    try {
        vector = await state.embedder.embed(opts.text);
    }
    catch (error) {
        log("warn", `embedding unavailable during auto-capture: ${toErrorMessage(error)}`);
        return { id: null, skipReason: "embedding-unavailable" };
    }
    if (vector.length === 0) {
        log("warn", "auto-capture skipped because embedding vector is empty");
        return { id: null, skipReason: "empty-embedding" };
    }
    let isPotentialDuplicate = false;
    let duplicateOf = null;
    // DEDUP_COSINE_CHECK (1.4.0): the write-time dedup check used to go
    // through the hybrid search() API, whose RRF score is algebraically >= 1.0
    // for limit:1 (rrfScore = 1/(rrfK+1) * (rrfK+1) == 1.0, then multiplied by
    // an importance factor in [1, 1.4]) — so every capture with any same-dim
    // record in the scope compared >= 1.0 against writeThreshold (clamped
    // [0,1]) and got falsely flagged as a duplicate. Now it uses
    // findSimilarVectors, which returns a raw cosine similarity in [0,1], the
    // same primitive consolidateDuplicates measures against.
    if (state.config.dedup.enabled) {
        const similar = await state.store.findSimilarVectors(vector, opts.scope, 1);
        if (similar.length > 0 && similar[0].score >= state.config.dedup.writeThreshold) {
            isPotentialDuplicate = true;
            duplicateOf = similar[0].id;
        }
    }
    const memoryId = generateId();
    const now = Date.now();
    const graphEntities = state.config.graph?.enabled && state.graph?.enabled
        ? state.graph.extract(opts.text)
        : [];
    await state.store.put({
        id: memoryId,
        text: opts.text,
        vector,
        category: opts.category,
        scope: opts.scope,
        importance: opts.importance,
        timestamp: now,
        lastRecalled: 0,
        recallCount: 0,
        projectCount: 0,
        schemaVersion: SCHEMA_VERSION,
        embeddingModel: state.config.embedding.model,
        vectorDim: vector.length,
        metadataJson: JSON.stringify({
            source: opts.source ?? "auto-capture",
            sessionID: opts.sessionID,
            isPotentialDuplicate,
            duplicateOf,
            graphEntities: graphEntities.map((e) => e.name),
        }),
        citationSource: opts.source ?? "auto-capture",
        citationTimestamp: now,
        citationStatus: "pending",
    });
    if (state.config.graph?.enabled && state.graph?.enabled) {
        try {
            state.graph.indexMemory(memoryId, opts.text, now);
        }
        catch (error) {
            log("warn", `graph indexMemory failed: ${toErrorMessage(error)}`);
        }
    }
    return { id: memoryId, skipReason: null };
}
async function maybeConsolidateDuplicates(state, scope, force = false) {
    if (!state.config.dedup.enabled)
        return;
    if (!state.initialized)
        return;
    if (state.consolidationInProgress.get(scope))
        return;
    if (!force) {
        const last = state.lastConsolidateAt.get(scope) ?? 0;
        const elapsed = Date.now() - last;
        if (elapsed < CONSOLIDATE_COOLDOWN_MS)
            return;
    }
    state.lastConsolidateAt.set(scope, Date.now());
    state.consolidationInProgress.set(scope, true);
    // TIMING_SPANS (1.4.7): fire-and-forget, so the span stops in the chain.
    const stopConsolidateSpan = startSpan("consolidate.duplicates");
    state.store
        .consolidateDuplicates(scope, state.config.dedup.consolidateThreshold, state.config.dedup.candidateLimit)
        .catch(() => { })
        .finally(() => {
            stopConsolidateSpan();
            state.consolidationInProgress.delete(scope);
        });
}
// MEMORY_RETENTION (1.0): digest-then-hide expiry sweep, fired alongside
// consolidation on session.idle/compacted/deleted + once at init. Shares the
// same 30-min cooldown so chatty sessions don't re-scan the store every turn.
// Non-destructive by design: expired memories are folded into digests and
// marked status:"digested", never deleted.
async function maybeSweepExpiredMemories(state, scope, force = false) {
    if (!state.initialized)
        return;
    if (state.sweepInProgress.get(scope))
        return;
    if (!force) {
        const last = state.lastSweepAt.get(scope) ?? 0;
        const elapsed = Date.now() - last;
        if (elapsed < CONSOLIDATE_COOLDOWN_MS)
            return;
    }
    state.lastSweepAt.set(scope, Date.now());
    state.sweepInProgress.set(scope, true);
    // TIMING_SPANS (1.4.7): fire-and-forget, so the span stops in the chain.
    const stopSweepSpan = startSpan("retention.sweep");
    sweepExpiredMemories(state, { scope })
        .then((result) => {
            if (result.digestsCreated > 0) {
                log("info", `[retention] sweep: ${result.eligible} expired, ${result.digestsCreated} digest(s), ${result.digested} original(s) digested`, { scope });
            }
        })
        .catch((error) => log("warn", `[retention] sweep failed: ${toErrorMessage(error)}`))
        .finally(() => {
            stopSweepSpan();
            state.sweepInProgress.delete(scope);
        });
}
async function recordCaptureEvent(state, input) {
    if (!state.initialized)
        return;
    await state.store.putEvent({
        id: generateId(),
        type: "capture",
        scope: input.scope,
        sessionID: input.sessionID,
        timestamp: Date.now(),
        outcome: input.outcome,
        skipReason: input.skipReason,
        memoryId: input.memoryId,
        text: input.text,
        metadataJson: JSON.stringify({ source: "auto-capture" }),
    });
}
function preferenceInjectionConfig(injection, profile) {
    // PREFERENCE_BUDGET_CONFIG (1.4.6): tokenBudget was hardcoded to 300, so
    // the user-configurable injection.budgetTokens (config.js, per-env) never
    // reached the preferences block and preference.js's ?? 500 fallback was
    // dead. Reuse the configured budget; adaptive still maps to fixed (the
    // preference block has no per-item scoring to adapt on).
    return {
        mode: injection.mode === "adaptive" ? "fixed" : injection.mode,
        maxMemories: profile.maxMemories,
        tokenBudget: injection.budgetTokens,
    };
}
async function resolveSessionScope(sessionID, client, fallback) {
    try {
        const response = await client.session.get({ path: { id: sessionID } });
        const payload = unwrapData(response);
        if (payload?.directory && payload.directory.trim().length > 0) {
            return deriveProjectScope(payload.directory);
        }
    }
    catch { }
    return fallback;
}
function toErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function unwrapData(value) {
    if (value && typeof value === "object" && "data" in value) {
        return value.data;
    }
    return value;
}
async function handleSessionStart(sessionID, state, input) {
    // SESSION_LIFECYCLE_GUARD (1.4.6): a transient store failure (e.g.
    // createTaskEpisode rejecting on a LanceDB hiccup) used to propagate out
    // of the event hook. A session whose episode record could not be created
    // must still start normally — log and continue; persistSuccessPatterns
    // below already has the same guard at the end path.
    try {
        await state.ensureInitialized();
        if (!state.initialized)
            return;
        // Resolve the session's actual directory rather than the static
        // plugin-init worktree, since one opencode server process can host
        // sessions across multiple project directories.
        const activeScope = await resolveSessionScope(sessionID, input.client, deriveProjectScope(input.worktree));
        const taskId = `session-${sessionID.slice(0, 8)}`;
        const episode = {
            id: generateId(),
            sessionId: sessionID,
            scope: activeScope,
            taskId,
            state: "running",
            startTime: Date.now(),
            commandsJson: "[]",
            validationOutcomesJson: "[]",
            successPatternsJson: "[]",
            retryAttemptsJson: "[]",
            recoveryStrategiesJson: "[]",
            metadataJson: "{}",
        };
        await state.store.createTaskEpisode(episode);
        state.activeEpisodes.set(sessionID, { taskId, scope: activeScope });
        // ACTIVE_EPISODES_CAP (1.6.2): bound growth when session.deleted
        // never fires (crash) or updateTaskState keeps failing (entry
        // retained for retry by design). FIFO-evict the oldest, mirroring
        // sessionErrors; the episode row stays "running" on disk.
        if (state.activeEpisodes.size > ACTIVE_EPISODES_MAX) {
            const oldestKey = state.activeEpisodes.keys().next().value;
            if (oldestKey !== undefined) {
                state.activeEpisodes.delete(oldestKey);
                log("warn", `activeEpisodes cap reached (${ACTIVE_EPISODES_MAX}); evicted oldest session ${oldestKey}`);
            }
        }
    }
    catch (error) {
        log("warn", `failed to record session start for ${sessionID}: ${toErrorMessage(error)}`);
    }
}
async function handleSessionEnd(sessionID, state, outcome, errorMessage) {
    // SESSION_LIFECYCLE_GUARD (1.4.6): mirrors the start-side guard — a
    // rejected updateTaskState used to abort the session.deleted branch and
    // skip the end-of-session dedup/consolidation pass. On failure the
    // activeEpisodes entry is intentionally retained so a retry (e.g. a later
    // duplicate deleted event) can still finalize the episode.
    try {
        await state.ensureInitialized();
        if (!state.initialized)
            return;
        const entry = state.activeEpisodes.get(sessionID);
        if (!entry)
            return;
        const finalState = outcome === "success" ? "success" : "failed";
        // EPISODIC_FAILURE (1.3.0): when the bus gave us an error message,
        // classify it (syntax/runtime/logic/resource/unknown) and persist it with
        // the raw message. Truncated to match putEvent's 4000-char safety cap.
        let failureType;
        let failureMessage = errorMessage;
        if (finalState === "failed" && typeof failureMessage === "string" && failureMessage.length > 0) {
            failureType = classifyFailure(failureMessage);
            failureMessage = failureMessage.slice(0, 4000);
        }
        await state.store.updateTaskState(entry.taskId, finalState, entry.scope, failureType, failureMessage);
        if (finalState === "success") {
            // Previously this scope-wide pattern extraction ran on every
            // session.idle (i.e. every turn) and its result was discarded via a
            // pointless updateTaskState(taskId, episode.state, ...) no-op that
            // rewrote the episode with its own unchanged state. Moved here to
            // run once, at actual task completion, and persist real patterns.
            await persistSuccessPatterns(entry.taskId, entry.scope, state).catch((error) => {
                log("warn", `failed to persist success patterns: ${toErrorMessage(error)}`);
            });
        }
        state.activeEpisodes.delete(sessionID);
    }
    catch (error) {
        log("warn", `failed to record session end for ${sessionID}: ${toErrorMessage(error)}`);
    }
}
async function persistSuccessPatterns(taskId, scope, state) {
    const patterns = await state.store.extractSuccessPatternsFromScope(scope);
    if (patterns.length === 0)
        return;
    const episode = await state.store.getTaskEpisode(taskId, scope);
    const existingSignatures = new Set((episode ? parseJsonObject(episode.successPatternsJson, []) : [])
        .map((p) => p.commands.join("|")));
    const newPatterns = patterns
        .map((p) => p.pattern)
        .filter((p) => !existingSignatures.has(p.commands.join("|")));
    if (newPatterns.length === 0)
        return;
    await state.store.addSuccessPatterns(taskId, scope, newPatterns);
}
function unavailableMessage(provider) {
    return `Memory store unavailable (${provider} embedding may be offline). Will retry automatically.`;
}
// SCOPE_CACHE_CAP_WIRE (1.5.9-post): test seam + runtime wiring. Makes the
// store's searchable-cache cap follow config.maxEntriesPerScope (default
// 3000) instead of the module-level MAX_RECORDS_PER_SCOPE default (1000),
// unless the operator explicitly set OPENCODE_MEMORY_PRO_MAX_RECORDS_PER_SCOPE
// (env keeps precedence). Defensive so the legacy-loader walk can call it
// with a plugin input and safely no-op.
function wireStoreCacheCap(store, resolved) {
    if (!store?.cacheConfig || !resolved?.maxEntriesPerScope)
        return;
    if (process.env.OPENCODE_MEMORY_PRO_MAX_RECORDS_PER_SCOPE)
        return;
    store.cacheConfig.maxRecordsPerScope = resolved.maxEntriesPerScope;
}
function hasEmbeddingConfigChanged(current, next) {
    return (current.provider !== next.provider
        || current.model !== next.model
        || (current.baseUrl ?? "") !== (next.baseUrl ?? "")
        || (current.apiKey ?? "") !== (next.apiKey ?? "")
        || (current.timeoutMs ?? 0) !== (next.timeoutMs ?? 0));
}
// CONFIG_CHANGE_INIT_RESET (1.6.2): when the embedding config changes, the
// config hook swaps the embedder and clears `initialized` so the next
// ensureInitialized re-probes the new dimension. But it did NOT clear
// `initPromise` — if an init was already in flight (deferred init racing a
// config re-resolution), ensureInitialized returned the OLD in-flight promise
// (built against the OLD embedder), so the new embedder's dimension was never
// probed and the store kept the old fixed-width vector column (silent
// corruption window). Clearing initPromise here forces the next
// ensureInitialized to start a fresh init against the new embedder.
function handleEmbeddingConfigChange(state, nextConfig) {
    if (hasEmbeddingConfigChanged(state.config.embedding, nextConfig.embedding)) {
        state.embedder = createEmbedder(nextConfig.embedding);
        state.initialized = false;
        state.initPromise = null;
    }
}
// V1_PLUGIN_EXPORT (1.5.4): the default export is a V1 plugin object, not the
// legacy factory function. opencode's loader detects V1 plugins via
// readV1Plugin (default export is an object with `id` + `server`) and then
// calls ONLY server(input) — the named test-seam exports below are never
// invoked as plugin factories. (Legacy format: the loader iterates Object
// values and calls every function export as a plugin; any `export function`
// declared before the default export aborts loading — see 1.5.3 regression.)
export default {
    id: "opencode-memory-pro",
    server: plugin,
};
// Named exports for regression tests only — opencode plugin loading consumes
// the default export and ignores these (kept below `export default` so the
// legacy loader fallback would still reach the server factory first).
export { recordCaptureFragment, fetchSessionMessages, lastUserTextFromMessages, flushAutoCapture, handleSessionIdle, handleSessionStart, handleSessionEnd, preferenceInjectionConfig, runRecallPipeline, wireRetentionScoring, wireStoreCacheCap, handleEmbeddingConfigChange, detectValidationOutcome };
