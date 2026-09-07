export type SpanStopFn = (extra?: Record<string, unknown>) => number;
export interface TimingStat {
    op: string;
    count: number;
    totalMs: number;
    avgMs: number;
    maxMs: number;
    lastMs: number;
    lastExtra?: Record<string, unknown>;
}
export declare function startSpan(name: string): SpanStopFn;
export declare function getTimingStats(): TimingStat[];
export declare function resetTimingStats(): void;
