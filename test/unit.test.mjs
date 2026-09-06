import test from "node:test";
import assert from "node:assert/strict";

import { extractiveDigest, retentionCandidates, storeFastCosine } from "../dist/store.js";
import { extractEntities, extractTypedRelations } from "../dist/graph.js";
import { resolveMemoryConfig, mergeMemoryConfig } from "../dist/config.js";
import { parseExtractionJSON, extractAssistantText, requestLLMCapture, requestLLMDigest, isOwnSession } from "../dist/llm.js";

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
import { open as fsOpen, mkdtemp, rm as fsRm, readFile, writeFile } from "node:fs/promises";
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
