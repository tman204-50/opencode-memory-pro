// LLM_CAPTURE (1.1): SDK-transport LLM extraction and digest generation for
// opencode-memory-pro.
import { log } from "./logger.js";
import { startSpan } from "./timing.js";
import { toNumber } from "./utils.js";
// NO_TEXT_RETRY (1.6.1): cheap flash-tier models (gemini-2.5-flash-lite,
// z-ai/glm-5.3-flash) under load resolve session.prompt successfully with an
// EMPTY parts array — extraction then silently downgrades to heuristics. The
// DSV4 switch sidestepped it; this retries the SAME ephemeral session's prompt
// (no session recreate — create/delete stay 1:1) on the no-text case with a
// short backoff before giving up, so transient provider load self-heals.
// Thrown errors are NOT retried (those already return null immediately and the
// capture heuristics cover them); the retry targets the silent-empty success
// only. Knobs are read at module load like the other env knobs; tests override
// via setLlmRetryPolicy.
const envIntClamped = (name, fallback, min, max) => {
    if (process.env[name] !== undefined && process.env[name] !== "") {
        const parsed = Number(process.env[name]);
        if (Number.isFinite(parsed)) {
            return Math.max(min, Math.min(max, Math.floor(parsed)));
        }
    }
    return fallback;
};
// RETRY_BACKOFF_CLAMP (1.6.1): maxAttempts/initialDelayMs are clamped via
// envIntClamped but backoffMultiplier was read with plain toNumber — with
// maxAttempts=10 and a large multiplier the delay sequence overflows into
// setTimeout's 2^31-1ms clamp (~24.8 days per attempt), hanging the capture
// flush for weeks. Clamp 1–10 like its siblings.
const clampBackoffMultiplier = (value) => Math.max(1, Math.min(10, toNumber(value, 2)));
let llmRetryPolicy = {
    maxAttempts: envIntClamped("OPENCODE_MEMORY_PRO_LLM_RETRY_MAX_ATTEMPTS", 3, 1, 10),
    initialDelayMs: envIntClamped("OPENCODE_MEMORY_PRO_LLM_RETRY_INITIAL_DELAY_MS", 250, 0, 60000),
    backoffMultiplier: clampBackoffMultiplier(process.env.OPENCODE_MEMORY_PRO_LLM_RETRY_BACKOFF_MULTIPLIER),
};
// SET_RETRY_POLICY_CLAMP (1.6.2): setLlmRetryPolicy used a raw
// Object.assign, bypassing every clamp — maxAttempts: Infinity → unbounded
// retry loop; 0 → immediate failure. Clamp each field with the same bounds
// resetLlmRetryPolicy/env read use, so the test seam can't exceed them.
// Non-numeric/Infinity values fall back via toNumber like the env path.
function clampRetryPatch(patch = {}) {
    const out = {};
    if (patch.maxAttempts !== undefined)
        out.maxAttempts = Math.max(1, Math.min(10, Math.floor(toNumber(patch.maxAttempts, 3))));
    if (patch.initialDelayMs !== undefined)
        out.initialDelayMs = Math.max(0, Math.min(60000, Math.floor(toNumber(patch.initialDelayMs, 250))));
    if (patch.backoffMultiplier !== undefined)
        out.backoffMultiplier = clampBackoffMultiplier(patch.backoffMultiplier);
    return out;
}
export function setLlmRetryPolicy(patch) {
    Object.assign(llmRetryPolicy, clampRetryPatch(patch));
}
export function resetLlmRetryPolicy() {
    llmRetryPolicy = {
        maxAttempts: envIntClamped("OPENCODE_MEMORY_PRO_LLM_RETRY_MAX_ATTEMPTS", 3, 1, 10),
        initialDelayMs: envIntClamped("OPENCODE_MEMORY_PRO_LLM_RETRY_INITIAL_DELAY_MS", 250, 0, 60000),
        backoffMultiplier: clampBackoffMultiplier(process.env.OPENCODE_MEMORY_PRO_LLM_RETRY_BACKOFF_MULTIPLIER),
    };
}
export function getLlmRetryPolicy() {
    return { ...llmRetryPolicy };
}
//
// Transport rules (per design):
//   - The LLM is addressed by opencode provider ID + model ID. opencode owns
//     routing, auth, and base URLs; this module never sees an API key.
//   - Calls run through ephemeral SDK sessions (created, prompted, deleted),
//     isolated from user-visible history.
//   - Every entry point is failure-tolerant: returns null/[] on any error so
//     callers can fall back to the offline heuristics pipeline.
//   - Tools are disabled on the ephemeral prompt so extraction/summarization
//     is a pure text-in/text-out call.
// CAPTURE_NO_REASONING (1.4.9): live usage samples (1.4.8) showed every
// capture call burning reasoning=638-1173 tokens before a tiny out=168-671
// JSON reply, with llm.prompt p50=20.4s/p90=52.9s. The SDK prompt body exposes
// no maxTokens/temperature/reasoning knobs, so the only request-side lever is
// the prompt itself: an explicit no-step-by-step directive. Measurable via the
// reasoning= field in the PROMPT_USAGE_LOG line after restart.
const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction system for an AI coding assistant.

Read the conversation transcript below and extract DURABLE, memory-worthy content: decisions made, preferences expressed, durable facts about the user's projects/systems, and context that will matter weeks from now.

Ignore: greetings, small talk, ephemeral task details, raw tool output that contains no decision, and anything that will not matter later.

Return ONLY valid JSON — an array of objects, with no markdown fences and no commentary:
[{"content": "...", "type": "fact|decision|preference|other", "importance": 0.0-1.0}]

Rules:
- Do NOT reason step-by-step or show any thinking. Read the transcript once and output only the JSON array immediately.
- content: 1-3 self-contained sentences (no bare pronouns). One memory per item.
- type: "decision" (a choice was made), "fact" (durable fact), "preference" (user's stated preference), "other".
- importance: 0.0 (trivial) to 1.0 (critical). Be selective: most transcripts yield 1-4 memories.
- Emit at most 8 memories per transcript.`;
const DIGEST_SYSTEM_PROMPT = `You are a memory summarization system for an AI coding assistant.

Below is a set of memories about the same topic. Write ONE concise abstractive summary (target length: TARGETCHARS characters; topic: GROUPKEY) that a future agent can read to regain the essentials.

Preserve: decisions, root causes, concrete facts, user preferences, and any names/versions that matter. Omit repetition and low-value detail.

Return ONLY the summary text. No markdown headers, no commentary.`;
const VALID_CAPTURE_TYPES = ["decision", "fact", "preference", "other"];
const MAX_EXTRACTIONS = 8;
const MAX_CAPTURE_INPUT_CHARS = 60000;
// CAPTURE_TAIL_KEEP (1.4.9): transcripts regularly hit the 60k-char cap
// (observed in=16-18k tokens on every live flush). The old .slice(0, MAX)
// kept the HEAD — for a long session that discarded exactly the recent
// decisions a memory system should keep. Truncate from the front so the tail
// (freshest context) survives.
export function truncateCaptureInput(text) {
    return text.length > MAX_CAPTURE_INPUT_CHARS ? text.slice(-MAX_CAPTURE_INPUT_CHARS) : text;
}
const MAX_DIGEST_INPUT_CHARS = 80000;
/**
 * Session IDs of ephemeral sessions this plugin created itself. Their own
 * events (idle/deleted/text.complete) must never be fed back into the
 * capture/consolidate pipeline, or the plugin would loop on itself,
 * spawning unbounded LLM capture sessions and stacking consolidate passes.
 */
const OWN_SESSION_IDS = new Set();
export function isOwnSession(sessionID) {
    return typeof sessionID === "string" && OWN_SESSION_IDS.has(sessionID);
}
// OWN_SESSIONS_CAP (1.4.6): OWN_SESSION_IDS grew unbounded — one entry per
// ephemeral LLM session for the lifetime of the server process. FIFO-capped
// like sessionErrors in index.js; Set iteration order is insertion order, so
// the oldest id is evicted. (Ids are evicted only from tracking, the sessions
// themselves are already deleted server-side in runEphemeralPrompt's finally.)
const MAX_OWN_SESSION_IDS = 500;
export function trackOwnSession(sessionId) {
    OWN_SESSION_IDS.add(sessionId);
    if (OWN_SESSION_IDS.size > MAX_OWN_SESSION_IDS) {
        const oldest = OWN_SESSION_IDS.values().next().value;
        if (oldest !== undefined)
            OWN_SESSION_IDS.delete(oldest);
    }
}
// LLM_HEALTH (1.3.9): module-level runtime health for the capture/summary LLM,
// mirroring the embedder pattern so memory_stats can report both sides.
const globalLlmHealth = {
    status: "never-called", // never-called | healthy | error
    lastError: null,
    lastSuccess: null,
    errorCount: 0,
    lastConfig: null,
};
export function getLlmHealth() {
    return { ...globalLlmHealth };
}
export function setLlmHealth(patch) {
    Object.assign(globalLlmHealth, patch);
}
export function resetLlmHealth() {
    Object.assign(globalLlmHealth, {
        status: "never-called",
        lastError: null,
        lastSuccess: null,
        errorCount: 0,
        lastConfig: null,
    });
}
/**
 * Tolerant JSON parse of the extraction model's reply. Accepts a bare array
 * or an object wrapping an array under "memories"/"items"; strips markdown
 * fences. Returns a normalized [{content,type,importance}] list, or null.
 */
export function parseExtractionJSON(raw) {
    if (typeof raw !== "string")
        return null;
    let cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    if (!cleaned)
        return null;
    let data;
    try {
        data = JSON.parse(cleaned);
    }
    catch {
        return null;
    }
    let list = Array.isArray(data)
        ? data
        : (Array.isArray(data?.memories) ? data.memories
            : (Array.isArray(data?.items) ? data.items : null));
    if (list === null)
        return null;
    if (list.length === 0)
        return [];
    const out = [];
    for (const item of list.slice(0, MAX_EXTRACTIONS)) {
        const content = typeof item?.content === "string" ? item.content.trim() : "";
        if (!content)
            continue;
        const type = VALID_CAPTURE_TYPES.includes(item?.type) ? item.type : "other";
        // EXTRACTION_EMPTY_IMPORTANCE (1.6.2): Number("")===0 and Number(null)===0 —
        // an empty-string or null importance was silently treated as 0.0
        // (bottom-ranked, first retention candidate) instead of the type
        // default. Treat "" and null like missing (undefined path already
        // yields NaN → default).
        let importance = (item?.importance === "" || item?.importance == null) ? NaN : Number(item?.importance);
        if (!Number.isFinite(importance)) {
            importance = type === "decision" ? 0.9 : type === "fact" ? 0.75 : 0.65;
        }
        importance = Math.max(0, Math.min(1, importance));
        out.push({ content, type, importance });
    }
    return out.length > 0 ? out : null;
}
/**
 * Pulls concatenated assistant text parts out of a session.prompt response
 * (opencode SDK shape: { data: { info, parts } }).
 */
export function extractAssistantText(response) {
    const payload = response && typeof response === "object" && "data" in response ? response.data : response;
    const parts = payload?.parts;
    if (!Array.isArray(parts))
        return "";
    return parts
        .filter((p) => p?.type === "text" && typeof p?.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim();
}
function hasUsableConfig(llmConfig, client) {
    return Boolean(client?.session?.create && client?.session?.prompt && client?.session?.delete
        && llmConfig?.provider && llmConfig?.model);
}
// PROMPT_USAGE_LOG (1.4.8), extracted for the NO_TEXT_RETRY (1.6.1) loop so
// every prompt attempt logs its own token usage (empty replies stay
// attributable). Tolerant shape: info.tokens or info.usage,
// input/output or prompt_tokens/completion_tokens. No-op when absent.
function logPromptUsage(response, llmConfig, title) {
    const payload = response && typeof response === "object" && "data" in response ? response.data : response;
    const tokens = payload?.info?.tokens ?? payload?.info?.usage ?? null;
    if (!tokens || typeof tokens !== "object")
        return;
    const input = tokens.input ?? tokens.prompt_tokens;
    const output = tokens.output ?? tokens.completion_tokens;
    const fields = [];
    if (Number.isFinite(input))
        fields.push(`in=${input}`);
    if (Number.isFinite(output))
        fields.push(`out=${output}`);
    if (Number.isFinite(tokens.reasoning) && tokens.reasoning > 0)
        fields.push(`reasoning=${tokens.reasoning}`);
    const cacheRead = tokens.cache?.read;
    if (Number.isFinite(cacheRead) && cacheRead > 0)
        fields.push(`cacheRead=${cacheRead}`);
    if (fields.length > 0) {
        log("info", `[llm] ${title}: usage ${fields.join(" ")} (provider=${llmConfig.provider}, model=${llmConfig.model})`);
    }
}
/**
 * Runs one structured extraction pass over a session transcript via the
 * opencode SDK. Returns [{content,type,importance}] on success — including [] 
 * when the model finds nothing — or null on any failure (unreachable provider,
 * timeout, unparseable reply, missing config).
 */
export async function requestLLMCapture(client, llmConfig, sessionText, sessionID) {
    if (!hasUsableConfig(llmConfig, client))
        return null;
    const text = typeof sessionText === "string" ? sessionText.trim() : "";
    if (!text)
        return null;
    const input = truncateCaptureInput(text);
    const userPart = `Conversation transcript (${sessionID ? `session ${sessionID}` : "session"}):\n\n${input}\n\nExtract memories now.`;
    const reply = await runEphemeralPrompt(client, llmConfig, EXTRACTION_SYSTEM_PROMPT, userPart, "memory-capture");
    if (reply === null) {
        log("warn", "[capture] llm extraction returned nothing; falling back to heuristics");
        return null;
    }
    const parsed = parseExtractionJSON(reply);
    if (parsed === null) {
        log("warn", `[capture] llm extraction reply was not parseable as structured JSON: ${reply.slice(0, 300)}`);
        return null;
    }
    if (parsed.length === 0) {
        log("info", "[capture] llm extraction succeeded but produced no memories; falling back to heuristics");
        return parsed;
    }
    return parsed;
}
/**
 * Generates one abstractive LLM digest for a group of memories. Returns
 * { text, sourceCount } or null on any failure (caller falls back to the
 * offline extractive digest).
 */
export async function requestLLMDigest(client, llmConfig, texts, targetChars, groupKey) {
    if (!hasUsableConfig(llmConfig, client))
        return null;
    const safeTexts = Array.isArray(texts) ? texts.filter((t) => typeof t === "string" && t.trim().length > 0) : [];
    if (safeTexts.length === 0)
        return null;
    let joined = safeTexts.map((t, i) => `[${i + 1}] ${t.trim()}`).join("\n\n");
    if (joined.length > MAX_DIGEST_INPUT_CHARS) {
        joined = joined.slice(0, MAX_DIGEST_INPUT_CHARS);
    }
    const userPart = `Topic: ${groupKey ?? "memories"}\nTarget length: ${Math.max(100, Number(targetChars) || 500)} characters\n\n${joined}\n\nWrite the summary now.`;
    const system = DIGEST_SYSTEM_PROMPT
        .replace("TARGETCHARS", String(Math.max(100, Number(targetChars) || 500)))
        .replace("GROUPKEY", groupKey ?? "memories");
    const reply = await runEphemeralPrompt(client, llmConfig, system, userPart, "memory-digest");
    if (reply === null || reply.length === 0) {
        log("warn", `[digest] llm digest failed for "${groupKey ?? "memories"}"; falling back to extractive digest`);
        return null;
    }
    return { text: reply, sourceCount: safeTexts.length };
}
/**
 * Shared ephemeral-session round trip: create → prompt (tools disabled) →
 * delete (in finally). Returns the assistant's text, or null on failure.
 */
async function runEphemeralPrompt(client, llmConfig, system, userText, title) {
    // TIMING_SPANS (1.4.7): ephemeral session create + prompt + delete; in
    // capture.mode="llm" this round trip dominates session-idle latency.
    const stop = startSpan("llm.prompt");
    try {
        return await _runEphemeralPrompt(client, llmConfig, system, userText, title);
    }
    finally {
        stop({ title });
    }
}
async function _runEphemeralPrompt(client, llmConfig, system, userText, title) {
    globalLlmHealth.lastConfig = { provider: llmConfig?.provider ?? null, model: llmConfig?.model ?? null };
    // RETRY_SESSION_PER_ATTEMPT (1.6.2): NO_TEXT_RETRY (1.6.1) reused the
    // SAME ephemeral session across retries, so each retry appended the full
    // transcript again — effective context multiplied by attempts (3× 60k
    // chars can exceed the context window, exactly the overloaded-
    // flash-model workload retries exist for). Each attempt now runs in a
    // FRESH session (create/delete stay 1:1 per attempt). Thrown errors and
    // session.create failures are still NOT retried — they return null
    // immediately, preserving the NO_TEXT_RETRY scope guard.
    const policy = llmRetryPolicy;
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
        const outcome = await runEphemeralAttempt(client, llmConfig, system, userText, title);
        if (outcome.fatal)
            return null; // thrown error or create failure — not retried
        if (outcome.text)
            return outcome.text;
        // outcome.empty → silent-empty success: retry with backoff.
        if (attempt < policy.maxAttempts) {
            const delay = Math.floor(policy.initialDelayMs * Math.pow(policy.backoffMultiplier, attempt - 1));
            log("warn", `[llm] ${title}: session.prompt returned no text parts (attempt ${attempt}/${policy.maxAttempts}); retrying in ${delay}ms (provider=${llmConfig.provider}, model=${llmConfig.model})`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    log("warn", `[llm] ${title}: session.prompt succeeded but returned no text parts after ${policy.maxAttempts} attempts (provider=${llmConfig.provider}, model=${llmConfig.model})`);
    setLlmHealth({ status: "error", lastError: "session.prompt returned no text parts", lastSuccess: globalLlmHealth.lastSuccess, errorCount: globalLlmHealth.errorCount + 1 });
    return null;
}
/**
 * One ephemeral round trip: create → prompt (tools disabled) → delete (in
 * finally). Returns { fatal: true } for thrown errors / create failures
 * (never retried), { text } on a successful text reply, { empty: true } on a
 * successful prompt with no text parts (the only retryable outcome).
 */
async function runEphemeralAttempt(client, llmConfig, system, userText, title) {
    let sessionId = null;
    try {
        const created = await client.session.create({
            body: { title: `opencode-memory-pro ${title}` },
        });
        const createdPayload = created && typeof created === "object" && "data" in created ? created.data : created;
        sessionId = createdPayload?.id;
        if (!sessionId) {
            log("warn", `[llm] ${title}: session.create did not return an id (got ${JSON.stringify(createdPayload)?.slice(0, 200)})`);
            setLlmHealth({ status: "error", lastError: "session.create returned no id", lastSuccess: globalLlmHealth.lastSuccess, errorCount: globalLlmHealth.errorCount + 1 });
            return { fatal: true };
        }
        trackOwnSession(sessionId);
        const response = await client.session.prompt({
            path: { id: sessionId },
            body: {
                system,
                parts: [{ type: "text", text: userText }],
                model: { providerID: llmConfig.provider, modelID: llmConfig.model },
                tools: {},
            },
        });
        // PROMPT_USAGE_LOG (1.4.8) — see logPromptUsage: every attempt
        // logs its own token usage line so empty replies stay attributable.
        logPromptUsage(response, llmConfig, title);
        const text = extractAssistantText(response);
        if (text) {
            setLlmHealth({ status: "healthy", lastError: null, lastSuccess: Date.now(), errorCount: 0 });
            return { text };
        }
        return { empty: true };
    }
    catch (error) {
        log("warn", `[llm] ${title}: ${error instanceof Error ? error.message : String(error)} (provider=${llmConfig.provider}, model=${llmConfig.model})`);
        setLlmHealth({ status: "error", lastError: error instanceof Error ? error.message : String(error), lastSuccess: globalLlmHealth.lastSuccess, errorCount: globalLlmHealth.errorCount + 1 });
        return { fatal: true };
    }
    finally {
        if (sessionId) {
            try {
                await client.session.delete({ path: { id: sessionId } });
            }
            catch (error) {
                log("warn", `[llm] ${title}: ephemeral session cleanup failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
}