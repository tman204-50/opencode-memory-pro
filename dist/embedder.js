import { log } from "./logger.js";
import { startSpan } from "./timing.js";
let globalEmbedderHealth = {
    status: "healthy",
    lastError: null,
    lastSuccess: null,
    retryCount: 0,
    fallbackActive: false,
};
export function getEmbedderHealth() {
    return globalEmbedderHealth;
}
export function setEmbedderHealth(health) {
    globalEmbedderHealth = { ...globalEmbedderHealth, ...health };
}
export function resetEmbedderHealth() {
    globalEmbedderHealth = {
        status: "healthy",
        lastError: null,
        lastSuccess: null,
        retryCount: 0,
        fallbackActive: false,
    };
}
async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// EMBEDDER_HEALTH_RESET (1.3.5) + EMBEDDER_RETRY_COUNT_RESET (1.6.2): a
// successful embed/dim after an outage must clear the degraded state AND reset
// the retry counter, or memory_stats reports "bm25-only" / a stale retryCount
// forever after the provider recovers.
function recordEmbedderSuccess() {
    globalEmbedderHealth.lastSuccess = Date.now();
    globalEmbedderHealth.lastError = null;
    globalEmbedderHealth.retryCount = 0;
    globalEmbedderHealth.fallbackActive = false;
    if (globalEmbedderHealth.status === "degraded") {
        globalEmbedderHealth.status = "healthy";
        log("info", "Embedder recovered, resuming normal mode");
    }
}
async function embedWithRetry(embedder, config, text) {
    // TIMING_SPANS (1.4.7): the embedding call is the dominant network cost on
    // both recall and capture; attempts exposes retry amplification.
    const spanExtra = {};
    const stop = startSpan("embedder.embed");
    try {
        return await _embedWithRetry(embedder, config, text, spanExtra);
    }
    finally {
        stop(spanExtra);
    }
}
async function _embedWithRetry(embedder, config, text, spanExtra = {}) {
    const retry = config.retry ?? {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
    };
    if (!retry.enabled) {
        // EMBEDDER_HEALTH_RESET (1.6.2): the retry-disabled path previously
        // returned embedder.embed(text) directly, never touching health — so a
        // previously-degraded embedder stayed fallbackActive:true forever even
        // after embeds succeeded.
        try {
            const result = await embedder.embed(text);
            recordEmbedderSuccess();
            return result;
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            globalEmbedderHealth.lastError = err.message;
            globalEmbedderHealth.status = "degraded";
            globalEmbedderHealth.fallbackActive = true;
            throw err;
        }
    }
    let lastError = null;
    let attempt = 0;
    while (attempt < retry.maxAttempts) {
        attempt++;
        spanExtra.attempts = attempt;
        try {
            const result = await embedder.embed(text);
            recordEmbedderSuccess();
            return result;
        }
        catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            globalEmbedderHealth.retryCount++;
            globalEmbedderHealth.lastError = lastError.message;
            if (attempt >= retry.maxAttempts) {
                break;
            }
            const delay = Math.floor(retry.initialDelayMs * Math.pow(retry.backoffMultiplier, attempt - 1));
            log("warn", `Embedder failed (attempt ${attempt}/${retry.maxAttempts}), retrying in ${delay}ms: ${lastError.message}`);
            await sleep(delay);
        }
    }
    globalEmbedderHealth.status = "degraded";
    globalEmbedderHealth.fallbackActive = true;
    spanExtra.degraded = true;
    log("warn", `Embedder unavailable after ${retry.maxAttempts} attempts, falling back to BM25-only search`);
    throw lastError;
}
async function dimWithRetry(embedder, config) {
    const retry = config.retry ?? {
        enabled: true,
        maxAttempts: 3,
        initialDelayMs: 1000,
        backoffMultiplier: 2,
    };
    if (!retry.enabled) {
        // EMBEDDER_HEALTH_RESET (1.6.2): retry-disabled path must still update
        // health, or a previously-degraded embedder stays fallbackActive:true.
        try {
            const result = await embedder.dim();
            recordEmbedderSuccess();
            return result;
        }
        catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            globalEmbedderHealth.lastError = err.message;
            globalEmbedderHealth.status = "degraded";
            globalEmbedderHealth.fallbackActive = true;
            throw err;
        }
    }
    let lastError = null;
    let attempt = 0;
    while (attempt < retry.maxAttempts) {
        attempt++;
        try {
            const result = await embedder.dim();
            recordEmbedderSuccess();
            return result;
        }
        catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            globalEmbedderHealth.retryCount++;
            globalEmbedderHealth.lastError = lastError.message;
            if (attempt >= retry.maxAttempts) {
                break;
            }
            const delay = Math.floor(retry.initialDelayMs * Math.pow(retry.backoffMultiplier, attempt - 1));
            await sleep(delay);
        }
    }
    globalEmbedderHealth.status = "degraded";
    globalEmbedderHealth.fallbackActive = true;
    throw lastError;
}
const KNOWN_MODEL_DIMS = {
    "nomic-embed-text": 768,
    "mxbai-embed-large": 1024,
    "all-minilm": 384,
    "snowflake-arctic-embed": 1024,
    "text-embedding-3-small": 1536,
    "text-embedding-3-large": 3072,
    "text-embedding-ada-002": 1536,
};
function fallbackDim(model) {
    const normalized = model.toLowerCase().replace(/:.*$/, "");
    for (const [prefix, dim] of Object.entries(KNOWN_MODEL_DIMS)) {
        if (normalized === prefix || normalized.startsWith(`${prefix}:`))
            return dim;
    }
    return null;
}
export class OllamaEmbedder {
    config;
    model;
    cachedDim = null;
    constructor(config) {
        this.config = config;
        this.model = config.model;
    }
    async embed(text) {
        const endpoint = `${this.config.baseUrl ?? "http://127.0.0.1:11434"}/api/embeddings`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 6000);
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                },
                body: JSON.stringify({
                    model: this.config.model,
                    prompt: text,
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`Ollama embedding request failed: HTTP ${response.status}`);
            }
            const data = (await response.json());
            if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
                throw new Error("Ollama embedding response missing embedding vector");
            }
            if (this.cachedDim === null) {
                this.cachedDim = data.embedding.length;
            }
            return data.embedding;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async dim() {
        if (this.cachedDim !== null)
            return this.cachedDim;
        try {
            const probe = await this.embed("dimension probe");
            this.cachedDim = probe.length;
            return this.cachedDim;
        }
        catch {
            const fb = fallbackDim(this.model);
            if (fb !== null) {
                log("warn", `Ollama unreachable, using fallback dim ${fb} for model "${this.model}"`);
                return fb;
            }
            throw new Error(`Ollama unreachable and no known fallback dimension for model "${this.model}"`);
        }
    }
}
export class OpenAIEmbedder {
    config;
    model;
    cachedDim = null;
    constructor(config) {
        this.config = config;
        this.model = config.model;
    }
    async embed(text) {
        if (!this.config.apiKey) {
            throw new Error("OpenAI embedding request failed: missing apiKey. Set embedding.apiKey or OPENCODE_MEMORY_PRO_OPENAI_API_KEY.");
        }
        const baseUrl = (this.config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
        const endpoint = `${baseUrl}/embeddings`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 6000);
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${this.config.apiKey}`,
                },
                body: JSON.stringify({
                    model: this.config.model,
                    input: text,
                    encoding_format: "float",
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                const details = await response.text().catch(() => "");
                const suffix = details ? ` - ${details.slice(0, 240)}` : "";
                throw new Error(`OpenAI embedding request failed: HTTP ${response.status}${suffix}`);
            }
            const data = (await response.json());
            const vector = data.data?.[0]?.embedding;
            if (!Array.isArray(vector) || vector.length === 0) {
                throw new Error("OpenAI embedding response missing embedding vector");
            }
            if (this.cachedDim === null) {
                this.cachedDim = vector.length;
            }
            return vector;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async dim() {
        if (this.cachedDim !== null)
            return this.cachedDim;
        try {
            const probe = await this.embed("dimension probe");
            this.cachedDim = probe.length;
            return this.cachedDim;
        }
        catch {
            const fb = fallbackDim(this.model);
            if (fb !== null) {
                log("warn", `OpenAI embedding probe failed, using fallback dim ${fb} for model "${this.model}"`);
                return fb;
            }
            throw new Error(`OpenAI embedding probe failed and no known fallback dimension for model "${this.model}"`);
        }
    }
}
export function createEmbedder(config) {
    const inner = config.provider === "openai"
        ? new OpenAIEmbedder(config)
        : new OllamaEmbedder(config);
    return {
        get model() {
            return inner.model;
        },
        async embed(text) {
            return embedWithRetry(inner, config, text);
        },
        async dim() {
            return dimWithRetry(inner, config);
        },
    };
}
