// Integration tests: exercise the real LanceDB-backed MemoryStore (vector +
// BM25 hybrid search, events, episodic rows, consolidation, compaction,
// export) in temp directories, and run the full plugin E2E scenario in a
// subprocess (see scenario-e2e.mjs) against a mock Ollama embedder.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

process.env.OPENCODE_MEMORY_PRO_SKIP_SIDECAR = "true";
process.env.OPENCODE_MEMORY_PRO_LOG_LEVEL = "error";

const { MemoryStore, storeFastCosine } = await import("../dist/store.js");

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const DIM = 64;

function hashWord(word) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i += 1) {
        h ^= word.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function deterministicEmbed(text) {
    const vector = new Array(DIM).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
    for (const token of tokens) {
        vector[hashWord(token) % DIM] += 1;
        vector[hashWord(`${token}\x01`) % DIM] += 1;
    }
    const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1;
    return vector.map((x) => x / norm);
}

function makeRecord(id, text, extra = {}) {
    const vector = deterministicEmbed(text);
    return {
        id,
        text,
        vector,
        category: "fact",
        scope: "global",
        importance: 0.7,
        timestamp: Date.now(),
        lastRecalled: 0,
        recallCount: 0,
        projectCount: 0,
        schemaVersion: 1,
        embeddingModel: "test-embed",
        vectorDim: vector.length,
        metadataJson: "{}",
        ...extra,
    };
}

async function newStore(prefix) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const store = new MemoryStore(join(dir, "lancedb"));
    await store.init(DIM);
    return store;
}

const searchParams = (query, queryVector, overrides = {}) => ({
    query,
    queryVector,
    scopes: ["global"],
    limit: 5,
    vectorWeight: 0.7,
    bm25Weight: 0.3,
    minScore: 0.01,
    rrfK: 60,
    recencyBoost: true,
    recencyHalfLifeHours: 72,
    importanceWeight: 0.4,
    feedbackWeight: 0,
    globalDiscountFactor: 1,
    ...overrides,
});

test("integration: MemoryStore full lifecycle on real LanceDB", async () => {
    const store = await newStore("mem-lifecycle-");
    const ids = ["id-1", "id-2", "id-3"];
    const texts = [
        "the memory plugin stores long-term memories in lancedb with vector search",
        "the build pipeline compiles go services and runs postgres for storage",
        "the cat sat on the mat playing with yarn and ignored the database",
    ];
    try {
        for (let i = 0; i < ids.length; i += 1) {
            await store.put(makeRecord(ids[i], texts[i], {
                timestamp: Date.now() - (ids.length - i) * 60_000,
                metadataJson: JSON.stringify({ source: "test", pinned: i === 0 }),
            }));
        }

        const results = await store.search(searchParams("lancedb vector search", deterministicEmbed("lancedb vector search")));
        assert.ok(results.length >= 1, `expected at least one hit, got ${results.length}`);
        assert.equal(results[0].record.id, "id-1", `expected id-1 to rank first, got ${results[0]?.record?.id}`);

        const fallbackBM25Only = await store.search(searchParams("postgres go storage", [], { vectorWeight: 0, bm25Weight: 1 }));
        assert.ok(fallbackBM25Only.some((r) => r.record.id === "id-2"), "bm25-only search should surface id-2");

        assert.equal(await store.hasMemory("id-1", ["global"]), true);
        await store.deleteById("id-1", ["global"]);
        assert.equal(await store.hasMemory("id-1", ["global"]), false);
        const afterDelete = await store.search(searchParams("lancedb vector search", deterministicEmbed("lancedb vector search")));
        assert.ok(!afterDelete.some((r) => r.record.id === "id-1"), "deleted memory must not be searchable");

        await store.updateMemoryScope("id-2", "my-project", ["global"]);
        const projectHits = await store.search(searchParams("postgres go", deterministicEmbed("postgres go"), { scopes: ["my-project"] }));
        assert.ok(projectHits.some((r) => r.record.id === "id-2"), "scope-moved memory searchable in new scope");

        const exported = await store.exportAllRecords(["global", "my-project"]);
        assert.ok(exported.some((r) => r.id === "id-2"), "export must include scope-moved memory");
        assert.ok(exported.some((r) => r.id === "id-3"), "export must include remaining global memory");
    }
    finally {
        store.close();
    }
});

test("integration: fuzzy channel (fuse.js) surfaces typo-tolerant matches", async () => {
    const store = await newStore("mem-fuzzy-");
    const ids = ["fid-1", "fid-2"];
    const texts = [
        "the memory plugin stores long-term memories in lancedb with vector search",
        "the build pipeline compiles go services and runs postgres for storage",
    ];
    try {
        for (let i = 0; i < ids.length; i += 1) {
            await store.put(makeRecord(ids[i], texts[i], { timestamp: Date.now() - (ids.length - i) * 60_000 }));
        }

        // Fuzzy-only isolation: typo must still surface the target.
        const fuzzyOnly = await store.search(searchParams("lancedb vectr srch", [], { vectorWeight: 0, bm25Weight: 0, fuzzyWeight: 1, fuzzyThreshold: 0.5 }));
        assert.ok(fuzzyOnly.some((r) => r.record.id === "fid-1"), "fuzzy-only typo search should surface fid-1");

        // Gibberish with tight threshold yields nothing from the fuzzy channel.
        const gibberish = await store.search(searchParams("zzqxwvbn kkk", [], { vectorWeight: 0, bm25Weight: 0, fuzzyWeight: 1, fuzzyThreshold: 0.5 }));
        assert.equal(gibberish.length, 0, "gibberish must not surface unrelated records (threshold)");

        // Regression: fuzzyWeight=0 keeps existing behavior identical.
        const baseline = await store.search(searchParams("lancedb vector search", deterministicEmbed("lancedb vector search")));
        const noFuzzy = await store.search(searchParams("lancedb vector search", deterministicEmbed("lancedb vector search"), { fuzzyWeight: 0 }));
        assert.equal(noFuzzy[0].record.id, "fid-1", "fuzzy-off search ranks fid-1 first");
        assert.ok(Math.abs(baseline[0].score - noFuzzy[0].score) < 1e-9, "fuzzyWeight=0 must not change scores");

        // bm25-only fallback keeps fuzzy active (embedder down scenario).
        const fallbackFuzzy = await store.search(searchParams("lancedb vectr srch", [], { vectorWeight: 0, bm25Weight: 1, fuzzyWeight: 0.15, fuzzyThreshold: 0.5 }));
        assert.ok(fallbackFuzzy.some((r) => r.record.id === "fid-1"), "fallback bm25+fuzzy should surface typo'd fid-1");
    }
    finally {
        store.close();
    }
});

test("integration: fuzzy index rebuilds after cache invalidation", async () => {
    const store = await newStore("mem-fuzzy-cache-");
    try {
        await store.put(makeRecord("fz-1", "the quick brown fox jumps over the lazy dog", { timestamp: Date.now() }));
        const before = await store.search(searchParams("quik brwn fx", [], { vectorWeight: 0, bm25Weight: 0, fuzzyWeight: 1 }));
        assert.ok(before.some((r) => r.record.id === "fz-1"), "existing record findable via fuzzy");

        await store.put(makeRecord("fz-2", "the serendipitous migration of the otters", { timestamp: Date.now() }));
        const after = await store.search(searchParams("serdipitous migrashun", [], { vectorWeight: 0, bm25Weight: 0, fuzzyWeight: 1 }));
        assert.ok(after.some((r) => r.record.id === "fz-2"), "newly added record must be findable after cache invalidation");
    }
    finally {
        store.close();
    }
});

test("integration: deleteByIdForce removes rows hidden by the status filter", async () => {
    const store = await newStore("mem-forget-force-");
    try {
        const id = "force-id-1";
        await store.put(makeRecord(id, "the force delete test row for hidden status memories"));

        assert.equal(await store.softDeleteMemory(id, ["global"]), true);
        assert.equal(await store.hasMemory(id, ["global"]), false, "soft-deleted row is hidden from active reads");
        assert.equal(await store.deleteById(id, ["global"]), false, "old hard-delete path cannot see disabled rows");
        assert.equal(await store.deleteByIdForce(id), true, "force path removes the hidden row");
        assert.equal(await store.deleteByIdForce(id), false, "row is gone on second attempt");
        assert.equal(await store.hasMemory(id, ["global"]), false, "no active or hidden row remains");

        await store.put(makeRecord(id, "the force delete prefix row"));
        assert.equal(await store.softDeleteMemory(id, ["global"]), true);
        assert.equal(await store.deleteByIdForce(id.slice(0, 10)), true, "force path also matches by id prefix");
    }
    finally {
        store.close();
    }
});

test("integration: events table round-trip and TTL status", async () => {
    const store = await newStore("mem-events-");
    try {
        await store.putEvent({
            id: "evt-1",
            type: "capture",
            outcome: "stored",
            scope: "global",
            sessionID: "sess-1",
            timestamp: Date.now(),
            memoryId: "id-1",
            text: "some captured text",
            metadataJson: JSON.stringify({ source: "test" }),
            sourceSessionId: "sess-1",
        });
        await store.putEvent({
            id: "evt-2",
            type: "feedback",
            feedbackType: "useful",
            scope: "global",
            sessionID: "sess-1",
            timestamp: Date.now(),
            memoryId: "id-1",
            helpful: true,
            reason: "was right",
            labels: ["recall"],
            metadataJson: "{}",
            sourceSessionId: "sess-1",
            relatedMemoryId: "",
        });
        const events = await store.listEvents(["global"], 10);
        assert.ok(events.some((e) => e.id === "evt-1"), "capture event persisted");
        assert.ok(events.some((e) => e.id === "evt-2"), "feedback event persisted");

        const ttl = await store.getEventTtlStatus();
        assert.equal(typeof ttl.enabled, "boolean");

        await store.cleanupExpiredEvents(["global"], 3650);
    }
    finally {
        store.close();
    }
});

test("integration: episodic task lifecycle", async () => {
    const store = await newStore("mem-episodic-");
    const taskId = "task-42";
    try {
        await store.createTaskEpisode({
            id: "ep-1",
            sessionId: "sess-1",
            scope: "global",
            taskId,
            state: "running",
            startTime: Date.now(),
            commandsJson: "[]",
            validationOutcomesJson: "[]",
            successPatternsJson: "[]",
            retryAttemptsJson: "[]",
            recoveryStrategiesJson: "[]",
            metadataJson: "{}",
        });
        await store.updateTaskState(taskId, "failed", "global", "resource", "ECONNREFUSED to 127.0.0.1:8080");
        await store.addCommandToEpisode(taskId, "global", "npm test");
        const episodes = await store.queryTaskEpisodes("global", "failed");
        assert.equal(episodes.length, 1, "failed episode should be queryable");
        assert.ok(episodes[0].commandsJson.includes("npm test"), "command should be appended");
        assert.equal(episodes[0].failureType, "resource");
    }
    finally {
        store.close();
    }
});

test("integration: consolidation merges near-duplicate memories", async () => {
    const store = await newStore("mem-consolidate-");
    const text = "the team decided to use go for backend services and postgres for storage";
    try {
        await store.put(makeRecord("dup-a", text, { timestamp: Date.now() - 60_000 }));
        await store.put(makeRecord("dup-b", text, { timestamp: Date.now() }));
        assert.ok(storeFastCosine(deterministicEmbed(text), deterministicEmbed(text), 1, 1) > 0.99, "sanity: identical texts embed equal");

        const result = await store.consolidateDuplicates("global", 0.9, 10);
        assert.ok(result.mergedPairs >= 1, `expected ≥1 merged pair, got ${JSON.stringify(result)}`);

        const exported = await store.exportAllRecords(["global"]);
        const a = exported.find((r) => r.id === "dup-a");
        const b = exported.find((r) => r.id === "dup-b");
        assert.ok(a, "old record must still exist");
        assert.ok(b, "newer record must still exist");
        assert.equal(a.status, "merged", "older record should be marked merged");
        assert.ok(b.metadataJson.includes("mergedFrom"), "newer record should record mergedFrom");
    }
    finally {
        store.close();
    }
});

test("integration: dedup write-check primitive returns cosine in [0,1] (not RRF)", async () => {
    const store = await newStore("mem-dedupcos-");
    const text = "the team decided to use go for backend services and postgres for storage";
    try {
        await store.put(makeRecord("dup-a", text, { timestamp: Date.now() - 60_000 }));
        await store.put(makeRecord("dup-b", text, { timestamp: Date.now() }));

        // findSimilarVectors is what storeCapturedMemory now calls for the
        // write-time dedup check: raw cosine, bounded to [0,1].
        const similar = await store.findSimilarVectors(deterministicEmbed(text), "global", 1);
        assert.ok(similar.length === 1, "top-1 similar should be returned");
        assert.ok(similar[0].score <= 1.0001, `cosine must not exceed 1, got ${similar[0].score}`);
        assert.ok(similar[0].score > 0.99, `identical texts should score near 1, got ${similar[0].score}`);

        // Regression guard: the old write-check went through search() with
        // vectorWeight=1/bm25=0/limit=1, whose RRF score is algebraically
        // >= 1.0 regardless of similarity — the exact bug this fixed.
        const rrf = await store.search({
            query: text,
            queryVector: deterministicEmbed(text),
            scopes: ["global"],
            limit: 1,
            vectorWeight: 1.0,
            bm25Weight: 0.0,
            minScore: 0.0,
            rrfK: 60,
            recencyBoost: false,
            globalDiscountFactor: 1.0,
        });
        assert.ok(rrf.length === 1 && rrf[0].score >= 1.0, "RRF score >= 1.0 (bug signature)");
    }
    finally {
        store.close();
    }
});

test("integration: consolidation clears false isPotentialDuplicate flags", async () => {
    const store = await newStore("mem-flagclear-");
    try {
        await store.put(makeRecord("flagged-1", "quantum entanglement photosynthesis ziggurat", {
            metadataJson: JSON.stringify({ isPotentialDuplicate: true, duplicateOf: "whatever" }),
        }));
        await store.put(makeRecord("unrelated-1", "the team decided to use go for backend services and postgres for storage"));

        const result = await store.consolidateDuplicates("global", 0.99, 10);
        assert.equal(result.mergedPairs, 0, "dissimilar rows must not merge");
        assert.ok(result.clearedFlags >= 1, `expected >=1 cleared flag, got ${JSON.stringify(result)}`);

        const exported = await store.exportAllRecords(["global"]);
        const flagged = exported.find((r) => r.id === "flagged-1");
        assert.ok(flagged, "flagged row must still exist");
        assert.ok(!flagged.metadataJson.includes("isPotentialDuplicate"), "flag must be cleared");
    }
    finally {
        store.close();
    }
});

test("integration: scope cache reloads after age bound (cross-process staleness)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-cachettl-"));
    const store = new MemoryStore(join(dir, "lancedb"), { staleAfterMs: 10 });
    try {
        await store.init(DIM);
        await store.put(makeRecord("ttl-1", "cached memory about caching and staleness"));
        const before = await store.search(searchParams("cached memory staleness", deterministicEmbed("cached memory staleness")));
        assert.ok(before.some((r) => r.record.id === "ttl-1"), "record visible through the cache");

        // Simulate another process writing to the shared store: delete the row
        // through the table directly, bypassing invalidateScope (this process's
        // version counter is not bumped, which is exactly the cross-process gap).
        await store.requireTable().delete("id = 'ttl-1'");
        await new Promise((resolve) => setTimeout(resolve, 30));

        const after = await store.search(searchParams("cached memory staleness", deterministicEmbed("cached memory staleness")));
        assert.ok(!after.some((r) => r.record.id === "ttl-1"), "stale cache entry must be reloaded after the age bound");
    }
    finally {
        store.close();
    }
});

test("integration: forced compaction is safe on a fresh store", async () => {
    const store = await newStore("mem-compact-");
    try {
        await store.put(makeRecord("id-1", "some memory about compaction and version pruning"));
        await store.maybeOptimizeAll(true);
        const results = await store.search(searchParams("compaction versions", deterministicEmbed("compaction versions")));
        assert.ok(results.some((r) => r.record.id === "id-1"), "store still searchable after compaction");
    }
    finally {
        store.close();
    }
});

test("integration: dimension-mismatch is detected on init, and repair rebuilds the table at the new dimension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-dimmismatch-"));
    const dbPath = join(dir, "lancedb");

    // Phase 1: create the store at DIM and write some real memories.
    const store1 = new MemoryStore(dbPath);
    await store1.init(DIM);
    try {
        await store1.put(makeRecord("dim-1", "first memory before the embedding model switch"));
        await store1.put(makeRecord("dim-2", "second memory before the embedding model switch"));
        await store1.put(makeRecord("dim-3", "third memory in a different scope", { scope: "proj-x" }));
        await store1.updateMemoryScope("dim-3", "proj-x", ["global"]).catch(() => { });

        const health1 = store1.getIndexHealth();
        assert.equal(health1.dimensionMismatch, false, "freshly created table matches its own dimension");
        assert.equal(health1.expectedDim, DIM);
        assert.equal(health1.actualDim, DIM);
    }
    finally {
        store1.close();
    }

    // Phase 2: reopen the SAME store, simulating a switch to a smaller-dim
    // embedder (init()'s vectorDim argument is what a live embedder.dim()
    // probe would have returned under the new model).
    const NEW_DIM = 8;
    const store2 = new MemoryStore(dbPath);
    await store2.init(NEW_DIM);
    try {
        const health2 = store2.getIndexHealth();
        assert.equal(health2.dimensionMismatch, true, "opening an existing table with a different embedder dim must be flagged");
        assert.equal(health2.expectedDim, DIM, "expectedDim reports the table's real physical width");
        assert.equal(health2.actualDim, NEW_DIM, "actualDim reports what the current embedder just probed");
        assert.equal(await store2.getPhysicalVectorDim(), DIM);

        // Repair, mirroring exactly what the memory_reembed tool does.
        const scopes = await store2.listDistinctScopes();
        assert.ok(scopes.includes("global") && scopes.includes("proj-x"), "must discover every scope, not just one");
        const records = await store2.exportAllRecords(scopes);
        assert.equal(records.length, 3, "must export every row across every scope before rebuilding");
        const idsBefore = records.map((r) => r.id).sort();

        await store2.connection.dropTable("memories");
        store2.table = null;
        await store2.init(NEW_DIM);

        for (const record of records) {
            const vector = deterministicEmbed(record.text).slice(0, NEW_DIM);
            await store2.put({ ...record, vector, vectorDim: vector.length, embeddingModel: "test-embed-new" });
        }

        assert.equal(await store2.getPhysicalVectorDim(), NEW_DIM, "table must be physically rebuilt at the new dimension");
        assert.equal(store2.getIndexHealth().dimensionMismatch, false, "post-repair health must report no mismatch");

        const afterScopes = await store2.listDistinctScopes();
        const afterRecords = await store2.exportAllRecords(afterScopes);
        assert.deepEqual(afterRecords.map((r) => r.id).sort(), idsBefore, "every original id must survive the rebuild");
        assert.ok(afterRecords.every((r) => r.vector.length === NEW_DIM), "every row must carry a vector at the new dimension");
        assert.ok(afterRecords.find((r) => r.id === "dim-1").text.includes("first memory"), "original text must be preserved");
    }
    finally {
        store2.close();
    }
});

test("integration: plugin E2E scenario (subprocess)", async () => {
    const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["test/scenario-e2e.mjs"], {
            cwd: repoRoot,
            env: { ...process.env, OPENCODE_MEMORY_PRO_SKIP_SIDECAR: "true" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`E2E scenario timed out after 120s\nstdout:\n${stdout}\nstderr:\n${stderr}`));
        }, 120_000);
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
    assert.equal(result.code, 0, `E2E scenario exited ${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const marker = result.stdout.match(/E2E_OK (.+)/s);
    assert.ok(marker, `E2E_OK marker missing from output:\n${result.stdout}\n${result.stderr}`);
    const summary = JSON.parse(marker[1]);
    assert.equal(summary.provider, "opencode-memory-pro");
    assert.equal(summary.searchFound, true);
    assert.equal(summary.autoCaptured, true);
    assert.equal(summary.episodeSuccessful, true);
    assert.ok(summary.recentCount >= 2, `expected ≥2 memories, got ${summary.recentCount}`);
});