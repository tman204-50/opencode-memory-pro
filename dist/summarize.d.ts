import type { ContentType, ContentDetection, SummarizedContent, SummarizationConfig, InjectionConfig, SearchResult } from "./types.js";
/**
 * Detects whether content contains code and its type
 */
export declare function detectContentType(text: string): ContentDetection;
/**
 * Calculates bracket balance for code detection
 */
export declare function calculateBracketBalance(text: string): number;
/**
 * Counts code-related keywords
 */
export declare function countCodeKeywords(text: string): number;
/**
 * Calculates ratio of indented lines
 */
export declare function calculateIndentationRatio(text: string): number;
/**
 * Estimates token count for content
 */
export declare function estimateTokens(text: string, contentType: ContentType): number;
/**
 * Truncates text to max characters
 */
export declare function truncateText(text: string, maxChars: number): string;
/**
 * Smart truncation for code - finds complete statement boundaries
 */
export declare function smartTruncateCode(code: string, maxLines: number, config?: {
    preserveComments?: boolean;
    preserveImports?: boolean;
}): string;
/**
 * Extracts key sentences from text
 */
export declare function extractKeySentences(text: string, targetChars: number): string;
export declare function splitCodeAndText(text: string): Array<{
    type: "code" | "text";
    content: string;
}>;
/**
 * Main summarization function
 */
export declare function summarizeContent(text: string, config: SummarizationConfig): SummarizedContent;
/**
 * Calculates injection limit based on mode
 */
export declare function calculateInjectionLimit(results: SearchResult[], config: InjectionConfig): number;
/**
 * Creates default summarization config from injection config
 */
export declare function createSummarizationConfig(injection: InjectionConfig): SummarizationConfig;
