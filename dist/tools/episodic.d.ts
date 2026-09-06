import type { ToolRuntimeState } from "./memory.js";
export declare function createEpisodicTools(state: ToolRuntimeState): {
    task_episode_create: {
        description: string;
        args: {
            taskId: import("zod").ZodString;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
            description: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            taskId: string;
            scope?: string | undefined;
            description?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    task_episode_query: {
        description: string;
        args: {
            scope: import("zod").ZodOptional<import("zod").ZodString>;
            state: import("zod").ZodOptional<import("zod").ZodString>;
            limit: import("zod").ZodDefault<import("zod").ZodNumber>;
        };
        execute(args: {
            limit: number;
            scope?: string | undefined;
            state?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    similar_task_recall: {
        description: string;
        args: {
            query: import("zod").ZodString;
            threshold: import("zod").ZodDefault<import("zod").ZodNumber>;
            limit: import("zod").ZodDefault<import("zod").ZodNumber>;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            query: string;
            threshold: number;
            limit: number;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    retry_budget_suggest: {
        description: string;
        args: {
            errorType: import("zod").ZodString;
            minSamples: import("zod").ZodDefault<import("zod").ZodNumber>;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            errorType: string;
            minSamples: number;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    recovery_strategy_suggest: {
        description: string;
        args: {
            taskId: import("zod").ZodString;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            taskId: string;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
};
