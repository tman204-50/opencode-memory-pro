import { resolveMemoryConfig } from "./config.js";
import { createEmbedder } from "./embedder.js";
import { extractCaptureCandidate } from "./extract.js";
import { extractPreferenceSignals, aggregatePreferences, resolveConflicts, buildPreferenceInjection } from "./preference.js";
import { buildScopeFilter, deriveProjectScope } from "./scope.js";
import { MemoryStore } from "./store.js";
import { generateId, classifyFailure } from "./utils.js";
import { initLogger, configureLogger, log } from "./logger.js";
import { calculateInjectionLimit, createSummarizationConfig, summarizeContent, truncateText } from "./summarize.js";
import { requestLLMCapture, isOwnSession } from "./llm.js";
import { createMemoryTools, createFeedbackTools, createEpisodicTools } from "./tools/index.js";
import { sweepExpiredMemories } from "./tools/memory.js";
import { createGraphStore } from "./graph.js";
const PLUGIN_VERSION = "1.4.2";
const SCHEMA_VERSION = 1;
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
        const failureSignal = /(^|\s)(FAIL|Failed|Error|Exception)\b/.test(output)
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
            const nextConfig = resolveMemoryConfig(config, input.worktree);
            if (hasEmbeddingConfigChanged(state.config.embedding, nextConfig.embedding)) {
                state.embedder = createEmbedder(nextConfig.embedding);
                state.initialized = false;
            }
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
                await flushAutoCapture(sessionID, state, input.client);
                if (state.config.dedup.enabled) {
                    // Use the session's actual directory (not the static plugin-init
                    // worktree) since a single opencode server process can host
                    // sessions across multiple project directories.
                    const activeScope = await resolveSessionScope(sessionID, input.client, state.defaultScope);
                    // idle = throttled background pass (cooldown-gated);
                    // compacted = explicit compaction, consolidate right away.
                    maybeConsolidateDuplicates(state, activeScope, evt.type === "session.compacted");
                    maybeSweepExpiredMemories(state, activeScope, evt.type === "session.compacted");
                }
            }
        },
        "experimental.text.complete": async (eventInput, eventOutput) => {
            if (isOwnSession(eventInput.sessionID))
                return;
            const list = state.captureBuffer.get(eventInput.sessionID) ?? [];
            list.push(eventOutput.text);
            state.captureBuffer.set(eventInput.sessionID, list);
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
            await state.ensureInitialized();
            if (!state.initialized)
                return;
            const query = await getLastUserText(eventInput.sessionID, input.client);
            if (!query)
                return;
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
            let messages = [];
            try {
                const rawMessages = await input.client.session.messages({ path: { id: eventInput.sessionID } });
                const unwrapped = rawMessages.data;
                if (Array.isArray(unwrapped)) {
                    messages = unwrapped;
                }
            }
            catch {
                messages = [];
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
            if (isFallback) {
                log("info", "Using BM25-only search (embedder unavailable)");
            }
            const results = await state.store.search({
                query,
                queryVector,
                scopes,
                limit: profile.maxMemories * 2,
                vectorWeight: effectiveVectorWeight,
                bm25Weight: effectiveBm25Weight,
                minScore: Math.max(state.config.retrieval.minScore, state.config.injection.injectionFloor),
                rrfK: state.config.retrieval.rrfK,
                recencyBoost: state.config.retrieval.recencyBoost,
                recencyHalfLifeHours: state.config.retrieval.recencyHalfLifeHours,
                importanceWeight: state.config.retrieval.importanceWeight,
                feedbackWeight: state.config.retrieval.feedbackWeight,
                globalDiscountFactor: state.config.globalDiscountFactor,
            });
            // GRAPH_STORE_PHASE1: entity-co-occurrence boost on top of the
            // hybrid score. Multiplicative, conservative (1 + lambda*strength),
            // and a no-op when the graph is disabled or the query has no
            // extractable entities.
            let graphBoostedResults = results;
            if (state.config.graph?.enabled && state.graph?.enabled) {
                try {
                    graphBoostedResults = state.graph.boostResults(query, results, state.config.graph.boostLambda);
                }
                catch (error) {
                    log("warn", `graph boost failed: ${toErrorMessage(error)}`);
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
            const allSignals = results.map((r) => extractPreferenceSignals(r.record)).flat();
            const projectSignals = allSignals.filter((s) => !activeScope.startsWith("global"));
            const globalSignals = allSignals.filter((s) => activeScope.startsWith("global"));
            const projectProfile = aggregatePreferences(projectSignals, "project");
            const globalProfile = aggregatePreferences(globalSignals, "global");
            const effectivePreferences = resolveConflicts(projectProfile.preferences, globalProfile.preferences);
            const preferenceInjection = buildPreferenceInjection(effectivePreferences, {
                mode: state.config.injection.mode === "adaptive" ? "fixed" : state.config.injection.mode,
                maxMemories: profile.maxMemories,
                tokenBudget: 300,
            });
            // Apply injection control with task-type profile
            const injectionConfig = {
                ...state.config.injection,
                maxMemories: profile.maxMemories,
                budgetTokens: profile.budgetTokens,
                summaryTargetChars: profile.summaryTargetChars,
            };
            const injectionLimit = calculateInjectionLimit(mergedResults, injectionConfig);
            const limitedResults = mergedResults.slice(0, injectionLimit);
            await state.store.putEvent({
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
            });
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
            try {
                const queryVector = await state.embedder.embed(query);
                const similarTasks = await state.store.findSimilarTasks(activeScope, query, 0.85, queryVector);
                if (similarTasks.length > 0) {
                    const taskContext = similarTasks.slice(0, 2).map((ep) => {
                        const commands = JSON.parse(ep.commandsJson || "[]");
                        const outcomes = JSON.parse(ep.validationOutcomesJson || "[]");
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
        },
        tool: {
            ...createMemoryTools(state),
            ...createFeedbackTools(state),
            ...createEpisodicTools(state),
        },
    };
    return hooks;
};
async function createRuntimeState(input) {
    const resolved = resolveMemoryConfig(undefined, input.worktree);
    const embedder = createEmbedder(resolved.embedding);
    const store = new MemoryStore(resolved.dbPath);
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
        startupLogged: false,
        captureBuffer: new Map(),
        activeEpisodes: new Map(),
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
            try {
                const dim = await state.embedder.dim();
                await state.store.init(dim);
                state.initialized = true;
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
        },
    };
    return state;
}
async function getLastUserText(sessionID, client) {
    try {
        const response = await client.session.messages({ path: { id: sessionID } });
        const payload = unwrapData(response);
        if (!Array.isArray(payload))
            return "";
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
    catch {
        return "";
    }
}
async function flushAutoCapture(sessionID, state, client) {
    const fragments = state.captureBuffer.get(sessionID) ?? [];
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
    state.captureBuffer.delete(sessionID);
    const combined = fragments.join("\n").trim();
    const activeScope = await resolveSessionScope(sessionID, client, state.defaultScope);
    await state.ensureInitialized();
    if (!state.initialized) {
        return;
    }
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
    state.store
        .consolidateDuplicates(scope, state.config.dedup.consolidateThreshold, state.config.dedup.candidateLimit)
        .catch(() => { })
        .finally(() => state.consolidationInProgress.delete(scope));
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
    sweepExpiredMemories(state, { scope })
        .then((result) => {
            if (result.digestsCreated > 0) {
                log("info", `[retention] sweep: ${result.eligible} expired, ${result.digestsCreated} digest(s), ${result.digested} original(s) digested`, { scope });
            }
        })
        .catch((error) => log("warn", `[retention] sweep failed: ${toErrorMessage(error)}`))
        .finally(() => state.sweepInProgress.delete(scope));
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
}
async function handleSessionEnd(sessionID, state, outcome, errorMessage) {
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
async function persistSuccessPatterns(taskId, scope, state) {
    const patterns = await state.store.extractSuccessPatternsFromScope(scope);
    if (patterns.length === 0)
        return;
    const episode = await state.store.getTaskEpisode(taskId, scope);
    const existingSignatures = new Set((episode ? JSON.parse(episode.successPatternsJson || "[]") : [])
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
function hasEmbeddingConfigChanged(current, next) {
    return (current.provider !== next.provider
        || current.model !== next.model
        || (current.baseUrl ?? "") !== (next.baseUrl ?? "")
        || (current.apiKey ?? "") !== (next.apiKey ?? "")
        || (current.timeoutMs ?? 0) !== (next.timeoutMs ?? 0));
}
export default plugin;
