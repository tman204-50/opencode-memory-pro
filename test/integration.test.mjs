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