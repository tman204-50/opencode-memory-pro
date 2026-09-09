import test from "node:test";
import assert from "node:assert/strict";

import { extractiveDigest, retentionCandidates, storeFastCosine, expiredDigestCandidates, computeRetentionScore } from "../dist/store.js";
import { extractEntities, extractTypedRelations } from "../dist/graph.js";
import { resolveMemoryConfig, mergeMemoryConfig } from "../dist/config.js";
import { parseExtractionJSON, extractAssistantText, requestLLMCapture, requestLLMDigest, isOwnSession, trackOwnSession, truncateCaptureInput, setLlmRetryPolicy, resetLlmRetryPolicy, getLlmRetryPolicy } from "../dist/llm.js";
import { summarizeContent, extractKeySentences } from "../dist/summarize.js";
import { resolveScope } from "../dist/scope.js";
import { flushAutoCapture, handleSessionIdle, handleSessionStart, handleSessionEnd, preferenceInjectionConfig, initializeStore, recordCaptureFragment, fetchSessionMessages, lastUserTextFromMessages, runRecallPipeline, wireRetentionScoring, handleEmbeddingConfigChange, detectValidationOutcome } from "../dist/index.js";
import { extractCaptureCandidate } from "../dist/extract.js";
import { buildPreferenceInjection, extractPreferenceSignals } from "../dist/preference.js";
import { repairEmbeddingDimension } from "../dist/tools/memory.js";
import { createEmbedder, getEmbedderHealth, setEmbedderHealth, resetEmbedderHealth } from "../dist/embedder.js";

process.env.OPENCODE_MEMORY_PRO_SKIP_SIDECAR = "true";

test("identity: config defaults to opencode-memory-pro", () => {
    const cfg = resolveMemoryConfig({}, "/tmp");
    assert.equal(cfg.provider, "opencode-memory-pro");
    assert.equal(cfg.dbPath, `${process.env.HOME}/.opencode/memory/lancedb`);
    assert.equal(cfg.scoping, "global");
    assert.equal(cfg.graph.enabled, true);
    assert.equal(cfg.graph.dbPath, `${process.env.HOME}/.opencode/memory/graph.db`);
    assert.equal(cfg.retention.memory.enabled, true);
    assert.equal(cfg.summarize.enabled, true);
});

test("config: retention.scoring defaults to retrieval weights and can diverge", () => {
    const defaults = resolveMemoryConfig({}, "/tmp");
    assert.equal(defaults.retention.scoring.recencyHalfLifeHours, defaults.retrieval.recencyHalfLifeHours, "half-life must default to retrieval");
    assert.equal(defaults.retention.scoring.importanceWeight, defaults.retrieval.importanceWeight, "importanceWeight must default to retrieval");
    assert.equal(defaults.retention.scoring.feedbackWeight, defaults.retrieval.feedbackWeight, "feedbackWeight must default to retrieval");

    const divergent = resolveMemoryConfig({
        memory: {
            retention: { scoring: { importanceWeight: 1.5, feedbackWeight: 0 } },
        },
    }, "/tmp");
    assert.equal(divergent.retention.scoring.importanceWeight, 1.5, "retention.scoring.importanceWeight must override");
    assert.equal(divergent.retention.scoring.feedbackWeight, 0, "retention.scoring.feedbackWeight must override");
    assert.equal(divergent.retention.scoring.recencyHalfLifeHours, divergent.retrieval.recencyHalfLifeHours, "unset scoring key must still default to retrieval");
    assert.equal(divergent.retrieval.importanceWeight, 0.4, "live search ranking must NOT change when retention.scoring diverges");
});

test("config: retention.scoring env overrides take precedence", () => {
    const old = process.env.OPENCODE_MEMORY_PRO_RETENTION_SCORING_IMPORTANCE_WEIGHT;
    process.env.OPENCODE_MEMORY_PRO_RETENTION_SCORING_IMPORTANCE_WEIGHT = "2";
    try {
        const cfg = resolveMemoryConfig({ memory: { retention: { scoring: { importanceWeight: 0.8 } } } }, "/tmp");
        assert.equal(cfg.retention.scoring.importanceWeight, 2, "env must win over sidecar/raw");
        assert.equal(cfg.retrieval.importanceWeight, 0.4, "retrieval ranking must stay unchanged");
    }
    finally {
        if (old === undefined) {
            delete process.env.OPENCODE_MEMORY_PRO_RETENTION_SCORING_IMPORTANCE_WEIGHT;
        }
        else {
            process.env.OPENCODE_MEMORY_PRO_RETENTION_SCORING_IMPORTANCE_WEIGHT = old;
        }
    }
});

test("config: capture defaults to heuristics with the agreed summarization model", () => {
    const cfg = resolveMemoryConfig({}, "/tmp");
    assert.equal(cfg.capture.mode, "heuristics");
    assert.equal(cfg.capture.llm.provider, "openrouter");
    assert.equal(cfg.capture.llm.model, "z-ai/glm-5.3-flash");
});

test("config: capture.mode llm + custom provider/model resolve from raw and env", () => {
    const viaRaw = resolveMemoryConfig({
        memory: {
            capture: { mode: "llm", llm: { provider: "openclaw", model: "openclaw" } },
        },
    }, "/tmp");
    assert.equal(viaRaw.capture.mode, "llm");
    assert.equal(viaRaw.capture.llm.provider, "openclaw");
    assert.equal(viaRaw.capture.llm.model, "openclaw");

    const oldMode = process.env.OPENCODE_MEMORY_PRO_CAPTURE_MODE;
    const oldProvider = process.env.OPENCODE_MEMORY_PRO_CAPTURE_LLM_PROVIDER;
    const oldModel = process.env.OPENCODE_MEMORY_PRO_CAPTURE_LLM_MODEL;
    try {
        process.env.OPENCODE_MEMORY_PRO_CAPTURE_MODE = "llm";
        process.env.OPENCODE_MEMORY_PRO_CAPTURE_LLM_PROVIDER = "openai";
        process.env.OPENCODE_MEMORY_PRO_CAPTURE_LLM_MODEL = "gpt-4o-mini";
        const viaEnv = resolveMemoryConfig({}, "/tmp");
        assert.equal(viaEnv.capture.mode, "llm");
        assert.equal(viaEnv.capture.llm.provider, "openai");
        assert.equal(viaEnv.capture.llm.model, "gpt-4o-mini");
    }
    finally {
        if (oldMode === undefined)
            delete process.env.OPENCODE_MEMORY_PRO_CAPTURE_MODE;
        else
            process.env.OPENCODE_MEMORY_PRO_CAPTURE_MODE = oldMode;
        if (oldProvider === undefined)
            delete process.env.OPENCODE_MEMORY_PRO_CAPTURE_LLM_PROVIDER;
        else
            process.env.OPENCODE_MEMORY_PRO_CAPTURE_LLM_PROVIDER = oldProvider;
        if (oldModel === undefined)
            delete process.env.OPENCODE_MEMORY_PRO_CAPTURE_LLM_MODEL;
        else
            process.env.OPENCODE_MEMORY_PRO_CAPTURE_LLM_MODEL = oldModel;
    }
});

test("config: any non-llm capture mode value coerces to heuristics", () => {
    const cfg = resolveMemoryConfig({ memory: { capture: { mode: "hybrid" } } }, "/tmp");
    assert.equal(cfg.capture.mode, "heuristics");
});

// RRF_K_CLAMP (1.6.2): rrfK had a floor but no upper clamp — a huge value
// flattened every RRF score toward a uniform 1.0, destroying the merge.
test("config: rrfK clamps to [1,1000] (RRF_K_CLAMP)", () => {
    assert.equal(resolveMemoryConfig({ memory: { retrieval: { rrfK: 1e9 } } }, "/tmp").retrieval.rrfK, 1000,
        "absurdly large rrfK must clamp to 1000");
    assert.equal(resolveMemoryConfig({ memory: { retrieval: { rrfK: 0 } } }, "/tmp").retrieval.rrfK, 1,
        "sub-1 rrfK must clamp to 1");
    const def = resolveMemoryConfig({}, "/tmp").retrieval.rrfK;
    assert.equal(def, 60, "default rrfK stays 60");
});

// DEDUP_CLAMP_LOG (1.6.2): the clamp warning compared against the raw CONFIG
// value only — an in-range ENV override logged a misleading "clamped from 50
// to 30". The warn must fire only when the EFFECTIVE value was out of bounds.
test("config: dedup candidateLimit clamp warn fires only on the effective out-of-bounds value (DEDUP_CLAMP_LOG)", () => {
    const warns = [];
    const originalWarn = console.warn;
    console.warn = (m) => { warns.push(String(m)); };
    const prev = process.env.OPENCODE_MEMORY_PRO_DEDUP_CANDIDATE_LIMIT;
    try {
        process.env.OPENCODE_MEMORY_PRO_DEDUP_CANDIDATE_LIMIT = "30";
        resolveMemoryConfig({ memory: { dedup: { candidateLimit: 500 } } }, "/tmp");
        assert.ok(!warns.some((m) => m.includes("clamped")),
            "an in-range env override must not be reported as clamped");
        delete process.env.OPENCODE_MEMORY_PRO_DEDUP_CANDIDATE_LIMIT;
        resolveMemoryConfig({ memory: { dedup: { candidateLimit: 500 } } }, "/tmp");
        assert.ok(warns.some((m) => m.includes("clamped from 500 to 200")),
            "an out-of-bounds config value must warn with the correct original");
    }
    finally {
        console.warn = originalWarn;
        if (prev === undefined)
            delete process.env.OPENCODE_MEMORY_PRO_DEDUP_CANDIDATE_LIMIT;
        else
            process.env.OPENCODE_MEMORY_PRO_DEDUP_CANDIDATE_LIMIT = prev;
    }
});

// PROTECTED_CATEGORIES_EMPTY (1.6.2): an explicit [] fell back to the
// ["digest"] default, so digest protection could not be disabled. Absent →
// default; a present array (including []) is honored.
test("config: explicit protectedCategories: [] disables digest protection (PROTECTED_CATEGORIES_EMPTY)", () => {
    const none = resolveMemoryConfig({ memory: { retention: { memory: { protectedCategories: [] } } } }, "/tmp");
    assert.deepEqual(none.retention.memory.protectedCategories, [], "explicit [] must be honored (protection off)");
    const def = resolveMemoryConfig({}, "/tmp");
    assert.deepEqual(def.retention.memory.protectedCategories, ["digest"], "absent must default to ['digest']");
});

test("llm: parseExtractionJSON accepts bare array, code-fenced, and wrapped forms", () => {
    const plain = parseExtractionJSON('[{"content":"A decision","type":"decision","importance":0.9},{"content":"B fact","type":"fact","importance":0.6}]');
    assert.equal(plain.length, 2);
    assert.equal(plain[0].type, "decision");
    assert.equal(plain[0].importance, 0.9);
    assert.equal(plain[1].type, "fact");

    const fenced = parseExtractionJSON('```json\n[{"content":"C","type":"preference","importance":0.4}]\n```');
    assert.equal(fenced.length, 1);
    assert.equal(fenced[0].type, "preference");

    const wrapped = parseExtractionJSON('{"memories":[{"content":"D","type":"other"}]}');
    assert.equal(wrapped.length, 1);
    assert.equal(wrapped[0].importance, 0.65, "missing importance defaults to 0.65");

    const wrappedItems = parseExtractionJSON('{"items":[{"content":"E","type":"fact","importance":1.0}]}');
    assert.equal(wrappedItems.length, 1);
    assert.equal(wrappedItems[0].importance, 1.0);
});

// EXTRACTION_EMPTY_IMPORTANCE (1.6.2): Number("")===0 and Number(null)===0 —
// an empty-string or null importance was silently 0.0 (bottom-ranked, first
// retention candidate) instead of the type default. Now treated as missing.
test("llm: parseExtractionJSON treats empty/null importance as missing (EXTRACTION_EMPTY_IMPORTANCE)", () => {
    const parsed = parseExtractionJSON('[{"content":"A","type":"fact","importance":""},{"content":"B","type":"fact","importance":null},{"content":"C","type":"decision","importance":0.4}]');
    assert.equal(parsed[0].importance, 0.75, "empty-string importance must use the fact default");
    assert.equal(parsed[1].importance, 0.75, "null importance must use the fact default");
    assert.equal(parsed[2].importance, 0.4, "a real numeric importance is preserved");
});

test("llm: parseExtractionJSON rejects garbage, empty lists, and bad types", () => {
    assert.equal(parseExtractionJSON("not json"), null);
    assert.equal(parseExtractionJSON(""), null);
    assert.deepEqual(parseExtractionJSON("[]"), [], "empty list is a valid result");
    assert.equal(parseExtractionJSON("{}"), null);
    assert.equal(parseExtractionJSON('[{"content":"","type":"fact"}]'), null);
    const withBadType = parseExtractionJSON('[{"content":"X","type":"bogus"}]');
    assert.equal(withBadType[0].type, "other");
    const clamped = parseExtractionJSON('[{"content":"X","type":"fact","importance":7}]');
    assert.equal(clamped[0].importance, 1);
});

test("llm: extractAssistantText pulls text parts from an SDK prompt response", () => {
    const response = {
        data: {
            info: {},
            parts: [
                { type: "reasoning", text: "think" },
                { type: "text", text: '[{"content":"A","type":"fact"}]' },
                { type: "text", text: " suffix" },
            ],
        },
    };
    assert.equal(extractAssistantText(response), '[{"content":"A","type":"fact"}]\n suffix');
    assert.equal(extractAssistantText({ data: { parts: [] } }), "");
});

test("llm: requestLLMCapture round-trips through an ephemeral session and parses", async () => {
    const calls = { created: 0, prompted: 0, deleted: 0 };
    const fakeClient = {
        session: {
            create: async (opts) => {
                calls.created += 1;
                assert.equal(opts.body.title, "opencode-memory-pro memory-capture");
                return { data: { id: "ephemeral-1" } };
            },
            prompt: async (opts) => {
                calls.prompted += 1;
                assert.equal(opts.path.id, "ephemeral-1");
                assert.equal(opts.body.model.providerID, "openrouter");
                assert.equal(opts.body.model.modelID, "z-ai/glm-5.3-flash");
                assert.ok(typeof opts.body.system === "string");
                return { data: { info: {}, parts: [{ type: "text", text: '[{"content":"We use Go","type":"preference","importance":0.8}]' }] } };
            },
            delete: async (opts) => {
                calls.deleted += 1;
                assert.equal(opts.path.id, "ephemeral-1");
            },
        },
    };
    const cfg = { provider: "openrouter", model: "z-ai/glm-5.3-flash" };
    const result = await requestLLMCapture(fakeClient, cfg, "User prefers Go for new services.", "sess-1");
    assert.equal(result.length, 1);
    assert.equal(result[0].content, "We use Go");
    assert.equal(result[0].type, "preference");
    assert.equal(calls.created, 1);
    assert.equal(calls.prompted, 1);
    assert.equal(calls.deleted, 1, "ephemeral session must be cleaned up");
    assert.equal(isOwnSession("ephemeral-1"), true, "plugin's own session must be excluded from event feedback");
});

test("llm: requestLLMCapture returns null (no throw) on provider failure and still deletes", async () => {
    const fakeClient = {
        session: {
            create: async () => ({ data: { id: "ephemeral-2" } }),
            prompt: async () => { throw new Error("provider offline"); },
            delete: async () => { },
        },
    };
    const result = await requestLLMCapture(fakeClient, { provider: "openrouter", model: "z-ai/glm-5.3-flash" }, "some text", "sess-2");
    assert.equal(result, null);
});

test("llm: requestLLMCapture returns null without client/config/session methods", async () => {
    assert.equal(await requestLLMCapture(null, { provider: "openrouter", model: "z-ai/glm-5.3-flash" }, "text", "s"), null);
    assert.equal(await requestLLMCapture({ session: {} }, null, "text", "s"), null);
    assert.equal(await requestLLMCapture({ session: { create: async () => ({}), prompt: async () => ({}), delete: async () => ({}) } }, { provider: "openrouter", model: "z-ai/glm-5.3-flash" }, "   ", "s"), null, "blank transcript");
});

test("llm: requestLLMCapture returns [] (not null) when model emits an empty JSON list", async () => {
    const fakeClient = {
        session: {
            create: async () => ({ data: { id: "ephemeral-empty" } }),
            prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "[]" }] } }),
            delete: async () => { },
        },
    };
    const result = await requestLLMCapture(fakeClient, { provider: "openrouter", model: "z-ai/glm-5.3-flash" }, "some text", "sess-empty");
    assert.deepEqual(result, [], "empty extraction is a valid result, not a failure");
});

// CAPTURE_TAIL_KEEP (1.4.9): over-cap transcripts must keep the TAIL (freshest
// context), not the head. Mutant: reverting to .slice(0, MAX) fails this.
test("llm: truncateCaptureInput keeps the tail when the transcript exceeds the cap", () => {
    const over = "x".repeat(60000) + "FRESH-DECISION";
    const cut = truncateCaptureInput(over);
    assert.equal(cut.length, 60000);
    assert.equal(cut, over.slice(-60000), "exact tail must be kept (mutant: .slice(0, MAX) keeps the head)");
    assert.ok(cut.endsWith("FRESH-DECISION"), "the newest content must survive truncation");
    const short = "short transcript";
    assert.equal(truncateCaptureInput(short), short, "under-cap input passes through unchanged");
});

// CAPTURE_NO_REASONING (1.4.9): live flushes burned reasoning=638-1173 tokens
// (llm.prompt p50=20s); the SDK prompt body has no reasoning knob, so the
// capture system prompt must explicitly forbid step-by-step thinking. Mutant:
// removing the directive fails this.
test("llm: capture system prompt forbids step-by-step reasoning", async () => {
    let receivedSystem = null;
    const fakeClient = {
        session: {
            create: async () => ({ data: { id: "ephemeral-noreason" } }),
            prompt: async (opts) => {
                receivedSystem = opts.body.system;
                return { data: { info: {}, parts: [{ type: "text", text: "[]" }] } };
            },
            delete: async () => { },
        },
    };
    await requestLLMCapture(fakeClient, { provider: "openrouter", model: "z-ai/glm-5.3-flash" }, "some text", "sess-noreason");
    assert.ok(/reason step-by-step|any thinking/i.test(receivedSystem), "system prompt must suppress chain-of-thought");
    assert.ok(receivedSystem.includes("only the JSON array"), "system prompt must demand direct output");
});

test("llm: requestLLMDigest strips fences/commentary and returns text + sourceCount", async () => {
    const fakeClient = {
        session: {
            create: async () => ({ data: { id: "ephemeral-3" } }),
            prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "Decisions: Go for services; sqlite for local caches." }] } }),
            delete: async () => { },
        },
    };
    const result = await requestLLMDigest(fakeClient, { provider: "openrouter", model: "z-ai/glm-5.3-flash" }, ["mem one", "mem two", "mem three"], 300, "decisions");
    assert.equal(result.sourceCount, 3);
    assert.ok(result.text.includes("Go for services"));
    assert.equal(result.text, "Decisions: Go for services; sqlite for local caches.");
});

// PROMPT_USAGE_LOG (1.4.8): session.prompt usage must be logged so llm.prompt
// latency can be attributed (reasoning tokens vs output vs input). Mutant:
// removing the usage-logging block emits no line and this test fails.
test("llm: session.prompt token usage is logged for latency attribution", async () => {
    const originalInfo = console.info;
    const captured = [];
    console.info = (...args) => captured.push(args.map(String).join(" "));
    try {
        const fakeClient = {
            session: {
                create: async () => ({ data: { id: "ephemeral-usage" } }),
                prompt: async () => ({
                    data: {
                        info: { tokens: { input: 2431, output: 187, reasoning: 4096, cache: { read: 512, write: 0 } } },
                        parts: [{ type: "text", text: "[]" }],
                    },
                }),
                delete: async () => { },
            },
        };
        const result = await requestLLMCapture(fakeClient, { provider: "crof", model: "glm-5.3-flash" }, "some text", "sess-usage");
        assert.deepEqual(result, [], "the call itself still succeeds");
    }
    finally {
        console.info = originalInfo;
    }
    const usageLine = captured.find((line) => line.includes("[llm]") && line.includes("usage"));
    assert.ok(usageLine, "a usage log line must be emitted for llm.prompt calls");
    assert.ok(usageLine.includes("in=2431"), `usage line must include input tokens: ${usageLine}`);
    assert.ok(usageLine.includes("out=187"), `usage line must include output tokens: ${usageLine}`);
    assert.ok(usageLine.includes("reasoning=4096"), `usage line must include reasoning tokens: ${usageLine}`);
    assert.ok(usageLine.includes("cacheRead=512"), `usage line must include cache reads: ${usageLine}`);
    assert.ok(usageLine.includes("provider=crof"), `usage line must name the provider: ${usageLine}`);
});

test("llm: no usage line when the response carries no token info", async () => {
    const originalInfo = console.info;
    const captured = [];
    console.info = (...args) => captured.push(args.map(String).join(" "));
    try {
        const fakeClient = {
            session: {
                create: async () => ({ data: { id: "ephemeral-nousage" } }),
                prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: "[]" }] } }),
                delete: async () => { },
            },
        };
        await requestLLMCapture(fakeClient, { provider: "crof", model: "glm-5.3-flash" }, "some text", "sess-nousage");
    }
    finally {
        console.info = originalInfo;
    }
    assert.equal(captured.find((line) => line.includes("usage")), undefined, "missing token info must not fabricate a usage line");
});

// NO_TEXT_RETRY (1.6.1): flash-tier providers under load resolve session.prompt
// with an empty parts array — the silent-empty case must retry on the SAME
// ephemeral session (create/delete stay 1:1), then fall back to null only after
// NO_TEXT_RETRY (1.6.1) + RETRY_SESSION_PER_ATTEMPT (1.6.2): the no-text
// retry loop must retry on a FRESH session per attempt (same-session reuse
// multiplied the transcript × attempts, blowing small context windows),
// while thrown errors and create failures are still NOT retried. Mutants:
// returning null on first empty reply (prompted stays 1), reverting to
// same-session reuse (created stays 1), or retrying throws (prompted > 1)
// each fail their tests.
test("llm: no-text reply retries on a fresh session and succeeds on a later attempt", async () => {
    setLlmRetryPolicy({ maxAttempts: 3, initialDelayMs: 0, backoffMultiplier: 1 });
    try {
        const calls = { created: 0, prompted: 0, deleted: 0 };
        const fakeClient = {
            session: {
                create: async () => {
                    calls.created += 1;
                    return { data: { id: `ephemeral-notext-${calls.created}` } };
                },
                prompt: async () => {
                    calls.prompted += 1;
                    if (calls.prompted === 1)
                        return { data: { info: {}, parts: [] } };
                    return { data: { info: {}, parts: [{ type: "text", text: '[{"content":"Go for services","type":"decision","importance":0.9}]' }] } };
                },
                delete: async () => {
                    calls.deleted += 1;
                },
            },
        };
        const result = await requestLLMCapture(fakeClient, { provider: "openrouter", model: "z-ai/glm-5.3-flash" }, "User decided.", "sess-notext");
        assert.equal(result.length, 1, "retried prompt must produce memories");
        assert.equal(result[0].content, "Go for services");
        assert.equal(calls.prompted, 2, "first empty reply must be retried");
        assert.equal(calls.created, 2, "each attempt must run in a fresh session (transcript must not multiply)");
        assert.equal(calls.deleted, 2, "every ephemeral session must still be cleaned up");
        assert.ok(isOwnSession("ephemeral-notext-2"), "the final attempt's session is tracked as own");
    }
    finally {
        resetLlmRetryPolicy();
    }
});

test("llm: no-text reply exhausts retries then falls back to null", async () => {
    setLlmRetryPolicy({ maxAttempts: 3, initialDelayMs: 0, backoffMultiplier: 1 });
    try {
        const calls = { created: 0, prompted: 0, deleted: 0 };
        const fakeClient = {
            session: {
                create: async () => {
                    calls.created += 1;
                    return { data: { id: "ephemeral-alwaysempty" } };
                },
                prompt: async () => {
                    calls.prompted += 1;
                    return { data: { info: {}, parts: [] } };
                },
                delete: async () => {
                    calls.deleted += 1;
                },
            },
        };
        const result = await requestLLMCapture(fakeClient, { provider: "openrouter", model: "z-ai/glm-5.3-flash" }, "some text", "sess-alwaysempty");
        assert.equal(result, null, "exhausted attempts must fall back to heuristics");
        assert.equal(calls.prompted, 3, "attempt budget must be fully spent before giving up");
        assert.equal(calls.created, 3, "one fresh session per attempt, even on exhaustion");
        assert.equal(calls.deleted, 3);
    }
    finally {
        resetLlmRetryPolicy();
    }
});

// NO_TEXT_RETRY (1.6.1) scope guard: thrown errors (provider offline, timeout)
// must NOT be retried — only the silent-empty success case is. Mutant: moving
// the retry loop to wrap the whole prompt (throw path) makes prompted > 1.
test("llm: thrown prompt errors skip retries and still clean up", async () => {
    setLlmRetryPolicy({ maxAttempts: 3, initialDelayMs: 0, backoffMultiplier: 1 });
    try {
        const calls = { created: 0, prompted: 0, deleted: 0 };
        const fakeClient = {
            session: {
                create: async () => {
                    calls.created += 1;
                    return { data: { id: "ephemeral-throw" } };
                },
                prompt: async () => {
                    calls.prompted += 1;
                    throw new Error("provider offline");
                },
                delete: async () => {
                    calls.deleted += 1;
                },
            },
        };
        const result = await requestLLMCapture(fakeClient, { provider: "openrouter", model: "z-ai/glm-5.3-flash" }, "some text", "sess-throw");
        assert.equal(result, null);
        assert.equal(calls.prompted, 1, "thrown errors must not be retried");
        assert.equal(calls.deleted, 1, "cleanup must still run");
    }
    finally {
        resetLlmRetryPolicy();
    }
});

test("llm: retry policy defaults are bounded and env-overridable", () => {
    const policy = getLlmRetryPolicy();
    assert.ok(policy.maxAttempts >= 1 && policy.maxAttempts <= 10, "maxAttempts must be clamped");
    assert.ok(policy.initialDelayMs >= 0 && policy.initialDelayMs <= 60000, "initialDelayMs must be clamped");
    assert.ok(policy.backoffMultiplier >= 1, "backoff must be non-decreasing");
});

// RETRY_BACKOFF_CLAMP (1.6.1): backoffMultiplier was read with plain toNumber
// (no clamp) while its siblings were clamped — a large multiplier with
// maxAttempts=10 overflows setTimeout's 2^31-1ms clamp (~24.8 days/attempt),
// hanging the capture flush. resetLlmRetryPolicy re-reads env at call time,
// so the clamp is testable through the seam.
test("llm: backoffMultiplier is clamped to [1,10] from env (RETRY_BACKOFF_CLAMP)", () => {
    const prev = process.env.OPENCODE_MEMORY_PRO_LLM_RETRY_BACKOFF_MULTIPLIER;
    try {
        process.env.OPENCODE_MEMORY_PRO_LLM_RETRY_BACKOFF_MULTIPLIER = "100";
        resetLlmRetryPolicy();
        assert.equal(getLlmRetryPolicy().backoffMultiplier, 10, "huge multiplier must clamp to 10");
        process.env.OPENCODE_MEMORY_PRO_LLM_RETRY_BACKOFF_MULTIPLIER = "0.5";
        resetLlmRetryPolicy();
        assert.equal(getLlmRetryPolicy().backoffMultiplier, 1, "sub-1 multiplier must clamp to 1");
        process.env.OPENCODE_MEMORY_PRO_LLM_RETRY_BACKOFF_MULTIPLIER = "bogus";
        resetLlmRetryPolicy();
        assert.equal(getLlmRetryPolicy().backoffMultiplier, 2, "non-numeric multiplier falls back to default 2");
        process.env.OPENCODE_MEMORY_PRO_LLM_RETRY_BACKOFF_MULTIPLIER = "3.5";
        resetLlmRetryPolicy();
        assert.equal(getLlmRetryPolicy().backoffMultiplier, 3.5, "in-range fractional multiplier is preserved");
    }
    finally {
        if (prev === undefined)
            delete process.env.OPENCODE_MEMORY_PRO_LLM_RETRY_BACKOFF_MULTIPLIER;
        else
            process.env.OPENCODE_MEMORY_PRO_LLM_RETRY_BACKOFF_MULTIPLIER = prev;
        resetLlmRetryPolicy();
    }
});

// SET_RETRY_POLICY_CLAMP (1.6.2): setLlmRetryPolicy used a raw
// Object.assign, bypassing every clamp — maxAttempts: Infinity → unbounded
// retry loop, 0 → immediate failure. The seam now applies the same bounds
// as resetLlmRetryPolicy/env read use.
test("llm: setLlmRetryPolicy clamps out-of-bounds patches (SET_RETRY_POLICY_CLAMP)", () => {
    try {
        setLlmRetryPolicy({ maxAttempts: Infinity, initialDelayMs: -50, backoffMultiplier: 100 });
        let policy = getLlmRetryPolicy();
        assert.ok(Number.isFinite(policy.maxAttempts) && policy.maxAttempts >= 1 && policy.maxAttempts <= 10, "Infinity maxAttempts must clamp to the [1,10] bound");
        assert.ok(policy.initialDelayMs >= 0 && policy.initialDelayMs <= 60000, "negative initialDelayMs must clamp to 0");
        assert.ok(policy.backoffMultiplier >= 1 && policy.backoffMultiplier <= 10, "huge multiplier must clamp to 10");
        setLlmRetryPolicy({ maxAttempts: 0, backoffMultiplier: 0.1 });
        policy = getLlmRetryPolicy();
        assert.equal(policy.maxAttempts, 1, "maxAttempts 0 must clamp to 1");
        assert.equal(policy.backoffMultiplier, 1, "sub-1 multiplier must clamp to 1");
        setLlmRetryPolicy({ maxAttempts: "bogus" });
        assert.equal(getLlmRetryPolicy().maxAttempts, 3, "non-numeric maxAttempts falls back to the default 3");
    }
    finally {
        resetLlmRetryPolicy();
    }
});

test("extractiveDigest: builds header, picks high-scoring sentences, respects budget", () => {
    const short = "Hi there.";
    const texts = [
        "The memory plugin shipped a new entity graph with typed relations and offline extraction.",
        "Retention sweeps roll old unused memories into per-category digests and never delete them.",
        "The graph boost improves recall scores using co-occurrence between entities.",
        "Dedup consolidation now runs automatically on session idle events.",
        short,
    ];
    const digest = extractiveDigest(texts, 500, ["plugin", "graph", "memory"]);
    assert.ok(digest);
    assert.ok(digest.text.startsWith("SUMMARY"));
    assert.ok(digest.text.includes("5 memories"));
    assert.ok(digest.sentenceCount >= 1);
    assert.ok(digest.text.length <= 520, `digest too long: ${digest.text.length}`);
    assert.ok(!digest.text.includes(short), "short filler sentence should be skipped");
});

test("extractiveDigest: empty input returns null; fallback for unfittable texts", () => {
    assert.equal(extractiveDigest([]), null);
    assert.equal(extractiveDigest(["", "   "]), null);
});

test("retentionCandidates: guards status/category/age/use/importance/pinned", () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const base = {
        status: "active",
        category: "fact",
        importance: 0.5,
        timestamp: now - 250 * DAY,
        lastRecalled: now - 90 * DAY,
        metadataJson: "{}",
    };
    const eligible = retentionCandidates([{ ...base }], { minAgeDays: 180, unusedDays: 60 });
    assert.equal(eligible.length, 1);

    const cases = [
        { ...base, status: "digested" },
        { ...base, category: "digest" },
        { ...base, timestamp: now - 30 * DAY },
        { ...base, lastRecalled: now - 10 * DAY },
        { ...base, importance: 0.1 },
        { ...base, metadataJson: '{"pinned":true}' },
        { ...base, timestamp: 0 },
    ];
    for (const c of cases) {
        assert.equal(retentionCandidates([c], { minAgeDays: 180, unusedDays: 60, minImportance: 0.3 }).length, 0, JSON.stringify(c));
    }
});

test("retentionCandidates: never-recalled old memories are expirable", () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const rec = {
        status: "active",
        category: "other",
        importance: 0.4,
        timestamp: now - 300 * DAY,
        lastRecalled: 0,
        metadataJson: "{}",
    };
    assert.equal(retentionCandidates([rec], { minAgeDays: 180, unusedDays: 60 }).length, 1);
});

test("expiredDigestCandidates: only old active digests are expirable", () => {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const oldDigest = {
        id: "d-old",
        status: undefined,
        category: "digest",
        timestamp: now - 400 * DAY,
        metadataJson: "{}",
    };
    assert.equal(expiredDigestCandidates([oldDigest], 365).length, 1, "400-day digest is expirable");

    const cases = [
        { ...oldDigest, timestamp: now - 30 * DAY },
        { ...oldDigest, status: "digested" },
        { ...oldDigest, category: "fact" },
        { ...oldDigest, timestamp: 0 },
        { ...oldDigest, metadataJson: '{"pinned":true}' },
    ];
    for (const c of cases) {
        assert.equal(expiredDigestCandidates([c], 365).length, 0, JSON.stringify(c));
    }
});

test("storeFastCosine: basic similarity math", () => {
    assert.equal(storeFastCosine([1, 0], [1, 0], 1, 1), 1);
    assert.equal(storeFastCosine([1, 0], [0, 1], 1, 1), 0);
    assert.equal(storeFastCosine([], [1], 0, 1), 0);
});

test("graph: extractEntities finds identifiers and known keywords", () => {
    const entities = extractEntities("fixes config.js and the opencode plugin graph store").map((e) => e.name);
    assert.ok(entities.length >= 1);
    const joined = entities.join(" ");
    assert.ok(/opencode/.test(joined), `expected opencode keyword, got: ${joined}`);
});

test("graph: extractTypedRelations emits directional relations", () => {
    const text = "The plugin uses the graph store to boost recall.";
    const entities = extractEntities(text).map((e) => e.name).slice(0, 6);
    const rels = extractTypedRelations(text, entities.length ? entities : ["plugin", "graph", "store"]);
    assert.ok(Array.isArray(rels));
    if (rels.length > 0) {
        for (const r of rels) {
            assert.ok(r.relation, "relation must have a relation type");
            assert.ok(r.src && r.dst, "relation must have src/dst");
        }
    }
});

test("config: mergeMemoryConfig deep-merges retention/summarize/logging fragments", () => {
    const merged = mergeMemoryConfig(
        {
            retention: { effectivenessEventsDays: 45, memory: { enabled: true, minAgeDays: 120 }, scoring: { importanceWeight: 0.4, feedbackWeight: 0.3 } },
            summarize: { targetChars: 777 },
            logging: { level: "error" },
        },
        {
            retention: { memory: { enabled: false }, scoring: { importanceWeight: 1.5 } },
            summarize: { minGroupSize: 9 },
        },
    );
    assert.equal(merged.retention.effectivenessEventsDays, 45, "fragment must not drop legacy retention scalar");
    assert.equal(merged.retention.memory.enabled, false, "fragment override wins");
    assert.equal(merged.retention.memory.minAgeDays, 120, "fragment must not drop legacy retention.memory sub-key");
    assert.equal(merged.retention.scoring.importanceWeight, 1.5, "fragment override wins for scoring");
    assert.equal(merged.retention.scoring.feedbackWeight, 0.3, "fragment must not drop unset scoring keys");
    assert.equal(merged.summarize.targetChars, 777, "fragment must not drop legacy summarize scalar");
    assert.equal(merged.summarize.minGroupSize, 9, "fragment override wins");
    assert.equal(merged.logging.level, "error", "fragment must not drop legacy logging");
    assert.equal(merged.graph.enabled, undefined, "absent sections stay absent");
});

test("graph: GraphStore round-trip (index → boost → expand → remove)", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { GraphStore, DisabledGraphStore } = await import("../dist/graph.js");
    assert.equal(DisabledGraphStore !== undefined, true, "DisabledGraphStore export intact");
    const dir = mkdtempSync(join(tmpdir(), "graph-test-"));
    const store = new GraphStore({
        dbPath: join(dir, "graph.db"),
        maxEntitiesPerMemory: 20,
        maxEdgeProvenance: 20,
        typedEdges: true,
    }, { ctor: DatabaseSync, name: "node:sqlite" });
    const ts = Date.now();
    store.indexMemory("m1", "the plugin uses docker and postgres; config.js defines the api route", ts);
    const boosted = store.boostResults("plugin uses postgres", [{ record: { id: "m1" }, score: 1 }], 0.3);
    assert.ok(boosted.length === 1 && boosted[0].score > 1, `expected boosted score > 1, got ${boosted[0]?.score}`);
    assert.ok(boosted[0].graphBoost > 1 && boosted[0].graphOverlap >= 1, "expected graphBoost/overlap metadata");
    const expanded = store.expandRecall("docker", { maxHops: 2, expansionLimit: 5, expansionLambda: 0.3 });
    assert.ok(expanded.some((c) => c.memoryId === "m1"), `expected m1 reachable from docker, got ${JSON.stringify(expanded)}`);
    const mapped = store.getMemoryEntities(["m1", undefined, "", null, "m2"]);
    assert.ok(mapped instanceof Map && mapped.has("m1"), "falsy ids must be filtered without throwing");
    store.onMemoryRemoved("m1");
    const stats = store.stats();
    assert.equal(stats.memoryMappings, 0, "removal must clear memory_entities");
    assert.equal(stats.edges, 0, "removal must clear orphaned edges");
    store.db.close();
});

// QUERY_ENTITY_MEMO (perf review): getEntitiesForQuery memoizes the last
// query's extracted entities (boostResults/expandRecall are both called
// once per recall turn with the same query string in index.js, and
// previously each re-ran the full extraction pass independently). Verify
// the memo actually reuses the array for a repeated query (identity check)
// and correctly recomputes (distinct array, distinct content) for a
// different query — i.e. it's a real cache, not an always-hit stub.
test("graph: getEntitiesForQuery memoizes the last query only (QUERY_ENTITY_MEMO)", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { GraphStore } = await import("../dist/graph.js");
    const dir = mkdtempSync(join(tmpdir(), "graph-memo-"));
    const store = new GraphStore({
        dbPath: join(dir, "graph.db"),
        maxEntitiesPerMemory: 20,
        maxEdgeProvenance: 20,
        typedEdges: true,
    }, { ctor: DatabaseSync, name: "node:sqlite" });
    try {
        const first = store.getEntitiesForQuery("the plugin uses docker and postgres");
        const second = store.getEntitiesForQuery("the plugin uses docker and postgres");
        assert.equal(first, second, "repeated query must return the exact same cached array (memo hit)");
        const third = store.getEntitiesForQuery("a completely different sentence about kubernetes");
        assert.notEqual(third, first, "a different query must not reuse the previous query's cached array");
        assert.ok(third.some((e) => e.name === "kubernetes"), "recomputed entities must reflect the new query's content");
        // Re-querying the FIRST string again after the memo moved on to a
        // different query must recompute (size-1 memo, not an unbounded
        // cache) rather than returning a now-stale reference equal to `third`.
        const fourth = store.getEntitiesForQuery("the plugin uses docker and postgres");
        assert.notEqual(fourth, third, "the memo must not conflate two different queries");
        assert.deepEqual(fourth, first, "content must match even though it's a freshly recomputed array");
    }
    finally {
        store.db.close();
    }
});

test("graph: DisabledGraphStore is a safe no-op", async () => {
    const { DisabledGraphStore } = await import("../dist/graph.js");
    const g = new DisabledGraphStore();
    assert.equal(g.enabled, false);
    assert.deepEqual(g.boostResults("query", [{ record: { id: "x" }, score: 1 }]), [{ record: { id: "x" }, score: 1 }]);
    assert.equal(g.expandRecall("query").length, 0);
    assert.deepEqual(g.stats().relations, {});
});

test("graph: expandRecall ranks fresh edges above stale ones (recency decay)", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { GraphStore } = await import("../dist/graph.js");
    const dir = mkdtempSync(join(tmpdir(), "graph-decay-"));
    const store = new GraphStore({
        dbPath: join(dir, "graph.db"),
        maxEntitiesPerMemory: 20,
        maxEdgeProvenance: 20,
        typedEdges: true,
    }, { ctor: DatabaseSync, name: "node:sqlite" });
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    // Two disjoint 1-hop clusters: m1's postgres edge is 1 day old, m2's
    // mysql edge is ~400 days old. Both are weight-1 co-occurrence hops from
    // the query seed, so identical shape — only recency differs.
    store.indexMemory("m1", "the plugin uses docker and postgres", now - DAY);
    store.indexMemory("m2", "the helm chart uses mysql and redis", now - 400 * DAY);
    const expanded = store.expandRecall("postgres mysql", { maxHops: 2, expansionLimit: 10, expansionLambda: 0.3 });
    assert.ok(Array.isArray(expanded) && expanded.length >= 2, `expected both clusters, got ${JSON.stringify(expanded)}`);
    const byId = new Map(expanded.map((c) => [c.memoryId, c]));
    assert.ok(byId.has("m1") && byId.has("m2"), "both memories reachable in one hop");
    assert.ok(byId.get("m1").scoreFactor > byId.get("m2").scoreFactor,
        `fresh edge must outrank stale edge: m1=${byId.get("m1").scoreFactor} m2=${byId.get("m2").scoreFactor}`);
    store.db.close();
});

function makeGraphStore(dir) {
    return import("../dist/graph.js").then(async ({ GraphStore }) => {
        const { DatabaseSync } = await import("node:sqlite");
        const { mkdtempSync } = await import("node:fs");
        const { tmpdir } = await import("node:os");
        const { join } = await import("node:path");
        return new GraphStore({
            dbPath: join(mkdtempSync(join(tmpdir(), dir)), "graph.db"),
            maxEntitiesPerMemory: 20,
            maxEdgeProvenance: 20,
            typedEdges: true,
        }, { ctor: DatabaseSync, name: "node:sqlite" });
    });
}

// MERGE_ENTITY_GC (1.4.5): onMemoryMerged must decrement mention_count for
// the links that COLLAPSE (entity mentioned by both memories) and GC entities
// that hit zero — mirroring onMemoryRemoved. Moved links (entity only on the
// older memory) keep their count. Pre-fix the duplicate kept its count, so
// removing the surviving memory left the entity at 1 with zero references,
// leaking forever.
test("graph: onMemoryMerged decrements collapsed entity counts and GCs on later removal (MERGE_ENTITY_GC)", async () => {
    const store = await makeGraphStore("graph-merge-gc-");
    try {
        const ts = Date.now();
        store.indexMemory("m-old", "the plugin uses docker and postgres", ts);
        store.indexMemory("m-new", "the plugin uses docker and redis", ts + 1);
        // Pre-merge: docker is referenced by both memories.
        assert.equal(store.db.prepare("SELECT mention_count FROM entities WHERE name = 'docker'").get().mention_count, 2);
        store.onMemoryMerged("m-old", "m-new");
        // The duplicate (docker) collapses: count drops 2 → 1. The moved
        // link (postgres) keeps its count; it now points at m-new.
        assert.equal(store.db.prepare("SELECT mention_count FROM entities WHERE name = 'docker'").get().mention_count, 1,
            "collapsed duplicate must decrement exactly once");
        assert.equal(store.db.prepare("SELECT mention_count FROM entities WHERE name = 'postgres'").get().mention_count, 1,
            "moved link must keep its count");
        assert.equal(store.stats().memoryMappings, 4, "m-new now carries docker, redis + moved postgres/plugin");
        // Removing the survivor must GC every entity: pre-fix docker sat at
        // 2 after the merge, so this removal left it at 1 forever.
        store.onMemoryRemoved("m-new");
        assert.equal(store.stats().entities, 0, "no entity may survive the survivor's removal");
        assert.equal(store.stats().memoryMappings, 0);
    }
    finally {
        store.db.close();
    }
});

// REINDEX_BACKFILL_HEAL (1.6.2): reindexMemories used to return early when
// ANY memory_entities row existed — a crash mid-backfill left a partial
// graph with no recovery. indexMemory is idempotent (REINDEX_COUNT_IDEMPOTENT),
// so re-running over all active memories heals partial graphs.
test("graph: reindexMemories heals a partial graph despite existing entities (REINDEX_BACKFILL_HEAL)", async () => {
    const store = await makeGraphStore("graph-rebackfill-");
    try {
        const ts = Date.now();
        store.indexMemory("existing", "the plugin uses docker", ts);
        // Simulate a crash mid-backfill: "postgres" memory was never indexed.
        const missing = { id: "missed", text: "the plugin also uses postgres", timestamp: ts + 1 };
        store.reindexMemories([missing]);
        assert.equal(store.db.prepare("SELECT mention_count FROM entities WHERE name = 'postgres'").get().mention_count, 1,
            "previously-missed memory must be indexed on re-run");
        assert.equal(store.db.prepare("SELECT mention_count FROM entities WHERE name = 'docker'").get().mention_count, 1,
            "re-running must not inflate existing counts (idempotent)");
        // Re-running again is still safe.
        store.reindexMemories([missing]);
        assert.equal(store.db.prepare("SELECT mention_count FROM entities WHERE name = 'postgres'").get().mention_count, 1);
    }
    finally {
        store.db.close();
    }
});

// ENTITY_GC_EDGE_CLEANUP (1.6.2): GC deleted the entity ROW but left its
// edges → BFS traversed dead entities as intermediates (stale-noise
// expansion). The provenance-based edge cleanup only removes edges tied to
// the removed memory; a STRAY edge (desynced state, e.g. manual DB surgery
// or a pre-1.4.5 write) survives and keeps pointing at a GC'd entity. A
// zero-count entity's edges must go with the row.
test("graph: entity GC removes the entity's edges with the row (ENTITY_GC_EDGE_CLEANUP)", async () => {
    const store = await makeGraphStore("graph-edgegc-");
    try {
        const ts = Date.now();
        store.indexMemory("m1", "the plugin uses docker and postgres", ts);
        // Seed a stray edge to docker NOT tied to m1's provenance — the
        // provenance cleanup can't see it, only the entity GC can.
        store.upsertEdge("docker", "ghost", "co_occurs", "stray-memory", ts);
        const strayBefore = store.db.prepare("SELECT COUNT(*) AS c FROM edges WHERE (src = 'docker' AND dst = 'ghost') OR (src = 'ghost' AND dst = 'docker')").get().c;
        assert.equal(strayBefore, 1, "sanity: stray edge exists");
        store.onMemoryRemoved("m1");
        assert.equal(store.stats().entities, 0, "all entities GC'd");
        const dockerEdges = store.db.prepare("SELECT COUNT(*) AS c FROM edges WHERE (src = 'docker' AND dst = 'ghost') OR (src = 'ghost' AND dst = 'docker')").get().c;
        assert.equal(dockerEdges, 0, "no edge may reference a GC'd entity (BFS must never see dead intermediates)");
    }
    finally {
        store.db.close();
    }
});

// REINDEX_ENTITY_HEAL (1.6.2): when a memory_entities link exists but the
// entities row is missing (pre-1.4.5 desync), re-index used to INSERT with
// mention_count=0 — a ghost entity GC (decrement-only) could never collect.
// A live link means the count is at least 1: heal with 1.
test("graph: re-index heals a missing entity row with count 1, not 0 (REINDEX_ENTITY_HEAL)", async () => {
    const store = await makeGraphStore("graph-entityheal-");
    try {
        const ts = Date.now();
        store.indexMemory("m1", "the plugin uses docker", ts);
        // Simulate pre-1.4.5 desync: drop the entity row, keep the link.
        store.db.prepare("DELETE FROM entities WHERE name = 'docker'").run();
        const mapCount = store.db.prepare("SELECT COUNT(*) AS c FROM memory_entities WHERE entity_name = 'docker'").get().c;
        assert.equal(mapCount, 1, "desync: link still exists");
        store.indexMemory("m1", "the plugin uses docker", ts + 1000);
        const row = store.db.prepare("SELECT mention_count FROM entities WHERE name = 'docker'").get();
        assert.ok(row, "entity row must be recreated on re-index");
        assert.equal(row.mention_count, 1, "a live link means count 1 — no count-0 ghost");
        // Removing the memory still GCs it entirely.
        store.onMemoryRemoved("m1");
        assert.equal(store.stats().entities, 0, "healed entity must be collectable");
        assert.equal(store.db.prepare("SELECT COUNT(*) AS c FROM edges").get().c, 0, "edges cleaned with the row");
    }
    finally {
        store.db.close();
    }
});

// REINDEX_COUNT_IDEMPOTENT (1.4.5): re-indexing the same memory must not
// inflate mention_count — memory_entities is INSERT OR IGNORE, so the extra
// increment had no matching link and blocked GC after onMemoryRemoved.
test("graph: indexMemory re-index keeps mention_count in sync with links (REINDEX_COUNT_IDEMPOTENT)", async () => {
    const store = await makeGraphStore("graph-reindex-");
    try {
        const ts = Date.now();
        store.indexMemory("m1", "the plugin uses docker and postgres", ts);
        assert.equal(store.db.prepare("SELECT mention_count FROM entities WHERE name = 'docker'").get().mention_count, 1);
        // Re-index the SAME memory (update/re-embed/backfill shape).
        store.indexMemory("m1", "the plugin uses docker and postgres", ts + 1000);
        assert.equal(store.db.prepare("SELECT mention_count FROM entities WHERE name = 'docker'").get().mention_count, 1,
            "re-index must not double-count");
        // A genuinely new memory still bumps the count.
        store.indexMemory("m2", "the plugin uses docker", ts + 2000);
        assert.equal(store.db.prepare("SELECT mention_count FROM entities WHERE name = 'docker'").get().mention_count, 2);
        // Removal unwinds exactly: both memories gone → count 0 → GC.
        store.onMemoryRemoved("m1");
        assert.equal(store.db.prepare("SELECT mention_count FROM entities WHERE name = 'docker'").get().mention_count, 1);
        store.onMemoryRemoved("m2");
        assert.equal(store.stats().entities, 0, "entity must be GC'd once all references are gone");
    }
    finally {
        store.db.close();
    }
});

test("utils: classifyFailure buckets error messages", async () => {
    const { classifyFailure } = await import("../dist/utils.js");
    assert.equal(classifyFailure("SyntaxError: Unexpected token '}'"), "syntax");
    assert.equal(classifyFailure("TypeError: cannot read properties of undefined"), "runtime");
    assert.equal(classifyFailure("ECONNREFUSED to 127.0.0.1:8080"), "resource");
    assert.equal(classifyFailure("some totally unique message"), "unknown");
});

// VALIDATION_ZERO_COUNT (1.6.2): parseValidationOutput chained its two
// error-count extractors with `||`; extractCount returns 0 for a zero count,
// and 0 is falsy, so "0 errors" WITHOUT a "Found" prefix fell through to the
// hasError(/error|fail/i) fallback — "errors" matched → a clean type-check
// was misclassified as FAIL. `??` preserves the parsed 0 → pass.
test("utils: parseValidationOutput treats a clean count of 0 as pass (VALIDATION_ZERO_COUNT)", async () => {
    const { parseValidationOutput } = await import("../dist/utils.js");
    assert.deepEqual(parseValidationOutput("0 errors", "type-check"), { status: "pass", errorCount: 0, errorTypes: [] });
    assert.equal(parseValidationOutput("Found 0 errors", "type-check").status, "pass");
    assert.equal(parseValidationOutput("Found 3 errors", "type-check").status, "fail");
    assert.equal(parseValidationOutput("error TS2322: Type 'string' is not assignable", "type-check").status, "fail");
});

// VALIDATION_OUTCOME_CASE (1.6.2): detectValidationOutcome's failure-signal
// regex was case-sensitive — real tsc output "found 1 error" (lowercase,
// when metadata.exit is absent) never matched, so the failure was recorded
// as pass. /i now catches lowercase signals while the \b0 (failing|failed|
// errors?) zero-count guard stays intact (Error\b still can't match
// "errors" — word boundary), so clean zero-count output stays pass.
test("capture: detectValidationOutcome catches lowercase failure signals (VALIDATION_OUTCOME_CASE)", () => {
    const base = { metadata: {}, output: undefined };
    const tsc = "npx tsc --noEmit";
    const failed = detectValidationOutcome(tsc, { ...base, output: "found 1 error in src/a.ts" });
    assert.equal(failed.status, "fail", "lowercase 'found 1 error' must be a failure");
    assert.equal(failed.type, "type-check");
    const clean = detectValidationOutcome(tsc, { ...base, output: "0 errors found in 12 files" });
    assert.equal(clean.status, "pass", "zero-count output must stay a pass");
    const exitOverride = detectValidationOutcome(tsc, { metadata: { exit: 0 }, output: "found 1 error in src/a.ts" });
    assert.equal(exitOverride.status, "pass", "a real exit code must override the text heuristic");
});
// OPTIMIZE_LOCK_TOCTOU (1.3.6): the 1.3.4 lock treated an EMPTY lock file as
// stale and deleted it, but the owner creates the file with open("wx") and
// only THEN writes its pid. A contender reading in between could steal the
// lock, making two instances both "own" it and race optimize() — which puts
// "Compaction commit failed" on the TUI. The fix waits through the
// open->write window instead of reclaiming immediately.
import { open as fsOpen, mkdtemp, rm as fsRm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../dist/store.js";

test("optimize lock: does not steal a lock during the owner's open->write window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-lock-"));
    try {
        const store = new MemoryStore(dir, {});
        const lockFile = join(dir, ".optimize.lock");
        // Simulate the owner having created the lock via open("wx") but not
        // yet written its pid (the exact race window from the 1.3.4 bug).
        const handle = await fsOpen(lockFile, "wx");
        const acquirePromise = store.acquireOptimizeLock();
        // Owner finishes initializing ~100ms later (well inside the grace).
        await new Promise((r) => setTimeout(r, 100));
        await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
        await handle.close();
        const acquired = await acquirePromise;
        // The lock was still being initialized and is now owned by a live
        // process (us): the contender must NOT steal it. The 1.3.4 code read
        // the empty file as "stale", deleted it, recreated it and returned
        // true — the bug that let two instances both own the lock.
        assert.equal(acquired, false);
        const content = await readFile(lockFile, "utf8");
        assert.ok(content.startsWith(`${process.pid}\n`), "lock file still owned by the original owner");
    } finally {
        await fsRm(dir, { recursive: true, force: true });
    }
});

test("optimize lock: reclaims a genuinely stale lock after the grace window", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-lock-stale-"));
    try {
        const store = new MemoryStore(dir, {});
        const lockFile = join(dir, ".optimize.lock");
        // Dead owner pid (not alive), lock content well inside TTL.
        await writeFile(lockFile, "999999\n1234567890\n", "utf8");
        const acquired = await store.acquireOptimizeLock();
        assert.equal(acquired, true);
        const content = await readFile(lockFile, "utf8");
        assert.ok(content.startsWith(`${process.pid}\n`), "reclaimed lock now owned by this pid");
    } finally {
        await fsRm(dir, { recursive: true, force: true });
    }
});

test("scope: resolveScope collapses explicit scopes to global in global mode", () => {
    const old = process.env.OPENCODE_MEMORY_PRO_SCOPING;
    delete process.env.OPENCODE_MEMORY_PRO_SCOPING;
    try {
        assert.equal(resolveScope(undefined, "/tmp"), "global");
        assert.equal(resolveScope("project", "/tmp"), "global");
        assert.equal(resolveScope("global", "/tmp"), "global");
        assert.equal(resolveScope("anything", "/tmp"), "global");
    } finally {
        if (old !== undefined) process.env.OPENCODE_MEMORY_PRO_SCOPING = old;
    }
});

// SCOPING_CONFIG_SOURCE (1.4.5): opencode.json's memory.scoping only reaches
// the plugin through the config hook; resolveScoping used to resolve with {}
// and silently collapsed "project" to "global". The injected source must
// drive scoping, env must still override it, and clearing must fall back.
test("scope: injected opencode config drives scoping, env still overrides (SCOPING_CONFIG_SOURCE)", async () => {
    const { setScopingConfigSource } = await import("../dist/scope.js");
    const { stableHash } = await import("../dist/utils.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "omp-scope-src-")); // not a git repo → project:local:<hash>
    const old = process.env.OPENCODE_MEMORY_PRO_SCOPING;
    delete process.env.OPENCODE_MEMORY_PRO_SCOPING;
    try {
        setScopingConfigSource({ memory: { scoping: "project" } });
        assert.equal(resolveScope(undefined, dir), `project:local:${stableHash(dir).slice(0, 16)}`,
            "memory.scoping from the injected opencode config must be honored");
        assert.equal(resolveScope("my-project", dir), "my-project",
            "explicit scope must be honored once project mode is active");
        // Env override keeps precedence over the injected config.
        process.env.OPENCODE_MEMORY_PRO_SCOPING = "global";
        assert.equal(resolveScope(undefined, dir), "global", "env must still win over the config source");
    } finally {
        setScopingConfigSource(undefined);
        if (old !== undefined) process.env.OPENCODE_MEMORY_PRO_SCOPING = old;
        else delete process.env.OPENCODE_MEMORY_PRO_SCOPING;
    }
    assert.equal(resolveScope(undefined, dir), "global", "clearing the source restores the global fallback");
});

// STABLE_HASH_NONSTRING (1.6.2): deriveProjectScope(undefined) threw in
// project mode — stableHash(undefined) hit createHash.update(TypeError).
// Non-string worktrees now hash the empty string instead of crashing.
test("scope: deriveProjectScope tolerates a missing worktree in project mode (STABLE_HASH_NONSTRING)", async () => {
    const { setScopingConfigSource, deriveProjectScope } = await import("../dist/scope.js");
    const old = process.env.OPENCODE_MEMORY_PRO_SCOPING;
    delete process.env.OPENCODE_MEMORY_PRO_SCOPING;
    try {
        setScopingConfigSource({ memory: { scoping: "project" } });
        const derived = deriveProjectScope(undefined);
        assert.equal(typeof derived, "string", "deriveProjectScope(undefined) must not throw in project mode");
        assert.ok(derived.startsWith("project:local:"), "a stable project scope is still derived");
        assert.equal(deriveProjectScope(undefined), derived, "missing worktree hashes deterministically");
    }
    finally {
        setScopingConfigSource(undefined);
        if (old !== undefined) process.env.OPENCODE_MEMORY_PRO_SCOPING = old;
        else delete process.env.OPENCODE_MEMORY_PRO_SCOPING;
    }
});

test("scope: resolveScope honors explicit scopes in project mode", () => {
    const old = process.env.OPENCODE_MEMORY_PRO_SCOPING;
    process.env.OPENCODE_MEMORY_PRO_SCOPING = "project";
    try {
        assert.equal(resolveScope("global", "/tmp"), "global");
        assert.equal(resolveScope("project", "/tmp"), "project");
        const derived = resolveScope(undefined, "/tmp");
        assert.ok(derived.startsWith("project:"), `expected derived project scope, got ${derived}`);
    } finally {
        if (old !== undefined) process.env.OPENCODE_MEMORY_PRO_SCOPING = old;
        else delete process.env.OPENCODE_MEMORY_PRO_SCOPING;
    }
});

// NO_GIT_SCOPE (perf review): deriveProjectScope used to shell out to
// `git config --get remote.origin.url` on EVERY call in project mode — a
// blocking subprocess spawn — and derive the scope from the remote URL, so
// clones of the same repo at different paths shared one scope. Project scope
// is now always derived from the worktree path alone. Mutant: restoring the
// git-remote lookup makes this fail (a repo with an origin remote would
// derive project:<hash(remote)> instead of project:local:<hash(worktree)>).
test("scope: project scope derives from the worktree path alone, never from git remotes (NO_GIT_SCOPE)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const { stableHash } = await import("../dist/utils.js");
    const dir = mkdtempSync(join(tmpdir(), "omp-nogit-"));
    const old = process.env.OPENCODE_MEMORY_PRO_SCOPING;
    process.env.OPENCODE_MEMORY_PRO_SCOPING = "project";
    try {
        // A REAL git repo with an origin remote: the pre-fix code read the
        // remote URL via a blocking git subprocess and scoped by it.
        spawnSync("git", ["init", "-q", dir], { stdio: "ignore" });
        spawnSync("git", ["-C", dir, "remote", "add", "origin", "https://example.com/team/repo.git"], { stdio: "ignore" });
        const derived = resolveScope(undefined, dir);
        assert.equal(derived, `project:local:${stableHash(dir).slice(0, 16)}`,
            `git remote must not influence the derived project scope, got ${derived}`);
        assert.ok(!derived.includes(stableHash("https://example.com/team/repo.git").slice(0, 16)),
            "scope must not be derived from the remote URL");
    }
    finally {
        if (old !== undefined) process.env.OPENCODE_MEMORY_PRO_SCOPING = old;
        else delete process.env.OPENCODE_MEMORY_PRO_SCOPING;
        rmSync(dir, { recursive: true, force: true });
    }
});

// SCOPING_CACHE (perf review): resolveScoping caches decisions per worktree
// for a short TTL to avoid re-reading + re-parsing config sidecars on every
// tool call. The cache is keyed on the OPENCODE_MEMORY_PRO_SCOPING env value
// (the one input that changes without setScopingConfigSource), so a runtime
// env flip must never be served stale. Mutant: keying the cache on the
// worktree alone serves the stale "project" decision and this fails.
test("scope: scoping cache never serves a stale decision across an env flip (SCOPING_CACHE)", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "omp-scopecache-"));
    const old = process.env.OPENCODE_MEMORY_PRO_SCOPING;
    try {
        process.env.OPENCODE_MEMORY_PRO_SCOPING = "project";
        assert.ok(resolveScope(undefined, dir).startsWith("project:"), "first call resolves project mode");
        process.env.OPENCODE_MEMORY_PRO_SCOPING = "global";
        assert.equal(resolveScope(undefined, dir), "global",
            "env flip to global must not be served a stale cached project decision");
    }
    finally {
        if (old !== undefined) process.env.OPENCODE_MEMORY_PRO_SCOPING = old;
        else delete process.env.OPENCODE_MEMORY_PRO_SCOPING;
        rmSync(dir, { recursive: true, force: true });
    }
});

// SCOPING_CACHE (perf review): setScopingConfigSource must invalidate cached
// scoping decisions — the injected config is the other input that changes the
// outcome, and the cache is only correct if it is cleared on injection.
// Mutant: dropping the clear serves a stale "project" decision after the
// source flips to global and this fails.
test("scope: setScopingConfigSource clears cached scoping decisions (SCOPING_CACHE)", async () => {
    const { setScopingConfigSource } = await import("../dist/scope.js");
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "omp-scopeclear-"));
    const old = process.env.OPENCODE_MEMORY_PRO_SCOPING;
    delete process.env.OPENCODE_MEMORY_PRO_SCOPING;
    try {
        setScopingConfigSource({ memory: { scoping: "project" } });
        assert.ok(resolveScope(undefined, dir).startsWith("project:"), "project source honored");
        setScopingConfigSource({ memory: { scoping: "global" } });
        assert.equal(resolveScope(undefined, dir), "global",
            "flipping the injected source must not be served a stale cached project decision");
    }
    finally {
        setScopingConfigSource(undefined);
        if (old !== undefined) process.env.OPENCODE_MEMORY_PRO_SCOPING = old;
        else delete process.env.OPENCODE_MEMORY_PRO_SCOPING;
        rmSync(dir, { recursive: true, force: true });
    }
});

test("config: shipped example file is valid, resolves cleanly, and leaks no secrets", async () => {
    const fs = await import("node:fs");
    const raw = JSON.parse(fs.readFileSync(new URL("../opencode-memory-pro.example.json", import.meta.url), "utf8"));
    const cfg = resolveMemoryConfig(raw, "/tmp");
    assert.equal(cfg.provider, "opencode-memory-pro");
    assert.equal(cfg.embedding.provider, "ollama");
    assert.equal(cfg.embedding.model, "nomic-embed-text");
    assert.equal(cfg.capture.mode, "heuristics");
    assert.equal(cfg.retrieval.recencyHalfLifeHours, 72);
    assert.equal(cfg.injection.maxCharsPerMemory, 1200);
    assert.equal(cfg.dedup.writeThreshold, 0.92);
    assert.equal(cfg.graph.typedEdges, true);
    const dumped = JSON.stringify(raw);
    assert.ok(!/sk-or-v1|sk-[A-Za-z0-9]{16,}|api[_-]?key"\s*:\s*"[^"<]/.test(dumped), "example must not embed real secret material");
    assert.ok((raw._comment ?? "").length > 0, "example should carry inline guidance");
});

test("config: fuzzy channel defaults on (0.15) and renormalizes three channels", () => {
    const cfg = resolveMemoryConfig({}, "/tmp");
    const sum = cfg.retrieval.vectorWeight + cfg.retrieval.bm25Weight + cfg.retrieval.fuzzyWeight;
    assert.ok(Math.abs(sum - 1) < 1e-9, `weights must sum to 1, got ${sum}`);
    assert.ok(cfg.retrieval.fuzzyWeight > 0, "fuzzy channel should be on by default");
    assert.equal(cfg.retrieval.fuzzyThreshold, 0.5);
    const off = resolveMemoryConfig({ memory: { retrieval: { fuzzyWeight: 0 } } }, "/tmp");
    assert.equal(off.retrieval.fuzzyWeight, 0, "fuzzyWeight 0 must fully disable the channel");
    assert.ok(Math.abs((off.retrieval.vectorWeight + off.retrieval.bm25Weight) - 1) < 1e-9, "vector+bm25 renormalize when fuzzy is off");
});

// CAPTURE_RETRY_ON_DEFERRED (1.4.5): flushAutoCapture owns the capture-buffer
// delete — fragments must survive a deferred-init flush and be consumed only
// once storage provably proceeds past init.
function makeFlushState({ initialized, minCaptureChars = 0 }) {
    const events = [];
    const storedRecords = [];
    const state = {
        captureBuffer: new Map(),
        activeEpisodes: new Map(),
        flushInProgress: new Set(),
        defaultScope: "global",
        initialized,
        ensureInitialized: async () => { },
        config: {
            capture: { mode: "heuristics" },
            dedup: { enabled: false },
            graph: { enabled: false },
            embedding: { model: "test-model" },
            minCaptureChars,
            maxEntriesPerScope: 100,
        },
        embedder: { embed: async () => [0.1, 0.2, 0.3] },
        store: {
            putEvent: async (event) => { events.push(event); },
            put: async (record) => { storedRecords.push(record); },
            pruneScope: async () => { },
        },
    };
    return { state, events, storedRecords };
}

const offlineClient = { session: { get: async () => { throw new Error("client offline in test"); } } };

test("capture: flushAutoCapture retains buffered fragments when init is deferred (CAPTURE_RETRY_ON_DEFERRED)", async () => {
    const { state } = makeFlushState({ initialized: false });
    const fragments = ["decided to use SQLite for the cache"];
    state.captureBuffer.set("sess-1", [...fragments]);
    await flushAutoCapture("sess-1", state, offlineClient);
    assert.ok(state.captureBuffer.has("sess-1"), "fragments must survive a deferred-init flush");
    assert.deepEqual(state.captureBuffer.get("sess-1"), fragments);
});

test("capture: flushAutoCapture deletes buffer once initialized (no double-flush regression)", async () => {
    const { state, events } = makeFlushState({ initialized: true, minCaptureChars: 100000 });
    state.captureBuffer.set("sess-2", ["some transcript fragment"]);
    await flushAutoCapture("sess-2", state, offlineClient);
    assert.ok(!state.captureBuffer.has("sess-2"), "initialized flush must consume the buffer");
    const outcomes = events.map((e) => e.outcome);
    assert.ok(outcomes.includes("considered"), "flush must reach the post-guard path");
    assert.ok(outcomes.includes("skipped"), "below-min text records an explicit skipped event");
});

test("capture: flushAutoCapture retry after init recovery consumes and stores retained fragments", async () => {
    const { state, events, storedRecords } = makeFlushState({ initialized: false });
    let attempt = 0;
    state.ensureInitialized = async () => {
        attempt += 1;
        if (attempt >= 2)
            state.initialized = true;
    };
    const fragments = ["fixed the flaky test by resetting the SQLite cache before each run"];
    state.captureBuffer.set("sess-3", [...fragments]);
    await flushAutoCapture("sess-3", state, offlineClient);
    assert.ok(state.captureBuffer.has("sess-3"), "first flush (init deferred) retains fragments");
    await flushAutoCapture("sess-3", state, offlineClient);
    assert.ok(!state.captureBuffer.has("sess-3"), "recovered flush consumes the buffer");
    assert.equal(storedRecords.length, 1);
    assert.equal(storedRecords[0].text, fragments[0]);
    const storedEvent = events.find((e) => e.outcome === "stored");
    assert.ok(storedEvent, "stored capture event must be recorded");
    assert.equal(storedEvent.memoryId, storedRecords[0].id);
});

// SESSION_IDLE_FLUSH_GUARD (1.4.5): the session.idle/compacted path used to
// await flushAutoCapture with no try/catch — a transient store failure (e.g.
// putEvent rejecting on a LanceDB hiccup) propagated out of the event hook,
// aborting capture AND skipping the consolidate/sweep pass for that event.
test("capture: handleSessionIdle swallows flush failure and still consolidates (SESSION_IDLE_FLUSH_GUARD)", async () => {
    const { state } = makeFlushState({ initialized: true, minCaptureChars: 0 });
    state.captureBuffer.set("sess-4", ["decided to use SQLite for the cache"]);
    // The "considered" recordCaptureEvent is the first store call in flush —
    // make it reject exactly like a transient LanceDB write failure.
    state.store.putEvent = async () => { throw new Error("lancedb transient failure"); };
    // Enable the consolidate/sweep pass with observable stubs.
    state.config.dedup.enabled = true;
    state.consolidationInProgress = new Map();
    state.lastConsolidateAt = new Map();
    state.sweepInProgress = new Map();
    state.lastSweepAt = new Map();
    let consolidateCalls = 0;
    state.store.consolidateDuplicates = async () => { consolidateCalls += 1; };
    state.store.readByScopes = async () => [];
    const warnMessages = [];
    const originalWarn = console.warn;
    console.warn = (msg) => { warnMessages.push(String(msg)); };
    try {
        await assert.doesNotReject(handleSessionIdle("sess-4", "session.idle", state, { client: offlineClient }));
    }
    finally {
        console.warn = originalWarn;
    }
    assert.equal(consolidateCalls, 1, "consolidate must still run after a failed flush");
    assert.ok(
        warnMessages.some((m) => m.includes("failed to flush capture on session idle")),
        "flush failure must be logged as a warn, not propagated",
    );
});

// IDLE_SWEEP_DEDUP_DECOUPLE (1.6.2): the idle/compacted consolidate+sweep
// pass used to be gated on dedup.enabled (handleSessionIdle wrapped it in
// `if (state.config.dedup.enabled)`), so with dedup disabled the retention
// sweep NEVER ran on idle/compacted — only init + session.deleted did. The
// sweep is retention, not dedup; the deleted path runs both unconditionally.
// Regression: dedup off must still schedule+run the retention sweep, while
// consolidation stays off (its own dedup guard decides).
test("capture: handleSessionIdle runs retention sweep with dedup disabled (IDLE_SWEEP_DEDUP_DECOUPLE)", async () => {
    const { state } = makeFlushState({ initialized: true });
    state.config.dedup.enabled = false;
    state.consolidationInProgress = new Map();
    state.lastConsolidateAt = new Map();
    state.sweepInProgress = new Map();
    state.lastSweepAt = new Map();
    let consolidateCalls = 0;
    state.store.consolidateDuplicates = async () => { consolidateCalls += 1; };
    // Probe: make the sweep's first store read throw a marker — the sweep is
    // fire-and-forget with an internal catch that logs "[retention] sweep
    // failed: ...", which is how we observe it actually ran.
    state.store.readByScopes = async () => { throw new Error("R10_SWEEP_PROBE"); };
    const warnMessages = [];
    const originalWarn = console.warn;
    console.warn = (msg) => { warnMessages.push(String(msg)); };
    try {
        await assert.doesNotReject(handleSessionIdle("sess-r10", "session.idle", state, { client: offlineClient }));
        // maybeSweepExpiredMemories is fire-and-forget; let its promise chain
        // (readByScopes throw → catch → warn) settle before asserting.
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    finally {
        console.warn = originalWarn;
    }
    assert.equal(typeof state.lastSweepAt.get("global"), "number", "sweep must be scheduled even with dedup disabled");
    assert.ok(
        warnMessages.some((m) => m.includes("R10_SWEEP_PROBE")),
        "the retention sweep must actually run with dedup disabled",
    );
    assert.equal(consolidateCalls, 0, "consolidation must stay off when dedup is disabled");
});

// CAPTURE_BUFFER_AFTER_WRITES (1.6.1): the buffer delete used to run BEFORE
// the awaited store writes (recordCaptureEvent → putEvent was the first). A
// transient LanceDB failure threw out of _flushAutoCapture with the buffer
// entry ALREADY deleted — the transcript was gone and the retry-on-next-flush
// mechanism found an empty buffer. The delete now runs only after every store
// write succeeds, so a thrown write leaves the fragments in place to retry.
test("capture: store write failure retains buffered fragments for retry (CAPTURE_BUFFER_AFTER_WRITES)", async () => {
    const { state, events, storedRecords } = makeFlushState({ initialized: true, minCaptureChars: 0 });
    const fragments = ["decided to use SQLite for the cache"];
    state.captureBuffer.set("sess-5", [...fragments]);
    // The "considered" recordCaptureEvent is the first store call in flush —
    // make it reject exactly like a transient LanceDB write failure.
    state.store.putEvent = async () => { throw new Error("lancedb transient failure"); };
    // flushAutoCapture propagates the failure (handleSessionIdle/session.deleted
    // catch it) — the contract is that the buffer retains the fragments.
    await assert.rejects(flushAutoCapture("sess-5", state, offlineClient), /lancedb transient failure/);
    assert.ok(
        state.captureBuffer.has("sess-5"),
        "fragments must survive a failed store write so the next flush can retry",
    );
    assert.deepEqual(
        state.captureBuffer.get("sess-5"),
        fragments,
        "the buffered fragments must be unchanged after the failed flush",
    );
    // Recover the store and flush again — the retained fragments must now be
    // consumed exactly once.
    state.store.putEvent = async (event) => { events.push(event); };
    await flushAutoCapture("sess-5", state, offlineClient);
    assert.ok(!state.captureBuffer.has("sess-5"), "recovered flush consumes the buffer");
    assert.equal(storedRecords.length, 1, "retained fragments must be stored on retry");
});

// FLUSH_SNAPSHOT_CONSUME (1.6.2): a fragment appended DURING the flush's
// awaits (a text.complete landing between store writes) used to be discarded
// by the final buffer delete — silent transcript loss. The snapshot drives
// extraction; appended fragments survive for the next flush.
test("capture: fragments appended during a flush survive it (FLUSH_SNAPSHOT_CONSUME)", async () => {
    const { state, storedRecords } = makeFlushState({ initialized: true, minCaptureChars: 0 });
    state.captureBuffer.set("sess-snap", ["decided to use sqlite for the cache"]);
    let appended = false;
    state.store.putEvent = async () => {
        // Simulate a text.complete firing mid-flush: push onto the LIVE
        // array (recordCaptureFragment pushes without reassignment).
        if (!appended) {
            appended = true;
            state.captureBuffer.get("sess-snap").push("decided to use redis afterwards");
        }
    };
    await flushAutoCapture("sess-snap", state, offlineClient);
    assert.equal(storedRecords.length, 1, "only the snapshot fragment is stored");
    assert.equal(storedRecords[0].text, "decided to use sqlite for the cache");
    assert.deepEqual(
        state.captureBuffer.get("sess-snap"),
        ["decided to use redis afterwards"],
        "the appended fragment must remain in the buffer for the next flush",
    );
});

// FLUSH_IN_PROGRESS_GUARD (1.6.2): concurrent session.idle + session.deleted
// flushes for one session used to BOTH read the same fragments and store
// them twice (duplicate captures). The per-session guard coalesces them.
test("capture: concurrent flushes for one session coalesce (FLUSH_IN_PROGRESS_GUARD)", async () => {
    const { state, storedRecords } = makeFlushState({ initialized: true, minCaptureChars: 0 });
    state.captureBuffer.set("sess-race", ["decided to use sqlite for the cache"]);
    await Promise.all([
        flushAutoCapture("sess-race", state, offlineClient),
        flushAutoCapture("sess-race", state, offlineClient),
    ]);
    assert.equal(storedRecords.length, 1, "only one flush consumes the fragments");
    assert.ok(!state.captureBuffer.has("sess-race"), "buffer consumed exactly once");
});

// ACTIVE_EPISODES_CAP (1.6.2): activeEpisodes grew unbounded (siblings are
// capped: captureBuffer 200, sessionErrors 500). A lost session.deleted
// event or a failing updateTaskState (retained for retry by design) leaked
// entries for the process lifetime. FIFO-capped at 500.
test("lifecycle: activeEpisodes is FIFO-capped (ACTIVE_EPISODES_CAP)", async () => {
    const { state } = makeFlushState({ initialized: true });
    let created = 0;
    state.store.createTaskEpisode = async () => { created += 1; };
    const input = { worktree: "/tmp", client: offlineClient };
    for (let i = 0; i < 501; i++) {
        await handleSessionStart(`sess-cap-${i}`, state, input);
    }
    assert.equal(created, 501, "every episode is still created");
    assert.equal(state.activeEpisodes.size, 500, "map must be capped at 500");
    assert.ok(!state.activeEpisodes.has("sess-cap-0"), "oldest entry must be evicted");
    assert.ok(state.activeEpisodes.has("sess-cap-500"), "newest entry retained");
});

// SESSION_LIFECYCLE_GUARD (1.4.6): handleSessionStart/End perform real store
// I/O (createTaskEpisode / updateTaskState) with no try/catch — a transient
// LanceDB failure propagated out of the event hook, and on session.deleted it
// aborted the branch before the end-of-session dedup/consolidation pass.
function makeLifecycleState() {
    const state = {
        initialized: true,
        ensureInitialized: async () => { },
        activeEpisodes: new Map(),
        store: {},
    };
    return state;
}

function captureWarn() {
    const warnMessages = [];
    const originalWarn = console.warn;
    console.warn = (msg) => { warnMessages.push(String(msg)); };
    return { warnMessages, restore: () => { console.warn = originalWarn; } };
}

test("lifecycle: handleSessionStart swallows store failure (SESSION_LIFECYCLE_GUARD)", async () => {
    const state = makeLifecycleState();
    state.store.createTaskEpisode = async () => { throw new Error("lancedb transient failure"); };
    const { warnMessages, restore } = captureWarn();
    try {
        await assert.doesNotReject(handleSessionStart("sess-start-1", state, { client: offlineClient, worktree: "/tmp/proj" }));
    }
    finally {
        restore();
    }
    assert.ok(
        warnMessages.some((m) => m.includes("failed to record session start")),
        "session start failure must be logged as a warn, not propagated",
    );
    assert.ok(!state.activeEpisodes.has("sess-start-1"), "no episode entry when createTaskEpisode fails");
});

test("lifecycle: handleSessionEnd swallows store failure and retains episode for retry (SESSION_LIFECYCLE_GUARD)", async () => {
    const state = makeLifecycleState();
    state.activeEpisodes.set("sess-end-1", { taskId: "session-sess-end", scope: "proj" });
    state.store.updateTaskState = async () => { throw new Error("lancedb transient failure"); };
    const { warnMessages, restore } = captureWarn();
    try {
        await assert.doesNotReject(handleSessionEnd("sess-end-1", state, "success", undefined));
    }
    finally {
        restore();
    }
    assert.ok(
        warnMessages.some((m) => m.includes("failed to record session end")),
        "session end failure must be logged as a warn, not propagated",
    );
    assert.ok(state.activeEpisodes.has("sess-end-1"), "episode entry retained so a retry can finalize it");
});

// PREFERENCE_BUDGET_CONFIG (1.4.6): the recall path hardcoded tokenBudget: 300
// for the preference block — the user-configurable injection.budgetTokens
// never reached it and preference.js's ?? 500 fallback was dead.
test("preference: preferenceInjectionConfig reuses configured budgetTokens (PREFERENCE_BUDGET_CONFIG)", () => {
    const cfg = preferenceInjectionConfig({ mode: "budget", budgetTokens: 4096 }, { maxMemories: 7 });
    assert.deepEqual(cfg, { mode: "budget", maxMemories: 7, tokenBudget: 4096 });
    const adaptive = preferenceInjectionConfig({ mode: "adaptive", budgetTokens: 2048 }, { maxMemories: 3 });
    assert.equal(adaptive.mode, "fixed", "adaptive maps to fixed for the preference block");
    assert.equal(adaptive.tokenBudget, 2048);
});

test("preference: buildPreferenceInjection budget mode consumes tokenBudget and falls back to 500", () => {
    const prefs = [
        { category: "tool", value: "x".repeat(40), confidence: 0.9 }, // ~10 tokens
        { category: "tool", value: "y".repeat(40), confidence: 0.8 },
        { category: "tool", value: "z".repeat(40), confidence: 0.7 },
    ];
    const small = buildPreferenceInjection(prefs, { mode: "budget", maxMemories: 10, tokenBudget: 20 });
    const smallItems = small.split("\n").length - 1; // minus header
    assert.equal(smallItems, 2, "third item would exceed the 20-token budget");
    const fallback = buildPreferenceInjection(prefs, { mode: "budget", maxMemories: 10 });
    const fallbackItems = fallback.split("\n").length - 1;
    assert.equal(fallbackItems, 3, "missing tokenBudget falls back to 500 (all items fit)");
});

// PREFERENCE_VERB_LOOKAHEAD (1.6.2): "I prefer to use docker" fires
// preference pattern 4, whose optional "(?:to |)" consumed "to " and then
// captured the NEXT word — the verb "use" became a junk preference key
// ("to" itself on backtrack), injected into every recall turn's preference
// block. The negative lookahead now skips generic verbs; the intended
// object is still captured by the sibling patterns.
test("preference: 'prefer to use X' captures X, not the verb (PREFERENCE_VERB_LOOKAHEAD)", () => {
    const mem = { text: "I prefer to use docker for local development", timestamp: Date.now(), id: "m1" };
    const signals = extractPreferenceSignals(mem);
    const keys = signals.map((s) => s.key);
    assert.ok(!keys.includes("use"), `junk key 'use' must not be produced (got ${keys.join(",")})`);
    assert.ok(!keys.includes("to"), `junk key 'to' must not be produced (got ${keys.join(",")})`);
    assert.ok(keys.includes("docker"), "the real preference object must still be captured");
    const direct = extractPreferenceSignals({ text: "I prefer docker over podman", timestamp: Date.now(), id: "m2" });
    assert.ok(direct.some((s) => s.key === "docker"), "direct 'prefer docker' still captures the object");
    const avoid = extractPreferenceSignals({ text: "I prefer to avoid docker", timestamp: Date.now(), id: "m3" });
    assert.ok(!avoid.some((s) => s.key === "avoid"), "'avoid' is a verb, not a preference");
    assert.ok(avoid.some((s) => s.key === "docker"), "'avoid docker' still captures docker");
});

// OWN_SESSIONS_CAP (1.4.6): OWN_SESSION_IDS grew unbounded — one entry per
// ephemeral LLM session for the lifetime of the server process.
test("llm: trackOwnSession FIFO-caps the own-session set at 500 (OWN_SESSIONS_CAP)", () => {
    for (let i = 1; i <= 501; i++) {
        trackOwnSession(`own-sess-${i}`);
    }
    assert.equal(isOwnSession("own-sess-1"), false, "oldest id evicted once the cap is exceeded");
    assert.equal(isOwnSession("own-sess-501"), true, "newest id still tracked");
    assert.equal(isOwnSession("own-sess-2"), true, "second-oldest survives at the cap boundary");
    trackOwnSession("own-sess-1");
    assert.equal(isOwnSession("own-sess-1"), true, "re-added id is tracked again");
    assert.equal(isOwnSession("own-sess-2"), false, "re-add evicts the new oldest entry");
    assert.equal(isOwnSession("own-sess-3"), true, "remaining entries unaffected");
});

// NONE_MODE_NO_TRUNCATE (1.4.6): mode "none" must keep content as-is — the
// branch used to truncate at textThreshold * 4 chars (1200 by default).
test("summarize: mode none keeps full text without truncation (NONE_MODE_NO_TRUNCATE)", () => {
    const long = "lorem ipsum dolor sit amet ".repeat(60); // 1620 chars > 1200
    const result = summarizeContent(long, { mode: "none", textThreshold: 300, summaryTargetChars: 200 });
    assert.equal(result.type, "kept");
    assert.equal(result.content, long, "none-mode must return the text untruncated");
    assert.equal(result.originalLength, long.length);
});

// EMBEDDING_CONFIG_REEMBED (1.4.5): a config-change embedder swap (new
// provider/model with a different output dimension) sets initialized=false;
// the next ensureInitialized → store.init(newDim) hits the old fixed-width
// vector column, which LanceDB silently coerces (corrupting writes) instead
// of rejecting. initializeStore must auto-repair (backup → drop → rebuild →
// re-embed) before marking the store initialized.
function makeDimensionState({ physicalDim, records }) {
    const initCalls = [];
    const puts = [];
    const state = {
        initialized: false,
        embedder: {
            model: "test-embed-new",
            dim: async () => 16,
            embed: async () => [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
        },
        config: { provider: "test", dbPath: join(tmpdir(), `reembed-unit-${Date.now()}-${Math.random()}`, "lancedb") },
        store: {
            physicalDim,
            indexState: { dimensionMismatch: false },
            initCalls,
            puts,
            table: {},
            async init(dim) {
                initCalls.push(dim);
                if (this.table === null)
                    this.physicalDim = dim;
                this.indexState.dimensionMismatch = this.physicalDim !== null && this.physicalDim !== dim;
            },
            async getPhysicalVectorDim() { return this.physicalDim; },
            async listDistinctScopes() { return ["global"]; },
            async exportAllRecords() { return records; },
            connection: { dropTable: async (name) => { state.droppedTable = name; } },
            async put(record) { puts.push(record); },
            async ensureIndexes() { },
        },
    };
    return state;
}

test("init: initializeStore auto-repairs embedding dimension mismatch (EMBEDDING_CONFIG_REEMBED)", async () => {
    const records = [
        { id: "m1", text: "first memory", scope: "global", category: "fact" },
        { id: "m2", text: "second memory", scope: "global", category: "fact" },
    ];
    const state = makeDimensionState({ physicalDim: 8, records });
    await initializeStore(state);
    assert.equal(state.initialized, true, "store must be marked initialized after auto-repair");
    assert.equal(state.droppedTable, "memories", "repair must drop and rebuild the memories table");
    assert.deepEqual(state.store.initCalls, [16, 16], "init runs once to detect the mismatch, once to rebuild at the new dim");
    assert.equal(state.store.puts.length, 2, "every record must be re-embedded");
    assert.ok(
        state.store.puts.every((r) => r.vector.length === 16 && r.embeddingModel === "test-embed-new"),
        "re-embedded rows must carry new-dim vectors and the new model",
    );
    assert.ok(
        state.store.puts.some((r) => r.id === "m1") && state.store.puts.some((r) => r.id === "m2"),
        "original ids must survive the rebuild",
    );
    const dbDirEnd = state.config.dbPath.lastIndexOf("/");
    const backupDir = (dbDirEnd > 0 ? state.config.dbPath.slice(0, dbDirEnd) : ".") + "/backups";
    const files = await readdir(backupDir);
    const backupFile = files.find((f) => f.startsWith("reembed-repair-"));
    assert.ok(backupFile, "backup must be written before the drop");
    const backup = JSON.parse(await readFile(join(backupDir, backupFile), "utf8"));
    assert.equal(backup.count, 2, "backup must contain every record");
    assert.equal(backup.fromDim, 8, "backup records the old physical dim");
    assert.equal(backup.toDim, 16, "backup records the new embedder dim");
});

test("init: initializeStore skips repair when dimensions match (EMBEDDING_CONFIG_REEMBED)", async () => {
    const state = makeDimensionState({ physicalDim: 16, records: [] });
    await initializeStore(state);
    assert.equal(state.initialized, true);
    assert.equal(state.droppedTable, undefined, "no drop when dims already match");
    assert.deepEqual(state.store.initCalls, [16], "single init, no rebuild");
});

// CONFIG_CHANGE_INIT_RESET (1.6.2): a config re-resolution that swaps the
// embedder while an init is in flight must clear initPromise, otherwise the
// next ensureInitialized returns the OLD in-flight promise (built against the
// OLD embedder) and the new dimension is never probed.
test("config: handleEmbeddingConfigChange clears initPromise on embedding change (CONFIG_CHANGE_INIT_RESET)", () => {
    const state = {
        config: { embedding: { provider: "ollama", model: "old-model" } },
        embedder: { model: "old-model" },
        initialized: true,
        initPromise: Promise.resolve(),
    };
    const nextConfig = { embedding: { provider: "ollama", model: "new-model" } };
    handleEmbeddingConfigChange(state, nextConfig);
    assert.equal(state.initPromise, null, "in-flight initPromise must be cleared so the next init re-probes the new dimension");
    assert.equal(state.initialized, false, "embedding change must clear initialized");
    assert.equal(state.embedder.model, "new-model", "embedder must be swapped to the new model");
});

test("config: handleEmbeddingConfigChange leaves initPromise intact when embedding unchanged", () => {
    const inFlight = Promise.resolve();
    const state = {
        config: { embedding: { provider: "ollama", model: "same-model" } },
        embedder: { model: "same-model" },
        initialized: true,
        initPromise: inFlight,
    };
    const nextConfig = { embedding: { provider: "ollama", model: "same-model" } };
    handleEmbeddingConfigChange(state, nextConfig);
    assert.equal(state.initPromise, inFlight, "no embedding change must not clear initPromise");
    assert.equal(state.initialized, true, "no embedding change must not clear initialized");
});

test("repair: repairEmbeddingDimension no-ops when dims already match", async () => {
    const state = makeDimensionState({ physicalDim: 16, records: [] });
    const result = await repairEmbeddingDimension(state, 16);
    assert.equal(result.mismatch, false, "matching dims must report no mismatch");
    assert.equal(state.droppedTable, undefined, "nothing dropped");
});

// EMBEDDER_HEALTH_RESET (1.6.2) + EMBEDDER_RETRY_COUNT_RESET (1.6.2): a
// successful embed after an outage must clear the degraded state AND reset the
// retry counter. The retry-disabled path previously returned embedder.embed()
// directly without touching health, so a recovered embedder stayed
// fallbackActive:true forever (memory_stats reported "bm25-only").
function mockEmbeddingFetch() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ embedding: [0.1, 0.2, 0.3] }),
    });
    return originalFetch;
}

test("embedder: retry-disabled path clears degraded health on success (EMBEDDER_HEALTH_RESET)", async () => {
    resetEmbedderHealth();
    setEmbedderHealth({ status: "degraded", fallbackActive: true, retryCount: 7, lastError: "boom" });
    const originalFetch = mockEmbeddingFetch();
    try {
        const embedder = createEmbedder({ provider: "ollama", model: "test", baseUrl: "http://x", retry: { enabled: false } });
        await embedder.embed("hello");
        const health = getEmbedderHealth();
        assert.equal(health.fallbackActive, false, "success must clear fallbackActive");
        assert.equal(health.status, "healthy", "success must restore healthy status");
        assert.equal(health.retryCount, 0, "success must reset retryCount");
        assert.equal(health.lastError, null, "success must clear lastError");
    }
    finally {
        globalThis.fetch = originalFetch;
        resetEmbedderHealth();
    }
});

test("embedder: retryCount resets on success (EMBEDDER_RETRY_COUNT_RESET)", async () => {
    resetEmbedderHealth();
    setEmbedderHealth({ status: "degraded", fallbackActive: true, retryCount: 5 });
    const originalFetch = mockEmbeddingFetch();
    try {
        const embedder = createEmbedder({ provider: "ollama", model: "test", baseUrl: "http://x", retry: { enabled: true, maxAttempts: 3, initialDelayMs: 1, backoffMultiplier: 1 } });
        await embedder.embed("hello");
        const health = getEmbedderHealth();
        assert.equal(health.retryCount, 0, "retryCount must reset to 0 on success");
        assert.equal(health.fallbackActive, false, "success must clear fallbackActive");
        assert.equal(health.status, "healthy", "success must restore healthy status");
    }
    finally {
        globalThis.fetch = originalFetch;
        resetEmbedderHealth();
    }
});

// BM25_INDEX_ALIGN (1.4.5): cached.tokenized is aligned with the UNFILTERED
// cached.records. search() used to map BM25 scores with the FILTERED index,
// so once the dimension-mismatch filter dropped a row, every later row was
// scored against the wrong document's tokens. Records arrive newest-first
// (SCAN_ORDER), so the dim-mismatched row sits FIRST here — the exact shape
// a null/legacy-vector row produces in production.
test("search: bm25 stays aligned with unfiltered records when dim-mismatched rows are filtered (BM25_INDEX_ALIGN)", async () => {
    const { tokenize } = await import("../dist/utils.js");
    const dir = await mkdtemp(join(tmpdir(), "omp-bm25-align-"));
    try {
        const store = new MemoryStore(dir, {});
        const records = [
            // Newest (SCAN_ORDER puts it first) and dim-mismatched: the filter drops it.
            { id: "stale-dim", text: "quasar calibration constants for the deep space antenna", vector: Array.from({ length: 8 }, () => 0.1), scope: "global", timestamp: Date.now(), importance: 0.5, category: "other" },
            // Older, correct dim: query tokens absent from its text.
            { id: "unrelated", text: "grocery list reminders for the weekend farmers market", vector: Array.from({ length: 16 }, () => 0.2), scope: "global", timestamp: Date.now() - 60_000, importance: 0.5, category: "other" },
            // Older still, correct dim: the true best bm25 match.
            { id: "target", text: "quasar calibration procedure documented for the radio telescope crew", vector: Array.from({ length: 16 }, () => 0.3), scope: "global", timestamp: Date.now() - 120_000, importance: 0.5, category: "other" },
        ];
        store.getCachedScopes = async () => ({
            records,
            tokenized: records.map((r) => tokenize(r.text)),
            idf: new Map(),
            norms: new Map(),
            lastAccessTimestamp: Date.now(),
        });
        const results = await store.search({
            query: "quasar calibration",
            queryVector: Array.from({ length: 16 }, () => 0.1),
            scopes: ["global"],
            limit: 5,
            vectorWeight: 0,
            bm25Weight: 1,
            minScore: 0,
            rrfK: 60,
            recencyBoost: false,
            importanceWeight: 0,
            feedbackWeight: 0,
        });
        const byId = new Map(results.map((r) => [r.record.id, r]));
        assert.ok(byId.has("target"), `target must be returned, got ${[...byId.keys()].join(",")}`);
        assert.equal(results[0].record.id, "target", `target must rank first, got ${results[0]?.record?.id}`);
        assert.ok(byId.get("target").bm25Score > 0, "target must score on its own tokens");
        assert.equal(byId.get("unrelated")?.bm25Score ?? 0, 0, "unrelated row must not inherit the filtered row's tokens");
    } finally {
        await fsRm(dir, { recursive: true, force: true });
    }
});

// TIMING_SPANS (1.4.7): span utility tests — aggregation, extra passthrough,
// reset, and never-throw contract.
import { startSpan, getTimingStats, resetTimingStats } from "../dist/timing.js";

test("timing: startSpan aggregates count/total/max/last per op", async () => {
    resetTimingStats();
    const stopA = startSpan("test.opA");
    await sleepMs(15);
    stopA();
    const stopB = startSpan("test.opA");
    stopB();
    const stopC = startSpan("test.opA");
    await sleepMs(5);
    stopC();
    const stats = getTimingStats().filter((s) => s.op === "test.opA");
    assert.equal(stats.length, 1);
    const s = stats[0];
    assert.equal(s.count, 3);
    assert.ok(s.totalMs >= 15, `totalMs should include both sleeps, got ${s.totalMs}`);
    assert.ok(s.maxMs >= 10, `maxMs should be the ~15ms span, got ${s.maxMs}`);
    assert.ok(s.lastMs >= 2, `lastMs should be the ~5ms span, got ${s.lastMs}`);
    assert.ok(s.avgMs > 0 && s.avgMs <= s.maxMs, `avgMs out of range: ${s.avgMs}`);
});

test("timing: stop(extra) records lastExtra and getTimingStats sorts by totalMs", async () => {
    resetTimingStats();
    startSpan("test.sortA")({ n: 1 });
    const stopBig = startSpan("test.sortB");
    await sleepMs(10);
    stopBig({ candidates: 42 });
    const stats = getTimingStats();
    const b = stats.findIndex((s) => s.op === "test.sortB");
    const a = stats.findIndex((s) => s.op === "test.sortA");
    assert.ok(a === -1 || b < a, "sortB (10ms) must sort before sortA (~0ms)");
    const entry = stats.find((s) => s.op === "test.sortB");
    assert.deepEqual(entry.lastExtra, { candidates: 42 });
});

test("timing: resetTimingStats clears all aggregates", () => {
    startSpan("test.reset")();
    assert.ok(getTimingStats().some((s) => s.op === "test.reset"));
    resetTimingStats();
    assert.equal(getTimingStats().some((s) => s.op === "test.reset"), false);
});

test("timing: stop is idempotent-safe across early throws and bad names", async () => {
    resetTimingStats();
    // Bad name: no-op stop that returns 0 and records nothing.
    assert.equal(startSpan("")(), 0);
    assert.equal(getTimingStats().some((s) => s.op === ""), false);
    // Stop without extra, twice (double-stop must not throw).
    const stop = startSpan("test.double");
    stop();
    assert.doesNotThrow(() => stop());
    // Nested spans measure independently.
    const outer = startSpan("test.outer");
    await sleepMs(5);
    const inner = startSpan("test.inner");
    await sleepMs(5);
    inner();
    outer();
    const stats = new Map(getTimingStats().map((s) => [s.op, s]));
    assert.ok(stats.get("test.outer").lastMs >= stats.get("test.inner").lastMs,
        "outer span must cover at least the inner span duration");
});

function sleepMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// FAST_PATH_USAGE_LOOKUP (perf review): updateMemoryUsage used to pay a full
// readByScopes table scan per recall result to find one row; it now checks the
// warm scope cache first (zero I/O). findCachedRecordByScopes must find exact
// and prefix ids in a warm cache and return null on any miss so callers fall
// back to a real query. Mutant: removing the method (pre-fix) fails outright.
test("store: findCachedRecordByScopes finds exact and prefix ids in the warm cache (FAST_PATH_USAGE_LOOKUP)", () => {
    const store = new MemoryStore("/tmp/omp-unused", {});
    const records = [
        { id: "rec-12345678-extra", text: "alpha", vector: [0.1, 0.2], recallCount: 0 },
        { id: "rec-87654321", text: "beta", vector: [0.2, 0.1], recallCount: 0 },
    ];
    store.scopeCache.set("global", { records, norms: new Map(), tokenized: [], idf: new Map(), loadedAt: Date.now(), lastAccessTimestamp: Date.now(), version: 0 });
    assert.equal(store.findCachedRecordByScopes("rec-12345678", ["global"]), records[0], "prefix query matches the cached id");
    assert.equal(store.findCachedRecordByScopes("rec-87654321", ["global"]), records[1], "exact id matches");
    assert.equal(store.findCachedRecordByScopes("rec-87654321", ["global", "other"]), records[1], "first matching scope wins");
    assert.equal(store.findCachedRecordByScopes("rec-99999999", ["global"]), null, "unknown id must miss");
    assert.equal(store.findCachedRecordByScopes("rec-87654321", ["other"]), null, "absent scope must miss");
});

// CACHE_REUSE_DEDUP (perf review): the no-index vector fallback used to issue
// a fresh full-scope scan on every dedup check even when the scope cache held
// a warm copy. getCachedVectorCandidates must reuse version- and age-checked
// cached rows (with precomputed norms) and return null on ANY miss so callers
// fall back to the real query unchanged. Mutant: dropping the version check
// serves stale rows; removing the method (pre-fix) fails outright.
test("store: getCachedVectorCandidates reuses fresh cache rows and nulls on any miss (CACHE_REUSE_DEDUP)", () => {
    const store = new MemoryStore("/tmp/omp-unused", { enabled: true, staleAfterMs: 60_000 });
    const records = [
        { id: "vec-1", vector: [1, 0], recallCount: 0 },
        { id: "vec-2", vector: [0, 1], recallCount: 0 },
    ];
    const norms = new Map([["vec-1", 1], ["vec-2", 1]]);
    store.scopeVersions.set("global", 3);
    store.scopeCache.set("global", { records, norms, tokenized: [], idf: new Map(), loadedAt: Date.now(), lastAccessTimestamp: Date.now(), version: 3 });
    const candidates = store.getCachedVectorCandidates("global");
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates.map((c) => c.id), ["vec-1", "vec-2"]);
    assert.ok(candidates.every((c) => c.norm === 1), "precomputed norms must be reused");
    assert.deepEqual(candidates[0].vector, [1, 0]);

    // Version mismatch (a write happened) → miss → caller falls back to SQL.
    store.scopeVersions.set("global", 4);
    assert.equal(store.getCachedVectorCandidates("global"), null, "version mismatch must be a miss");
    store.scopeVersions.set("global", 3);

    // Age bound exceeded → miss.
    store.scopeCache.get("global").loadedAt = Date.now() - 120_000;
    assert.equal(store.getCachedVectorCandidates("global"), null, "stale-by-age entry must be a miss");
    store.scopeCache.get("global").loadedAt = Date.now();

    // Cache disabled / absent scope → miss.
    const disabled = new MemoryStore("/tmp/omp-unused", { enabled: false });
    disabled.scopeCache.set("global", store.scopeCache.get("global"));
    assert.equal(disabled.getCachedVectorCandidates("global"), null, "disabled cache must be a miss");
    assert.equal(store.getCachedVectorCandidates("other"), null, "absent scope must be a miss");
});

// CACHE_REUSE_DEDUP (perf review): with a warm, fresh cache the no-index
// fallback in findSimilarVectors/findSimilarVectorsBatch must rank from the
// cache — zero table I/O. Mutant (pre-fix): the fallback always runs
// table.query() — a throwing query makes the call return [] instead of the
// cached ranking.
test("store: findSimilarVectors ranks from the warm cache without touching the table (CACHE_REUSE_DEDUP)", async () => {
    const store = new MemoryStore("/tmp/omp-unused", { enabled: true, staleAfterMs: 60_000 });
    store.indexState.vector = false;
    const records = [
        { id: "vec-a", vector: [1, 0], recallCount: 0 },
        { id: "vec-b", vector: [0, 1], recallCount: 0 },
    ];
    const norms = new Map([["vec-a", 1], ["vec-b", 1]]);
    store.scopeVersions.set("global", 0);
    store.scopeCache.set("global", { records, norms, tokenized: [], idf: new Map(), loadedAt: Date.now(), lastAccessTimestamp: Date.now(), version: 0 });
    store.requireTable = () => ({ query: () => { throw new Error("table I/O must not happen when the cache is warm"); } });

    const similar = await store.findSimilarVectors([1, 0], "global", 1);
    assert.equal(similar.length, 1, "top-1 must be ranked from the cache");
    assert.equal(similar[0].id, "vec-a", "most similar cached row must rank first");
    assert.ok(similar[0].score > 0.99, "identical vectors score ~1");

    const batch = await store.findSimilarVectorsBatch([[1, 0], [0, 1]], "global", 1);
    assert.equal(batch.length, 2, "batch must return one ranking per query vector");
    assert.equal(batch[0][0].id, "vec-a", "first batch query ranks vec-a first");
    assert.equal(batch[1][0].id, "vec-b", "second batch query ranks vec-b first");
});

// INDEX_RECHECK_INTERVAL_MS (perf review): ensureIndexes used to run exactly
// once at init, so a store crossing MIN_ROWS_FOR_INDEX mid-process stayed on
// the brute-force fallback until restart. maybeRecheckVectorIndex must be
// throttled (5-min interval), skipped while an index exists or a compaction
// is in flight, and otherwise re-run ensureIndexes. Mutant: removing the
// throttle makes back-to-back calls both fire; removing the method (pre-fix)
// fails outright.
test("store: maybeRecheckVectorIndex is throttled and respects index/compaction state (INDEX_RECHECK_INTERVAL_MS)", async () => {
    const store = new MemoryStore("/tmp/omp-unused", {});
    store.indexState.vector = false;
    store.optimizing = false;
    store.lastIndexCheckAt = 0;
    let ensureCalls = 0;
    store.ensureIndexes = async () => { ensureCalls += 1; };
    await store.maybeRecheckVectorIndex();
    assert.equal(ensureCalls, 1, "first recheck must run ensureIndexes");
    await store.maybeRecheckVectorIndex();
    assert.equal(ensureCalls, 1, "immediate second call must be throttled by the interval");
    store.lastIndexCheckAt = Date.now() - MemoryStore.INDEX_RECHECK_INTERVAL_MS - 1;
    await store.maybeRecheckVectorIndex();
    assert.equal(ensureCalls, 2, "recheck after the interval must run again");

    store.indexState.vector = true;
    store.lastIndexCheckAt = 0;
    await store.maybeRecheckVectorIndex();
    assert.equal(ensureCalls, 2, "no recheck while the vector index already exists");

    store.indexState.vector = false;
    store.optimizing = true;
    store.lastIndexCheckAt = 0;
    await store.maybeRecheckVectorIndex();
    assert.equal(ensureCalls, 2, "no recheck while a compaction is in flight");
});

// INDEX_RECHECK_INTERVAL_MS (perf review): maybeOptimizeAll runs after every
// write path — it must kick the (independently throttled) index recheck so a
// store that grows past MIN_ROWS_FOR_INDEX mid-process gets its ANN index
// without a restart. Mutant (pre-fix): maybeOptimizeAll never calls it.
test("store: maybeOptimizeAll kicks the periodic vector index recheck (INDEX_RECHECK_INTERVAL_MS)", async () => {
    const store = new MemoryStore("/tmp/omp-unused", {});
    let recheckCalls = 0;
    store.maybeRecheckVectorIndex = async () => { recheckCalls += 1; };
    store._maybeOptimizeAll = async () => { };
    await store.maybeOptimizeAll(false);
    assert.equal(recheckCalls, 1, "maybeOptimizeAll must fire the index recheck");
});

// CAPTURE_BUFFER_BOUNDS (1.5.3): the text.complete fragment buffer must be
// bounded on both axes — per-session fragments (a session whose flush keeps
// failing must not accumulate text forever) and retained sessions (a
// session.deleted flush that runs while init is deferred retains its entry
// for retry, so without a cap abandoned sessions leak for process lifetime).
test("capture: recordCaptureFragment caps fragments per session at the last 200 (CAPTURE_BUFFER_BOUNDS)", () => {
    const state = { captureBuffer: new Map() };
    for (let i = 0; i < 250; i += 1) {
        recordCaptureFragment(state, "sess-cap", `fragment-${i}`);
    }
    const fragments = state.captureBuffer.get("sess-cap");
    assert.equal(fragments.length, 200, "fragment list must be capped at 200");
    assert.equal(fragments[0], "fragment-50", "oldest fragments are dropped, not the newest");
    assert.equal(fragments[199], "fragment-249", "newest fragment must survive");
});

test("capture: recordCaptureFragment evicts the oldest session beyond 200 retained (CAPTURE_BUFFER_BOUNDS)", () => {
    const state = { captureBuffer: new Map() };
    for (let i = 0; i < 205; i += 1) {
        recordCaptureFragment(state, `sess-${i}`, `text-${i}`);
    }
    assert.equal(state.captureBuffer.size, 200, "buffer map must be capped at 200 sessions");
    assert.ok(!state.captureBuffer.has("sess-0"), "oldest session must be evicted first");
    assert.ok(state.captureBuffer.has("sess-204"), "newest session must survive");
    assert.deepEqual(state.captureBuffer.get("sess-204"), ["text-204"], "evicted sessions must not corrupt survivors");
});

// MESSAGES_FETCH_ONCE (1.5.3): getLastUserText and runRecallPipeline's
// task-type detection each called client.session.messages — two identical SDK
// round-trips per recall turn. The helpers below are the split that lets the
// transform hook fetch once and reuse the array.
test("recall: fetchSessionMessages unwraps the SDK envelope and returns [] on failure (MESSAGES_FETCH_ONCE)", async () => {
    let calls = 0;
    const client = {
        session: {
            messages: async () => {
                calls += 1;
                return { data: [{ info: { role: "user" }, parts: [] }] };
            },
        },
    };
    const messages = await fetchSessionMessages("sess-1", client);
    assert.equal(calls, 1, "exactly one SDK round-trip");
    assert.equal(messages.length, 1);
    const failing = { session: { messages: async () => { throw new Error("boom"); } } };
    assert.deepEqual(await fetchSessionMessages("sess-2", failing), [], "fetch failure degrades to []");
});

test("recall: lastUserTextFromMessages returns the last non-empty user text (MESSAGES_FETCH_ONCE)", () => {
    const messages = [
        { info: { role: "assistant" }, parts: [{ type: "text", text: "assistant text" }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "  " }, { type: "text", text: "first query" }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "second query" }] },
    ];
    assert.equal(lastUserTextFromMessages(messages), "second query");
    assert.equal(lastUserTextFromMessages([]), "");
    assert.equal(lastUserTextFromMessages([{ info: { role: "user" }, parts: [] }]), "");
});

// RECALL_SEARCH_GUARD (1.6.1): state.store.search was the one unguarded
// LanceDB read in runRecallPipeline — every other store call in the hook
// (embedder, graph boost/expansion, findSimilarTasks, resolveSessionScope) is
// wrapped. A transient store failure propagated out of the system.transform
// hook (no try/catch) and failed the user's chat turn. It now degrades to
// empty results → no injection, and lastRecall is still recorded.
test("recall: store.search failure degrades to no-injection (RECALL_SEARCH_GUARD)", async () => {
    const config = resolveMemoryConfig({}, "/tmp");
    config.graph.enabled = false;
    const state = {
        config,
        initialized: true,
        embedder: { embed: async () => [0.1, 0.2, 0.3] },
        store: {
            search: async () => { throw new Error("lancedb transient failure"); },
            putEvent: async () => { },
            updateMemoryUsage: async () => { },
            findSimilarTasks: async () => [],
        },
        lastRecall: null,
        activeEpisodes: new Map(),
    };
    const eventOutput = { system: [] };
    const input = {
        client: { session: { get: async () => { throw new Error("offline"); } } },
        worktree: "/tmp",
    };
    // Must NOT reject — the chat turn survives a storage hiccup.
    await assert.doesNotReject(
        runRecallPipeline({ sessionID: "sess-r3" }, eventOutput, state, input, "some query", []),
    );
    assert.equal(eventOutput.system.length, 0, "failed search must not inject anything");
    assert.ok(state.lastRecall, "lastRecall must still be recorded for observability");
});

// SIGNAL_TIGHTEN (1.5.3): the expanded POSITIVE_SIGNALS list leaned on generic
// narration verbs ("created", "updated", "configured", "done", ...) that appear
// in nearly every assistant turn, so auto-capture fired on routine descriptions
// of work instead of durable conclusions. Outcome/completion claims must still
// capture; action narration must not.
test("extract: generic narration no longer triggers capture (SIGNAL_TIGHTEN)", () => {
    for (const text of [
        "I created the config file and updated the deployment script.",
        "The build is done and ready to review.",
        "I installed the package and configured the service.",
        "Here's how you can enable the feature.",
        "In summary, we migrated the database.",
    ]) {
        const result = extractCaptureCandidate(text, 20);
        assert.equal(result.candidate, null, `narration must not capture: ${text}`);
        assert.equal(result.skipReason, "no-positive-signal", `narration must hit the signal gate: ${text}`);
    }
});

test("extract: outcome and completion claims still trigger capture (SIGNAL_TIGHTEN)", () => {
    for (const text of [
        "The flaky test is fixed and verified across three runs.",
        "The build passed and the service is operational.",
        "We resolved the port conflict; it works now.",
        "The retry logic was corrected and validated end to end.",
    ]) {
        const result = extractCaptureCandidate(text, 20);
        assert.ok(result.candidate, `outcome claim must capture: ${text}`);
    }
});

// SIGNAL_WORD_BOUNDARY (1.6.2): the capture gate matched signals with
// substring includes() — "passed" matched "bypassed", "fixed" matched
// "prefixed", "solved" matched "unsolved" → false auto-captures on
// narration that merely contained the strings. The gate now requires word
// boundaries, matching GLOBAL_KEYWORD_REGEXES.
test("extract: substring signal words do not fire inside larger words (SIGNAL_WORD_BOUNDARY)", () => {
    for (const text of [
        "The auth check was bypassed for the integration tests.",
        "All generated ids are prefixed with a zone tag.",
        "The flaky suite is still unsolved after several attempts.",
    ]) {
        const result = extractCaptureCandidate(text, 20);
        assert.equal(result.candidate, null, `near-miss must not capture: ${text}`);
        assert.equal(result.skipReason, "no-positive-signal", `near-miss must hit the signal gate: ${text}`);
    }
    for (const text of [
        "The bug is finally fixed.",
        "All tests passed on the first run.",
        "The root cause is solved.",
    ]) {
        const result = extractCaptureCandidate(text, 20);
        assert.ok(result.candidate, `real signal must still capture: ${text}`);
    }
});

// KEY_SENTENCE_FALLBACK (1.6.2): a single sentence longer than targetChars
// with no key-pattern words made both passes break before pushing anything —
// extractKeySentences returned "" and an empty summarized block got injected.
test("summarize: extractKeySentences never returns empty for non-empty input (KEY_SENTENCE_FALLBACK)", () => {
    const long = "This is one extremely long run-on sentence without any of the key signal words that the pattern list looks for anywhere inside of it";
    const out = extractKeySentences(long, 10);
    assert.ok(out.length > 0, "a too-long first sentence must still yield content, not ''");
    assert.ok(out.length <= 13, "the fallback content is truncated to targetChars-ish");
    assert.ok(out.startsWith(long.slice(0, 7)), "the fallback preserves the start of the sentence");
});

// V1_PLUGIN_EXPORT (1.5.4): opencode's plugin loader treats a module whose
// default export is a function as a LEGACY plugin and then calls EVERY
// function export as a plugin factory with (input, options). 1.5.3 added
// `export function appendCaptureFragment` (module namespace exports sort
// alphabetically, so it sorted before "default"), the loader invoked it
// first, it threw (input.captureBuffer undefined), and the real plugin never
// loaded ("failed to load plugin ... state.captureBuffer.get"). The default
// export is now a V1 plugin object ({ id, server }), which the loader detects
// and calls via server(input) only. These tests lock both the V1 shape and
// the legacy-fallback ordering invariant (no function export may sort before
// "default" — hence the recordCaptureFragment name, r > d).
test("plugin: default export is a V1 plugin object with id + server (V1_PLUGIN_EXPORT)", async () => {
    const mod = await import("../dist/index.js");
    const value = mod.default;
    assert.equal(typeof value, "object", "default export must be an object for V1 detection");
    assert.equal(typeof value.id, "string", "V1 file plugins must export a string id");
    assert.ok(value.id.length > 0, "plugin id must be non-empty");
    assert.equal(typeof value.server, "function", "V1 plugin must export server()");
});

// Mirrors opencode's loader getServerPlugin: a function export is itself a
// plugin factory; an object export may carry a server() factory.
function getServerPlugin(value) {
    if (typeof value === "function")
        return value;
    if (!value || typeof value !== "object" || !("server" in value))
        return;
    if (typeof value.server !== "function")
        return;
    return value.server;
}

test("plugin: first export resolves to the server factory (legacy fallback order)", async () => {
    const mod = await import("../dist/index.js");
    const values = Object.values(mod);
    assert.equal(getServerPlugin(values[0]), mod.default.server,
        "first export (alphabetical) must resolve to the server factory");
});

test("plugin: no export before the server factory throws when invoked as a legacy plugin", async () => {
    const mod = await import("../dist/index.js");
    const input = { client: {}, project: {}, worktree: "/tmp", directory: "/tmp" };
    const options = {};
    // The legacy loader calls exports in Object.values order and aborts on the
    // first throw. Walk the same order; anything that throws BEFORE the server
    // factory would break loading exactly like the 1.5.3 regression.
    for (const value of Object.values(mod)) {
        const server = getServerPlugin(value);
        if (server === mod.default.server)
            break;
        if (typeof server !== "function")
            continue;
        try {
            await server(input, options);
        }
        catch (error) {
            assert.fail(`legacy factory export threw before server: ${error.message}`);
        }
    }
});

// RETENTION_SCORING (1.5.5): composite retention score for scope-cache
// truncation. Mutants: dropping the wrong-status -1, the verified bonus, the
// importance term, or the feedback term each make a dedicated assert fail.
const retentionWeights = { recencyHalfLifeHours: 72, importanceWeight: 0.4, feedbackWeight: 0.3 };

function retentionRecord(overrides = {}) {
    return {
        id: "r",
        text: "some memory",
        importance: 0.5,
        timestamp: Date.now(),
        citationStatus: undefined,
        ...overrides,
    };
}

test("store: computeRetentionScore evicts wrong citations first, unconditionally", () => {
    const wrong = computeRetentionScore(retentionRecord({
        importance: 1,
        timestamp: Date.now(),
        citationStatus: "wrong",
    }), undefined, retentionWeights);
    const important = computeRetentionScore(retentionRecord({
        importance: 1,
        timestamp: Date.now(),
        citationStatus: "verified",
    }), undefined, retentionWeights);
    assert.equal(wrong, -1, "wrong citation must score -1 regardless of other fields");
    assert.ok(wrong < important, "wrong must sort below any normal record");
});

test("store: computeRetentionScore boosts verified citations", () => {
    const base = retentionRecord();
    const verified = computeRetentionScore({ ...base, citationStatus: "verified" }, undefined, retentionWeights);
    const pending = computeRetentionScore({ ...base, citationStatus: "pending" }, undefined, retentionWeights);
    assert.ok(verified > pending, "verified must outrank pending");
});

test("store: computeRetentionScore scales with importance", () => {
    const high = computeRetentionScore(retentionRecord({ importance: 1 }), undefined, retentionWeights);
    const low = computeRetentionScore(retentionRecord({ importance: 0 }), undefined, retentionWeights);
    assert.ok(high > low, "more important memory must score higher");
});

test("store: computeRetentionScore applies feedback factor only when weighted", () => {
    const record = retentionRecord();
    const boostedFeedback = { feedbackFactor: 2 };
    const withFeedback = computeRetentionScore(record, boostedFeedback, retentionWeights);
    const without = computeRetentionScore(record, undefined, retentionWeights);
    assert.ok(withFeedback > without, "positive feedback must raise the retention score");
    const zeroWeight = { ...retentionWeights, feedbackWeight: 0 };
    assert.equal(
        computeRetentionScore(record, boostedFeedback, zeroWeight),
        computeRetentionScore(record, undefined, zeroWeight),
        "feedback must be ignored when feedbackWeight is 0",
    );
});

test("store: computeRetentionScore decays recency but keeps a soft floor", () => {
    const now = Date.now();
    const fresh = computeRetentionScore(retentionRecord({ timestamp: now }), undefined, retentionWeights);
    const ancient = computeRetentionScore(retentionRecord({ timestamp: now - 365 * 24 * 60 * 60 * 1000 }), undefined, retentionWeights);
    assert.ok(fresh > ancient, "fresher memory must score higher");
    assert.ok(ancient >= 0.5, "recency floor must keep ancient memories at 0.5, not zero");
});

test("store: computeRetentionScore is deterministic and treats missing fields as neutral", () => {
    const a = computeRetentionScore(retentionRecord({ importance: undefined, timestamp: undefined }), undefined, retentionWeights);
    const b = computeRetentionScore(retentionRecord({ importance: 0.5, timestamp: Date.now() }), undefined, retentionWeights);
    assert.equal(computeRetentionScore(retentionRecord(), undefined, retentionWeights), computeRetentionScore(retentionRecord(), undefined, retentionWeights));
    assert.ok(Number.isFinite(a) && b >= a, "missing importance/timestamp must degrade gracefully");
});

// RETENTION_SCORING (1.5.5): the index.js wiring test seam. The cache must
// receive retention.scoring.* (which defaults from, but can diverge from,
// retrieval.*). Mutant: changing wireRetentionScoring to pass resolved.retrieval
// makes retentionScoringConfig.importanceWeight equal 0.4 and this test fails.
test("store: wireRetentionScoring feeds retention.scoring, not retrieval, into the scope cache (RETENTION_SCORING wiring)", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const store = new MemoryStore(join(mkdtempSync(join(tmpdir(), "wire-ret-")), "lancedb"));
    const cfg = resolveMemoryConfig({
        memory: {
            retrieval: { importanceWeight: 0.4 },
            retention: { scoring: { importanceWeight: 1.5 } },
        },
    }, "/tmp");
    wireRetentionScoring(store, cfg);
    assert.equal(store.retentionScoringConfig, cfg.retention.scoring, "store must hold the resolved retention.scoring object");
    assert.equal(store.retentionScoringConfig.importanceWeight, 1.5, "divergent retention scoring weight must reach the store");
    assert.equal(cfg.retrieval.importanceWeight, 0.4, "retrieval ranking weight must stay untouched");
    // Defensive no-ops: legacy-loader check invokes every export as a plugin
    // with a bare input; a malformed/configless call must never throw.
    wireRetentionScoring({}, {});
    wireRetentionScoring(undefined, cfg);
    wireRetentionScoring(store, {});
});
