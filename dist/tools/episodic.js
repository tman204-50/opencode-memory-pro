import { tool } from "@opencode-ai/plugin";
import { resolveScope } from "../scope.js";
import { generateId, parseJsonObject } from "../utils.js";
import { log } from "../logger.js";
function unavailableMessage() {
    // EPISODIC_NO_EMBEDDER (1.5.8): episodic tools never embed — findSimilarTasks
    // is keyword-only and the rest are plain table queries — so the message must
    // not blame the embedding provider.
    return `Memory store unavailable (not initialized). Will retry automatically.`;
}
function fmtConfidence(value) {
    return Number.isFinite(value) ? value.toFixed(2) : "n/a";
}
async function safeStoreCall(store, op, fn) {
    try {
        return await fn();
    }
    catch (error) {
        log("warn", `[episodic:${op}] ${error instanceof Error ? error.message : String(error)}`);
        return `Memory store error in ${op}; try again (see plugin log).`;
    }
}
export function createEpisodicTools(state) {
    return {
        task_episode_create: tool({
            description: "Create a new task episode record for tracking",
            args: {
                taskId: tool.schema.string().min(1),
                scope: tool.schema.string().optional(),
                description: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage();
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const episode = {
                    id: generateId(),
                    sessionId: context.sessionID,
                    scope: activeScope,
                    taskId: args.taskId,
                    state: "pending",
                    startTime: Date.now(),
                    endTime: 0,
                    commandsJson: "[]",
                    validationOutcomesJson: "[]",
                    successPatternsJson: "[]",
                    retryAttemptsJson: "[]",
                    recoveryStrategiesJson: "[]",
                    metadataJson: JSON.stringify({ description: args.description }),
                };
                const ok = await safeStoreCall(state.store, "createTaskEpisode", () => state.store.createTaskEpisode(episode));
                if (typeof ok === "string")
                    return ok;
                return `Created task episode ${episode.id} for task ${args.taskId} in scope ${activeScope}`;
            },
        }),
        task_episode_query: tool({
            description: "Query task episodes by scope and state",
            args: {
                scope: tool.schema.string().optional(),
                state: tool.schema.string().optional(),
                limit: tool.schema.number().int().min(1).max(100).default(10),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage();
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const stateFilter = args.state;
                const episodes = await safeStoreCall(state.store, "queryTaskEpisodes", () => state.store.queryTaskEpisodes(activeScope, stateFilter));
                if (typeof episodes === "string")
                    return episodes;
                if (episodes.length === 0) {
                    return `No task episodes found in scope ${activeScope}`;
                }
                const limited = episodes.slice(0, args.limit);
                return limited.map((ep) => {
                    const meta = parseJsonObject(ep.metadataJson, {});
                    return `[${ep.id}] ${ep.taskId} - ${ep.state} (${new Date(ep.startTime).toISOString().split("T")[0]}) ${meta.description ? `- ${meta.description}` : ""}`;
                }).join("\n");
            },
        }),
        similar_task_recall: tool({
            description: "Find similar past tasks by keyword overlap over their task id, description, and commands (no embeddings used). A task matches when at least the threshold fraction of the query's words appear.",
            args: {
                query: tool.schema.string().min(1),
                threshold: tool.schema.number().min(0).max(1).default(0.5),
                limit: tool.schema.number().int().min(1).max(10).default(3),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage();
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                // findSimilarTasks matches by keyword only — no embedding needed.
                const similar = await safeStoreCall(state.store, "findSimilarTasks", () => state.store.findSimilarTasks(activeScope, args.query, args.threshold));
                if (typeof similar === "string")
                    return similar;
                if (similar.length === 0) {
                    return `No similar tasks found for "${args.query}"`;
                }
                const limited = similar.slice(0, args.limit);
                return limited.map((ep) => {
                    // EPISODIC_SHAPE_GUARD (1.6.2): parseJsonObject accepts any
                    // valid JSON — a row with a valid-but-wrong-shape blob
                    // (object instead of array) made `.slice`/`.map` throw
                    // OUTSIDE safeStoreCall, taking the whole tool down.
                    const commandsRaw = parseJsonObject(ep.commandsJson, []);
                    const outcomesRaw = parseJsonObject(ep.validationOutcomesJson, []);
                    const commands = Array.isArray(commandsRaw) ? commandsRaw : [];
                    const outcomes = Array.isArray(outcomesRaw) ? outcomesRaw : [];
                    return `Task: ${ep.taskId} (${ep.state})
  Commands: ${commands.slice(0, 3).map((c) => (typeof c === "string" ? c : String(c))).join(" → ")}
  Validations: ${outcomes.map((o) => `${o?.type ?? "?"}:${o?.status ?? "?"}`).join(", ") || "none"}
`;
                }).join("\n");
            },
        }),
        retry_budget_suggest: tool({
            description: "Get retry budget suggestion based on historical data",
            args: {
                errorType: tool.schema.string(),
                minSamples: tool.schema.number().int().min(1).default(3),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage();
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const result = await safeStoreCall(state.store, "suggestRetryBudget", () => state.store.suggestRetryBudget(activeScope, args.minSamples));
                if (typeof result === "string")
                    return result;
                if (!result) {
                    return `Insufficient data for retry budget suggestion (need at least ${args.minSamples} failed tasks)`;
                }
                return JSON.stringify({
                    suggestedRetries: result.suggestedRetries,
                    confidence: fmtConfidence(result.confidence),
                    basedOnCount: result.basedOnCount,
                    shouldStop: result.shouldStop,
                    stopReason: result.stopReason,
                }, null, 2);
            },
        }),
        recovery_strategy_suggest: tool({
            description: "Get recovery strategy suggestions after failures",
            args: {
                taskId: tool.schema.string().min(1),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage();
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const strategies = await safeStoreCall(state.store, "suggestRecoveryStrategies", () => state.store.suggestRecoveryStrategies(activeScope, args.taskId));
                if (typeof strategies === "string")
                    return strategies;
                if (strategies.length === 0) {
                    return `No recovery strategies found for task ${args.taskId}`;
                }
                return strategies.map((s) => {
                    return `- ${s.strategy}: ${s.reason} (confidence: ${fmtConfidence(s.confidence)}${s.basedOnTask ? `, based on: ${s.basedOnTask}` : ""})`;
                }).join("\n");
            },
        }),
    };
}
