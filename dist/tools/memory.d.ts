import { type Embedder } from "../embedder.js";
import type { MemoryStore } from "../store.js";
import type { MemoryRuntimeConfig, CitationStatus } from "../types.js";
export interface ToolRuntimeState {
    config: MemoryRuntimeConfig;
    embedder: Embedder;
    store: MemoryStore;
    defaultScope: string;
    initialized: boolean;
    lastRecall: {
        timestamp: number;
        query: string;
        results: {
            memoryId: string;
            score: number;
            factors: {
                relevance: {
                    overall: number;
                    vectorScore: number;
                    bm25Score: number;
                };
                recency: {
                    timestamp: number;
                    ageHours: number;
                    withinHalfLife: boolean;
                    decayFactor: number;
                };
                citation?: {
                    source: string;
                    status: CitationStatus;
                };
                importance: number;
                scope: {
                    memoryScope: string;
                    matchesCurrentScope: boolean;
                    isGlobal: boolean;
                };
            };
        }[];
    } | null;
    consolidationInProgress: Map<string, boolean>;
    ensureInitialized: () => Promise<void>;
}
export type ToolContext = {
    worktree: string;
    sessionID: string;
};
export declare function createMemoryTools(state: ToolRuntimeState): {
    memory_search: {
        description: string;
        args: {
            query: import("zod").ZodString;
            limit: import("zod").ZodDefault<import("zod").ZodNumber>;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            query: string;
            limit: number;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_delete: {
        description: string;
        args: {
            id: import("zod").ZodString;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
            confirm: import("zod").ZodDefault<import("zod").ZodBoolean>;
        };
        execute(args: {
            id: string;
            confirm: boolean;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_clear: {
        description: string;
        args: {
            scope: import("zod").ZodString;
            confirm: import("zod").ZodDefault<import("zod").ZodBoolean>;
        };
        execute(args: {
            scope: string;
            confirm: boolean;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_stats: {
        description: string;
        args: {
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_reembed: {
        description: string;
        args: {
            dryRun: import("zod").ZodDefault<import("zod").ZodOptional<import("zod").ZodBoolean>>;
            confirm: import("zod").ZodDefault<import("zod").ZodOptional<import("zod").ZodBoolean>>;
        };
        execute(args: {
            dryRun: boolean;
            confirm: boolean;
        }): Promise<string>;
    };
    memory_event_cleanup: {
        description: string;
        args: {
            scope: import("zod").ZodOptional<import("zod").ZodString>;
            dryRun: import("zod").ZodDefault<import("zod").ZodOptional<import("zod").ZodBoolean>>;
            archivePath: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            dryRun: boolean;
            scope?: string | undefined;
            archivePath?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_remember: {
        description: string;
        args: {
            text: import("zod").ZodString;
            category: import("zod").ZodOptional<import("zod").ZodString>;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            text: string;
            category?: string | undefined;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_forget: {
        description: string;
        args: {
            id: import("zod").ZodString;
            force: import("zod").ZodDefault<import("zod").ZodBoolean>;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            id: string;
            force: boolean;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_citation: {
        description: string;
        args: {
            id: import("zod").ZodString;
            status: import("zod").ZodOptional<import("zod").ZodString>;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            id: string;
            status?: string | undefined;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_validate_citation: {
        description: string;
        args: {
            id: import("zod").ZodString;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            id: string;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_what_did_you_learn: {
        description: string;
        args: {
            days: import("zod").ZodDefault<import("zod").ZodNumber>;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            days: number;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_why: {
        description: string;
        args: {
            id: import("zod").ZodString;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            id: string;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_explain_recall: {
        description: string;
        args: {
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_scope_promote: {
        description: string;
        args: {
            id: import("zod").ZodString;
            confirm: import("zod").ZodDefault<import("zod").ZodBoolean>;
        };
        execute(args: {
            id: string;
            confirm: boolean;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_scope_demote: {
        description: string;
        args: {
            id: import("zod").ZodString;
            confirm: import("zod").ZodDefault<import("zod").ZodBoolean>;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            id: string;
            confirm: boolean;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_global_list: {
        description: string;
        args: {
            query: import("zod").ZodOptional<import("zod").ZodString>;
            filter: import("zod").ZodOptional<import("zod").ZodString>;
            limit: import("zod").ZodDefault<import("zod").ZodNumber>;
        };
        execute(args: {
            limit: number;
            query?: string | undefined;
            filter?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_consolidate: {
        description: string;
        args: {
            scope: import("zod").ZodOptional<import("zod").ZodString>;
            confirm: import("zod").ZodDefault<import("zod").ZodBoolean>;
        };
        execute(args: {
            confirm: boolean;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_consolidate_all: {
        description: string;
        args: {
            confirm: import("zod").ZodDefault<import("zod").ZodBoolean>;
        };
        execute(args: {
            confirm: boolean;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_port_plan: {
        description: string;
        args: {
            project: import("zod").ZodOptional<import("zod").ZodString>;
            services: import("zod").ZodArray<import("zod").ZodObject<{
                name: import("zod").ZodString;
                containerPort: import("zod").ZodNumber;
                preferredHostPort: import("zod").ZodOptional<import("zod").ZodNumber>;
            }, import("zod/v4/core").$strip>>;
            rangeStart: import("zod").ZodDefault<import("zod").ZodNumber>;
            rangeEnd: import("zod").ZodDefault<import("zod").ZodNumber>;
            persist: import("zod").ZodDefault<import("zod").ZodBoolean>;
        };
        execute(args: {
            services: {
                name: string;
                containerPort: number;
                preferredHostPort?: number | undefined;
            }[];
            rangeStart: number;
            rangeEnd: number;
            persist: boolean;
            project?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_dashboard: {
        description: string;
        args: {
            days: import("zod").ZodDefault<import("zod").ZodNumber>;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            days: number;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
    memory_kpi: {
        description: string;
        args: {
            days: import("zod").ZodDefault<import("zod").ZodNumber>;
            scope: import("zod").ZodOptional<import("zod").ZodString>;
        };
        execute(args: {
            days: number;
            scope?: string | undefined;
        }, context: import("@opencode-ai/plugin").ToolContext): Promise<string>;
    };
};
