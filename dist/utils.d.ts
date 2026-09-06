import type { FailureType } from "./types.js";
export declare function expandHomePath(input: string): string;
export declare function toNumber(value: unknown, fallback: number): number;
export declare function toBoolean(value: unknown, fallback: boolean): boolean;
export declare function clamp(value: number, min: number, max: number): number;
export declare function stableHash(input: string): string;
export declare function tokenize(text: string): string[];
export declare function cosineSimilarity(a: number[], b: number[]): number;
export declare function generateId(): string;
export declare function parseJsonObject<T>(value: string | undefined, fallback: T): T;
export declare function classifyFailure(errorMessage: string): FailureType;
export declare function parseValidationOutput(output: string, type: "type-check" | "build" | "test"): {
    status: "pass" | "fail" | "skipped";
    errorCount?: number;
    errorTypes?: string[];
    passedCount?: number;
    failedCount?: number;
};
