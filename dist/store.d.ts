import type { CitationSource, CitationStatus, DashboardSummary, EffectivenessSummary, EpisodicTaskRecord, MemoryEffectivenessEvent, MemoryExplanation, MemoryFeedbackStats, MemoryRecord, SearchResult, SuccessPattern, TaskState, ValidationOutcome } from "./types.js";
interface ScopeCacheConfig {
    maxScopes: number;
    maxRecordsPerScope: number;
    enabled: boolean;
}
export declare function storeFastCosine(a: number[], b: number[], normA: number, normB: number): number;
export declare function computeRetentionScore(record: MemoryRecord, feedbackStats?: Pick<MemoryFeedbackStats, "feedbackFactor"> | undefined, weights?: {
    recencyHalfLifeHours?: number;
    importanceWeight?: number;
    feedbackWeight?: number;
}): number;
export declare class MemoryStore {
    private readonly dbPath;
    private static readonly MIN_ROWS_FOR_INDEX;
    private lancedb;
    private connection;
    private table;
    private eventTable;
    private episodicTaskTable;
    private indexState;
    private scopeCache;
    private cacheConfig;
    private cacheStats;
    constructor(dbPath: string, cacheConfig?: Partial<ScopeCacheConfig>);
    init(vectorDim: number): Promise<void>;
    close(): void;
    private retentionConfig;
    setRetentionConfig(config: {
        effectivenessEventsDays: number;
    } | undefined): void;
    private retentionScoringConfig;
    setRetentionScoringConfig(config: {
        recencyHalfLifeHours: number;
        importanceWeight: number;
        feedbackWeight: number;
    } | undefined): void;
    cleanupExpiredEvents(scopes?: string[], retentionDaysOverride?: number): Promise<number>;
    getEventTtlStatus(): Promise<{
        enabled: boolean;
        retentionDays: number;
        expiredCount: number;
        scopeBreakdown: Record<string, number>;
    }>;
    put(record: MemoryRecord): Promise<void>;
    private _put;
    putEvent(event: MemoryEffectivenessEvent): Promise<void>;
    private _putEvent;
    search(params: {
        query: string;
        queryVector: number[];
        scopes: string[];
        limit: number;
        vectorWeight: number;
        bm25Weight: number;
        fuzzyWeight?: number;
        fuzzyThreshold?: number;
        minScore: number;
        rrfK?: number;
        recencyBoost?: boolean;
        recencyHalfLifeHours?: number;
        importanceWeight?: number;
        feedbackWeight?: number;
        globalDiscountFactor?: number;
    }): Promise<SearchResult[]>;
    private _search;
    deleteById(id: string, scopes: string[]): Promise<boolean>;
    deleteByIdRaw(id: string): Promise<boolean>;
    deleteByIdForce(id: string, scopes?: string[]): Promise<boolean>;
    softDeleteMemory(id: string, scopes: string[]): Promise<boolean>;
    updateMemoryScope(id: string, newScope: string, scopes: string[]): Promise<boolean>;
    readGlobalMemories(limit?: number): Promise<MemoryRecord[]>;
    getUnusedGlobalMemories(unusedDaysThreshold: number, limit?: number): Promise<MemoryRecord[]>;
    clearScope(scope: string): Promise<number>;
    list(scope: string, limit: number): Promise<MemoryRecord[]>;
    listSince(scope: string, sinceTimestamp: number, limit?: number): Promise<MemoryRecord[]>;
    pruneScope(scope: string, maxEntries: number): Promise<number>;
    private _pruneScope;
    consolidateDuplicates(scope: string, threshold: number, candidateLimit?: number): Promise<{
        mergedPairs: number;
        updatedRecords: number;
        skippedRecords: number;
    }>;
    private _consolidateDuplicates;
    private findSimilarVectors;
    countIncompatibleVectors(scopes: string[], expectedDim: number): Promise<number>;
    private matchesId;
    hasMemory(id: string, scopes: string[]): Promise<boolean>;
    updateMemoryUsage(id: string, projectScope: string, scopes: string[]): Promise<void>;
    getCitation(id: string, scopes: string[]): Promise<{
        source: CitationSource;
        timestamp: number;
        status: CitationStatus;
        chain: string[];
    } | null>;
    updateCitation(id: string, scopes: string[], updates: {
        status?: CitationStatus;
        chain?: string[];
    }): Promise<boolean>;
    validateCitation(id: string, scopes: string[]): Promise<{
        valid: boolean;
        status: CitationStatus;
        reason?: string;
    }>;
    explainMemory(id: string, scopes: string[], currentScope: string, recencyHalfLifeHours?: number, globalDiscountFactor?: number): Promise<MemoryExplanation | null>;
    refreshExpiredCitations(scope: string, maxAgeDays?: number): Promise<number>;
    listEvents(scopes: string[], limit: number): Promise<MemoryEffectivenessEvent[]>;
    summarizeEvents(scope: string, includeGlobalScope: boolean): Promise<EffectivenessSummary>;
    getWeeklyEffectivenessSummary(scope: string, includeGlobalScope: boolean, days?: number): Promise<DashboardSummary>;
    private aggregateEvents;
    private calculateTrend;
    private generateInsights;
    getIndexHealth(): {
        vector: boolean;
        fts: boolean;
        ftsError?: string;
        vectorRetries?: number;
        ftsRetries?: number;
        dimensionMismatch: boolean;
        expectedDim: number | null;
        actualDim: number | null;
    };
    getPhysicalVectorDim(): Promise<number | null>;
    listDistinctScopes(): Promise<string[]>;
    private invalidateScope;
    private getCachedScopes;
    private _getCachedScopes;
    private enforceMaxScopes;
    private requireTable;
    private requireEventTable;
    private ensureEpisodicTaskTable;
    private requireEpisodicTaskTable;
    createTaskEpisode(record: EpisodicTaskRecord): Promise<void>;
    updateTaskState(taskId: string, state: TaskState, scope: string, failureType?: string, errorMessage?: string): Promise<boolean>;
    getTaskEpisode(taskId: string, scope: string): Promise<EpisodicTaskRecord | null>;
    queryTaskEpisodes(scope: string, state?: TaskState, sinceTimestamp?: number): Promise<EpisodicTaskRecord[]>;
    /**
     * Generic helper for appending items to an episodic task's JSON array field.
     * Centralizes the read-parse-push-write pattern across all add*Episode methods.
     */
    private appendToEpisodeField;
    addCommandToEpisode(taskId: string, scope: string, command: string): Promise<boolean>;
    addValidationOutcome(taskId: string, scope: string, outcome: ValidationOutcome): Promise<boolean>;
    addSuccessPatterns(taskId: string, scope: string, patterns: SuccessPattern[]): Promise<boolean>;
    findSimilarTasks(scope: string, taskDescription: string, minSimilarity?: number): Promise<EpisodicTaskRecord[]>;
    extractSuccessPatternsFromScope(scope: string): Promise<{
        pattern: SuccessPattern;
        count: number;
    }[]>;
    addRetryAttempt(taskId: string, scope: string, attempt: {
        attemptNumber: number;
        outcome: "success" | "failed" | "abandoned";
        errorMessage?: string;
        failureType?: string;
    }): Promise<boolean>;
    addRecoveryStrategy(taskId: string, scope: string, strategy: {
        name: string;
        succeeded: boolean;
    }): Promise<boolean>;
    suggestRetryBudget(scope: string, minSamples?: number): Promise<{
        suggestedRetries: number;
        confidence: number;
        basedOnCount: number;
        shouldStop: boolean;
        stopReason?: string;
    } | null>;
    suggestRecoveryStrategies(scope: string, taskId: string): Promise<{
        strategy: string;
        reason: string;
        confidence: number;
        basedOnTask?: string;
    }[]>;
    calculateRetryToSuccessRate(scope: string, days?: number): Promise<{
        status: "ok" | "insufficient-data" | "no-failed-tasks";
        rate: number;
        totalFailedTasks: number;
        succeededAfterRetry: number;
        sampleCount: number;
    }>;
    calculateMemoryLift(scope: string, days?: number): Promise<{
        status: "ok" | "insufficient-data" | "no-recall-data";
        lift: number;
        successRateWithRecall: number;
        successRateWithoutRecall: number;
        withRecallCount: number;
        withoutRecallCount: number;
    }>;
    private taskUsedRecall;
    getKpiSummary(scope: string, days?: number): Promise<import("./types.js").KpiSummary>;
    readEventsByScopes(scopes: string[]): Promise<MemoryEffectivenessEvent[]>;
    /**
     * Get feedback stats for a set of memory IDs.
     * Returns a map of memoryId -> feedback stats.
     * Only considers feedback within the last 30 days.
     */
    getMemoryFeedbackStatsMap(memoryIds: string[], scopes: string[]): Promise<Map<string, MemoryFeedbackStats>>;
    private readByScopesIncludingMerged;
    private readByScopes;
    private ensureIndexes;
    /**
     * Returns true if the error message indicates a LanceDB retryable commit conflict,
     * meaning another concurrent process may have already created the same index.
     */
    private isCommitConflict;
    /**
     * Create vector index with exponential backoff retry and existence check.
     * Handles concurrent-process commit conflicts by re-verifying index existence
     * after each conflict error, and adds jitter to avoid thundering-herd re-collision.
     */
    private createVectorIndexWithRetry;
    /**
     * Create FTS index with exponential backoff retry and existence check.
     * Handles concurrent-process commit conflicts by re-verifying index existence
     * after each conflict error, and adds jitter to avoid thundering-herd re-collision.
     */
    private createFtsIndexWithRetry;
    private ensureMemoriesTableCompatibility;
    private ensureEventTableCompatibility;
}
export {};
