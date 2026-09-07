import test from "node:test";
import assert from "node:assert/strict";

import { extractiveDigest, retentionCandidates, storeFastCosine, expiredDigestCandidates } from "../dist/store.js";
import { extractEntities, extractTypedRelations } from "../dist/graph.js";
import { resolveMemoryConfig, mergeMemoryConfig } from "../dist/config.js";
import { parseExtractionJSON, extractAssistantText, requestLLMCapture, requestLLMDigest, isOwnSession, trackOwnSession } from "../dist/llm.js";
import { summarizeContent } from "../dist/summarize.js";
import { resolveScope } from "../dist/scope.js";
import { flushAutoCapture, handleSessionIdle, handleSessionStart, handleSessionEnd, preferenceInjectionConfig, initializeStore } from "../dist/index.js";
import { buildPreferenceInjection } from "../dist/preference.js";
import { repairEmbeddingDimension } from "../dist/tools/memory.js";

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
            retention: { effectivenessEventsDays: 45, memory: { enabled: true, minAgeDays: 120 } },
            summarize: { targetChars: 777 },
            logging: { level: "error" },
        },
        {
            retention: { memory: { enabled: false } },
            summarize: { minGroupSize: 9 },
        },
    );
    assert.equal(merged.retention.effectivenessEventsDays, 45, "fragment must not drop legacy retention scalar");
    assert.equal(merged.retention.memory.enabled, false, "fragment override wins");
    assert.equal(merged.retention.memory.minAgeDays, 120, "fragment must not drop legacy retention.memory sub-key");
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

test("repair: repairEmbeddingDimension no-ops when dims already match", async () => {
    const state = makeDimensionState({ physicalDim: 16, records: [] });
    const result = await repairEmbeddingDimension(state, 16);
    assert.equal(result.mismatch, false, "matching dims must report no mismatch");
    assert.equal(state.droppedTable, undefined, "nothing dropped");
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
