import { tool } from "@opencode-ai/plugin";
import { deriveProjectScope, resolveScope } from "../scope.js";
import { generateId, parseJsonObject } from "../utils.js";
function unavailableMessage(provider) {
    return `Memory store unavailable (${provider} embedding may be offline). Will retry automatically.`;
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
                    return unavailableMessage(state.config.embedding.provider);
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
                await state.store.createTaskEpisode(episode);
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
                    return unavailableMessage(state.config.embedding.provider);
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const stateFilter = args.state;
                const episodes = await state.store.queryTaskEpisodes(activeScope, stateFilter);
                if (episodes.length === 0) {
                    return `No task episodes found in scope ${activeScope}`;
                }
                const limited = episodes.slice(0, args.limit ?? 10);
                return limited.map((ep) => {
                    const meta = parseJsonObject(ep.metadataJson, {});
                    return `[${ep.id}] ${ep.taskId} - ${ep.state} (${new Date(ep.startTime).toISOString().split("T")[0]}) ${meta.description ? `- ${meta.description}` : ""}`;
                }).join("\n");
            },
        }),
        similar_task_recall: tool({
            description: "Find similar past tasks using semantic search",
            args: {
                query: tool.schema.string().min(1),
                threshold: tool.schema.number().min(0).max(1).default(0.85),
                limit: tool.schema.number().int().min(1).max(10).default(3),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage(state.config.embedding.provider);
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                // findSimilarTasks matches by keyword only — no embedding needed.
                const similar = await state.store.findSimilarTasks(activeScope, args.query, args.threshold ?? 0.85);
                if (similar.length === 0) {
                    return `No similar tasks found for "${args.query}"`;
                }
                const limited = similar.slice(0, args.limit ?? 3);
                return limited.map((ep) => {
                    const commands = parseJsonObject(ep.commandsJson, []);
                    const outcomes = parseJsonObject(ep.validationOutcomesJson, []);
                    return `Task: ${ep.taskId} (${ep.state})
  Commands: ${commands.slice(0, 3).join(" → ")}
  Validations: ${outcomes.map((o) => `${o.type}:${o.status}`).join(", ") || "none"}
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
                    return unavailableMessage(state.config.embedding.provider);
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const result = await state.store.suggestRetryBudget(activeScope, args.minSamples ?? 3);
                if (!result) {
                    return `Insufficient data for retry budget suggestion (need at least ${args.minSamples} failed tasks)`;
                }
                return JSON.stringify({
                    suggestedRetries: result.suggestedRetries,
                    confidence: result.confidence.toFixed(2),
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
                    return unavailableMessage(state.config.embedding.provider);
                const activeScope = resolveScope(args.scope, context.directory || context.worktree);
                const strategies = await state.store.suggestRecoveryStrategies(activeScope, args.taskId);
                if (strategies.length === 0) {
                    return `No recovery strategies found for task ${args.taskId}`;
                }
                return strategies.map((s) => {
                    return `- ${s.strategy}: ${s.reason} (confidence: ${s.confidence.toFixed(2)}${s.basedOnTask ? `, based on: ${s.basedOnTask}` : ""})`;
                }).join("\n");
            },
        }),
    };
}
