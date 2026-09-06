export interface LLMCapturedItem {
    content: string;
    type: "decision" | "fact" | "preference" | "other";
    importance: number;
}
export interface LLMConfig {
    provider?: string;
    model?: string;
}
export declare function parseExtractionJSON(raw: string): LLMCapturedItem[] | null;
export declare function isOwnSession(sessionID: unknown): boolean;
export declare function extractAssistantText(response: unknown): string;
export declare function requestLLMCapture(client: unknown, llmConfig: LLMConfig | undefined, sessionText: string, sessionID?: string): Promise<LLMCapturedItem[] | null>;
export declare function requestLLMDigest(client: unknown, llmConfig: LLMConfig | undefined, texts: string[], targetChars: number, groupKey?: string): Promise<{ text: string; sourceCount: number } | null>;