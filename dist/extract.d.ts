import type { CaptureCandidateResult } from "./types.js";
export declare function extractCaptureCandidate(text: string, minChars: number): CaptureCandidateResult;
export declare function detectGlobalWorthiness(content: string): number;
export declare function isGlobalCandidate(content: string, threshold: number): boolean;
