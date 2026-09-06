import type { ToolRuntimeState } from "./memory.js";
export declare function createFeedbackTools(state: ToolRuntimeState): {
    memory_feedback_missing: {
        description: string;
        args: {
            text: import("zod").ZodString;
            labels: import("zod").ZodDefault<import("zod").ZodArray<import("zod").ZodString>>;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            text: string;
            labels: string[];
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_feedback_wrong: {
        description: string;
        args: {
            id: import("zod").ZodString;
            reason: import("zod").ZodOptional<import("zod").ZodString>;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            id: string;
            reason?: string | undefined;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_feedback_useful: {
        description: string;
        args: {
            id: import("zod").ZodString;
            helpful: import("zod").ZodBoolean;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            id: string;
            helpful: boolean;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_effectiveness: {
        description: string;
        args: {
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
};
