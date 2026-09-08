import { tool } from "@opencode-ai/plugin";
import { buildScopeFilter, resolveScope } from "../scope.js";
import { generateId } from "../utils.js";
import { log } from "../logger.js";
function unavailableMessage() {
    return `Memory store unavailable (not initialized). Will retry automatically.`;
}
async function safeStoreCall(store, op, fn) {
    try {
        return await fn();
    }
    catch (error) {
        log("warn", `[feedback:${op}] ${error instanceof Error ? error.message : String(error)}`);
        return `Memory store error in ${op}; try again (see plugin log).`;
    }
}
export function createFeedbackTools(state) {
    return {
        memory_feedback_missing: tool({
            description: "Record feedback for memory that should have been stored",
            args: {
                text: tool.schema.string().min(1),
                labels: tool.schema.array(tool.schema.string().min(1)).default([]),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage();
                const scope = resolveScope(args.scope, context.directory || context.worktree);
                const ok = await safeStoreCall(state.store, "putEvent", () => state.store.putEvent({
                    id: generateId(),
                    type: "feedback",
                    feedbackType: "missing",
                    scope,
                    sessionID: context.sessionID,
                    timestamp: Date.now(),
                    text: args.text,
                    labels: args.labels,
                    metadataJson: JSON.stringify({ source: "memory_feedback_missing" }),
                }));
                if (typeof ok === "string")
                    return ok;
                return "Recorded missing-memory feedback.";
            },
        }),
        memory_feedback_wrong: tool({
            description: "Record feedback for memory that should not be stored",
            args: {
                id: tool.schema.string().min(8),
                reason: tool.schema.string().optional(),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage();
                const scope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(scope, state.config.includeGlobalScope);
                const exists = await safeStoreCall(state.store, "hasMemory", () => state.store.hasMemory(args.id, scopes));
                if (typeof exists === "string")
                    return exists;
                if (!exists) {
                    return `Memory ${args.id} not found in scope ${scope}.`;
                }
                const ok = await safeStoreCall(state.store, "putEvent", () => state.store.putEvent({
                    id: generateId(),
                    type: "feedback",
                    feedbackType: "wrong",
                    scope,
                    sessionID: context.sessionID,
                    timestamp: Date.now(),
                    memoryId: args.id,
                    reason: args.reason,
                    metadataJson: JSON.stringify({ source: "memory_feedback_wrong" }),
                }));
                if (typeof ok === "string")
                    return ok;
                return `Recorded wrong-memory feedback for ${args.id}.`;
            },
        }),
        memory_feedback_useful: tool({
            description: "Record whether a recalled memory was helpful",
            args: {
                id: tool.schema.string().min(8),
                helpful: tool.schema.boolean(),
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage();
                const scope = resolveScope(args.scope, context.directory || context.worktree);
                const scopes = buildScopeFilter(scope, state.config.includeGlobalScope);
                const exists = await safeStoreCall(state.store, "hasMemory", () => state.store.hasMemory(args.id, scopes));
                if (typeof exists === "string")
                    return exists;
                if (!exists) {
                    return `Memory ${args.id} not found in scope ${scope}.`;
                }
                const ok = await safeStoreCall(state.store, "putEvent", () => state.store.putEvent({
                    id: generateId(),
                    type: "feedback",
                    feedbackType: "useful",
                    scope,
                    sessionID: context.sessionID,
                    timestamp: Date.now(),
                    memoryId: args.id,
                    helpful: args.helpful,
                    metadataJson: JSON.stringify({ source: "memory_feedback_useful" }),
                }));
                if (typeof ok === "string")
                    return ok;
                return `Recorded recall usefulness feedback for ${args.id}.`;
            },
        }),
        memory_effectiveness: tool({
            description: "Show effectiveness metrics for capture recall and feedback",
            args: {
                scope: tool.schema.string().optional(),
            },
            execute: async (args, context) => {
                await state.ensureInitialized();
                if (!state.initialized)
                    return unavailableMessage();
                const scope = resolveScope(args.scope, context.directory || context.worktree);
                const summary = await safeStoreCall(state.store, "summarizeEvents", () => state.store.summarizeEvents(scope, state.config.includeGlobalScope));
                if (typeof summary === "string")
                    return summary;
                return JSON.stringify(summary, null, 2);
            },
        }),
    };
}
