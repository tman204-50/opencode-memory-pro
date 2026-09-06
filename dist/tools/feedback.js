import { tool } from "@opencode-ai/plugin";
import { deriveProjectScope, buildScopeFilter } from "../scope.js";
import { generateId } from "../utils.js";
function unavailableMessage(provider) {
    return `Memory store unavailable (${provider} embedding may be offline). Will retry automatically.`;
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
                    return unavailableMessage(state.config.embedding.provider);
                const scope = args.scope ?? deriveProjectScope(context.directory || context.worktree);
                await state.store.putEvent({
                    id: generateId(),
                    type: "feedback",
                    feedbackType: "missing",
                    scope,
                    sessionID: context.sessionID,
                    timestamp: Date.now(),
                    text: args.text,
                    labels: args.labels ?? [],
                    metadataJson: JSON.stringify({ source: "memory_feedback_missing" }),
                });
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
                    return unavailableMessage(state.config.embedding.provider);
                const scope = args.scope ?? deriveProjectScope(context.directory || context.worktree);
                const scopes = buildScopeFilter(scope, state.config.includeGlobalScope);
                const exists = await state.store.hasMemory(args.id, scopes);
                if (!exists) {
                    return `Memory ${args.id} not found in current scope.`;
                }
                await state.store.putEvent({
                    id: generateId(),
                    type: "feedback",
                    feedbackType: "wrong",
                    scope,
                    sessionID: context.sessionID,
                    timestamp: Date.now(),
                    memoryId: args.id,
                    reason: args.reason,
                    metadataJson: JSON.stringify({ source: "memory_feedback_wrong" }),
                });
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
                    return unavailableMessage(state.config.embedding.provider);
                const scope = args.scope ?? deriveProjectScope(context.directory || context.worktree);
                const scopes = buildScopeFilter(scope, state.config.includeGlobalScope);
                const exists = await state.store.hasMemory(args.id, scopes);
                if (!exists) {
                    return `Memory ${args.id} not found in current scope.`;
                }
                await state.store.putEvent({
                    id: generateId(),
                    type: "feedback",
                    feedbackType: "useful",
                    scope,
                    sessionID: context.sessionID,
                    timestamp: Date.now(),
                    memoryId: args.id,
                    helpful: args.helpful,
                    metadataJson: JSON.stringify({ source: "memory_feedback_useful" }),
                });
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
                    return unavailableMessage(state.config.embedding.provider);
                const scope = args.scope ?? deriveProjectScope(context.directory || context.worktree);
                const summary = await state.store.summarizeEvents(scope, state.config.includeGlobalScope);
                return JSON.stringify(summary, null, 2);
            },
        }),
    };
}
