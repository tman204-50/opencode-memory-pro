import type { EmbedderHealth, EmbeddingConfig } from "./types.js";
export interface Embedder {
    readonly model: string;
    embed(text: string): Promise<number[]>;
    dim(): Promise<number>;
}
export declare function getEmbedderHealth(): EmbedderHealth;
export declare function setEmbedderHealth(health: Partial<EmbedderHealth>): void;
export declare function resetEmbedderHealth(): void;
export declare class OllamaEmbedder implements Embedder {
    private readonly config;
    readonly model: string;
    private cachedDim;
    constructor(config: EmbeddingConfig);
    embed(text: string): Promise<number[]>;
    dim(): Promise<number>;
}
export declare class OpenAIEmbedder implements Embedder {
    private readonly config;
    readonly model: string;
    private cachedDim;
    constructor(config: EmbeddingConfig);
    embed(text: string): Promise<number[]>;
    dim(): Promise<number>;
}
export declare function createEmbedder(config: EmbeddingConfig): Embedder;
