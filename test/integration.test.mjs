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
const { initializeStore } = await import("../dist/index.js");
const { resolveMemoryConfig } = await import("../dist/config.js");

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
        // Tolerance is 1e-6, not exact equality: the two searches call
        // computeRecencyMultiplier → Date.now() ms apart, and recency decay
        // moves the score ~1.7e-9 per elapsed ms — a 1e-9 tolerance was a
        // ~50% flake whenever the two clock reads straddled a ms boundary.
        const baseline = await store.search(searchParams("lancedb vector search", deterministicEmbed("lancedb vector search")));
        const noFuzzy = await store.search(searchParams("lancedb vector search", deterministicEmbed("lancedb vector search"), { fuzzyWeight: 0 }));
        assert.equal(noFuzzy[0].record.id, "fid-1", "fuzzy-off search ranks fid-1 first");
        assert.ok(Math.abs(baseline[0].score - noFuzzy[0].score) < 1e-6, "fuzzyWeight=0 must not change scores (beyond clock drift)");

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

// TOOL_DELETE_FORCE (1.5.2): memory_delete used store.deleteById, whose
// status-filtered read cannot see disabled rows — so a memory that was
// soft-deleted first could never be permanently deleted through the tool
// (it returned "not found in current scope" forever). memory_forget got the
// deleteByIdForce fix in 1.3.8; memory_delete was missed. This test drives
// the real tool wiring so a revert to deleteById fails the suite.
test("integration: memory_delete tool hard-deletes rows hidden by the status filter", async () => {
    const store = await newStore("mem-tool-del-force-");
    const { createMemoryTools } = await import("../dist/tools/memory.js");
    const state = {
        initialized: false,
        config: { embedding: { provider: "test" } },
        store,
        ensureInitialized: async () => { state.initialized = true; },
    };
    const tools = createMemoryTools(state);
    const context = { directory: "/tmp", sessionID: "test-session" };
    try {
        const id = "tool-del-1";
        await store.put(makeRecord(id, "the memory_delete tool hard delete test row"));

        assert.match(
            await tools.memory_delete.execute({ id, confirm: false }, context),
            /Rejected/,
            "confirm guard still applies",
        );

        assert.equal(await store.softDeleteMemory(id, ["global"]), true);
        assert.equal(await store.hasMemory(id, ["global"]), false, "soft-deleted row hidden from active reads");

        const result = await tools.memory_delete.execute({ id, confirm: true }, context);
        assert.match(result, /Deleted memory/, `tool should report deletion, got: ${result}`);
        assert.equal(await store.hasMemory(id, ["global"]), false, "no active row remains");
        assert.equal(await store.deleteByIdForce(id), false, "row is physically gone (force path finds nothing)");
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

test("integration: poisoned feedback event cannot break readEventsByScopes", async () => {
    const store = await newStore("mem-evtg-");
    try {
        await store.putEvent({
            id: "evt-ok",
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
        });
        // EVENT_JSON_PARSE_GUARD: a legacy/lossy write left non-JSON text in
        // the STRING columns labelsJson/context. readEventsByScopes must
        // survive and degrade the row instead of throwing for the table.
        await store.requireEventTable().add([{
            id: "evt-bad",
            type: "feedback",
            scope: "global",
            sessionID: "sess-1",
            timestamp: Date.now(),
            memoryId: "id-2",
            text: "",
            outcome: "",
            skipReason: "",
            resultCount: 0,
            injected: false,
            source: "",
            feedbackType: "useful",
            helpful: 1,
            reason: "legacy",
            labelsJson: "not-json",
            metadataJson: "{}",
            sourceSessionId: "",
            confidenceDelta: null,
            relatedMemoryId: "",
            context: "also-not-json",
        }]);

        const events = await store.readEventsByScopes(["global"]);
        assert.equal(events.length, 2, "both events must be returned");
        const ok = events.find((e) => e.id === "evt-ok");
        const bad = events.find((e) => e.id === "evt-bad");
        assert.deepEqual(ok?.labels, ["recall"], "healthy labels round-trip");
        assert.equal(ok?.helpful, true, "healthy helpful round-trips");
        assert.deepEqual(bad?.labels, [], "unparseable labelsJson degrades to []");
        assert.equal(bad?.context, undefined, "unparseable context degrades to undefined");

        const summary = await store.summarizeEvents("global", false);
        assert.equal(summary.feedback.useful.positive, 2, "summarizeEvents survives the poisoned row");
    }
    finally {
        store.close();
    }
});

test("integration: concurrent episode appends all survive (EPISODE_WRITE_LOCK)", async () => {
    const store = await newStore("mem-eplock-");
    const taskId = "lock-task";
    try {
        await store.createTaskEpisode({
            id: "ep-lock",
            sessionId: "sess-lock",
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
        // EPISODE_WRITE_LOCK: overlapping tool.execute.after invocations must
        // not lose appends — previously the unlocked read-modify-write dropped
        // every append that raced (19/20 lost under 20 concurrent calls).
        await Promise.all(Array.from({ length: 10 }, (_, i) =>
            store.addCommandToEpisode(taskId, "global", `cmd-${i}`)));
        await Promise.all(Array.from({ length: 10 }, (_, i) =>
            store.addRetryAttempt(taskId, "global", { outcome: "failed", errorMessage: `err-${i}` })));
        await Promise.all(Array.from({ length: 10 }, (_, i) =>
            store.addSuccessPatterns(taskId, "global", [{ commands: [`pat-${i}`], tools: [], confidence: 0.5, extractedAt: Date.now() }])));

        const ep = await store.getTaskEpisode(taskId, "global");
        const commands = JSON.parse(ep.commandsJson || "[]");
        const retries = JSON.parse(ep.retryAttemptsJson || "[]");
        const patterns = JSON.parse(ep.successPatternsJson || "[]");
        assert.equal(commands.length, 10, `all 10 concurrent command appends must survive, got ${commands.length}`);
        assert.equal(retries.length, 10, `all 10 concurrent retry appends must survive, got ${retries.length}`);
        assert.equal(patterns.length, 10, `all 10 concurrent pattern appends must survive, got ${patterns.length}`);
        assert.deepEqual(retries.map((r) => r.attemptNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], "attemptNumbers assigned sequentially under the lock");
    }
    finally {
        store.close();
    }
});

test("integration: concurrent updateMemoryUsage calls all count (MEMORY_USAGE_LOCK)", async () => {
    const store = await newStore("mem-usagelock-");
    try {
        await store.put(makeRecord("mem-hot", "a globally recalled memory", {
            scope: "global",
            metadataJson: JSON.stringify({ source: "test", isPotentialDuplicate: false }),
        }));
        // index.js fires one updateMemoryUsage per recall result, fire-and-forget
        // (.catch(() => {})), so concurrent calls race on the same row's
        // read-modify-write. Previously 9/10 were lost (last-write-wins).
        await Promise.all(Array.from({ length: 10 }, (_, i) =>
            store.updateMemoryUsage("mem-hot", `project:000${i}`, ["global"]).catch(() => { })));

        const row = (await store.readByScopes(["global"])).find((r) => r.id === "mem-hot");
        assert.equal(row.recallCount, 10, `all 10 concurrent updates must count, got ${row.recallCount}`);
        assert.equal(row.projectCount, 10, `all 10 distinct project scopes must register, got ${row.projectCount}`);
        const meta = JSON.parse(row.metadataJson);
        assert.equal((meta.recalledProjects ?? []).length, 10, "all recalledProjects entries must survive the race");
        assert.equal(meta.source, "test", "existing metadata must be preserved (METADATA_MERGE_FIX)");
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

test("integration: suggestRecoveryStrategies parses commandsJson as JSON string", async () => {
    const store = await newStore("mem-recovery-");
    try {
        for (let i = 1; i <= 3; i += 1) {
            const taskId = `build-api-${i}`;
            await store.createTaskEpisode({
                id: `fail-${i}`,
                sessionId: `sess-${i}`,
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
            await store.addCommandToEpisode(taskId, "global", "npm run build:broken");
            await store.updateTaskState(taskId, "failed", "global", "runtime", "error TS2307: module not found");
        }
        await store.createTaskEpisode({
            id: "ep-ok",
            sessionId: "sess-ok",
            scope: "global",
            taskId: "build-api",
            state: "running",
            startTime: Date.now(),
            commandsJson: "[]",
            validationOutcomesJson: "[]",
            successPatternsJson: "[]",
            retryAttemptsJson: "[]",
            recoveryStrategiesJson: "[]",
            metadataJson: "{}",
        });
        await store.addCommandToEpisode("build-api", "global", "npm run build");
        await store.updateTaskState("build-api", "success", "global");

        const strategies = await store.suggestRecoveryStrategies("global", "build-api-1");
        const primary = strategies.find((s) => s.reason === "Similar task succeeded with this approach");
        assert.ok(primary, "expected a strategy derived from the similar success episode");
        assert.ok(
            primary.strategy.startsWith("Try: npm run build"),
            `strategy should name the real first command, got ${JSON.stringify(primary.strategy)}`,
        );
        assert.ok(!primary.strategy.includes("["), "strategy must not leak raw JSON syntax");
    }
    finally {
        store.close();
    }
});

test("integration: tags round-trips through put() and a poisoned tags row cannot break reads", async () => {
    const store = await newStore("mem-tags-");
    try {
        // TAGS_SERIALIZE: array in → JSON string stored → array out on read.
        await store.put(makeRecord("tags-ok", "tags round trip through the chokepoint", {
            tags: ["sqlite", "backup"],
        }));
        const ok = (await store.readByScopes(["global"])).find((r) => r.id === "tags-ok");
        assert.deepEqual(ok?.tags, ["sqlite", "backup"], `tags should round-trip as an array, got ${JSON.stringify(ok?.tags)}`);

        // Legacy/lossy write path: a non-JSON string lands in the tags column
        // (the old array→Array.prototype.toString coercion). TAGS_PARSE_GUARD:
        // readByScopes must survive and degrade the row's tags to undefined.
        await store.requireTable().add([{
            ...makeRecord("tags-bad", "poisoned legacy tags row"),
            tags: "sqlite,backup",
            status: "active",
            id: "tags-bad",
        }]);
        const rows = await store.readByScopes(["global"]);
        const bad = rows.find((r) => r.id === "tags-bad");
        assert.ok(bad, "poisoned row must survive readByScopes instead of throwing");
        assert.equal(bad.tags, undefined, "unparseable tags degrade to undefined");
        assert.ok(rows.some((r) => r.id === "tags-ok"), "healthy row still readable alongside the poisoned one");
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

// SURVIVOR_MERGE_FIX (1.5.6): a canonical copy that survived a previous merge
// carries metadataJson.mergedFrom — the SURVIVOR mark, not a merged-away mark.
// The b-side guard treated mergedFrom as "already merged", so survivors were
// permanently immune: every ≥0.95 duplicate cluster where both sides had
// mergedFrom was skipped forever (live: 6031 qualifying pairs, zero writes).
// The fix only blocks status:"merged" (the row that actually lost a merge).
test("integration: merge survivor absorbs new duplicate (SURVIVOR_MERGE_FIX)", async () => {
    const store = await newStore("mem-survivor-");
    const text = "the deployment workflow is edit code, run tests, repackage, and restart the plugin";
    try {
        // Two rows that have BOTH survived an earlier merge (metadataJson
        // carries mergedFrom) with the same text — the exact live-store shape
        // that deadlocked, whichever row ended up as candidate b.
        await store.put(makeRecord("sur-a", text, {
            timestamp: Date.now() - 60_000,
            metadataJson: JSON.stringify({ mergedFrom: "older-absorber-1", source: "llm-capture" }),
        }));
        await store.put(makeRecord("sur-b", text, {
            timestamp: Date.now(),
            metadataJson: JSON.stringify({ mergedFrom: "older-absorber-2", source: "llm-capture" }),
        }));

        const result = await store.consolidateDuplicates("global", 0.9, 10);
        assert.ok(result.mergedPairs >= 1, `survivor+survivor must merge, got ${JSON.stringify(result)}`);

        const exported = await store.exportAllRecords(["global"]);
        const older = exported.find((r) => r.id === "sur-a");
        const newer = exported.find((r) => r.id === "sur-b");
        assert.ok(older && newer, "both rows must still exist");
        assert.equal(older.status, "merged", "older survivor must be absorbed");
        assert.ok(newer.metadataJson.includes("mergedFrom"), "newer survivor keeps provenance");
    }
    finally {
        store.close();
    }
});

// CLEAR_SCOPE_COUNT_ALL (1.4.6): clearScope read visible rows only but deleted
// ALL rows in the scope — the returned count undercounted whenever
// merged/digested rows were present, and their graph nodes were never notified.
test("integration: clearScope counts and removes all rows including merged (CLEAR_SCOPE_COUNT_ALL)", async () => {
    const store = await newStore("mem-clearscope-");
    const text = "the team decided to use go for backend services and postgres for storage";
    try {
        await store.put(makeRecord("cs-a", text, { timestamp: Date.now() - 60_000 }));
        await store.put(makeRecord("cs-b", text, { timestamp: Date.now() }));
        const result = await store.consolidateDuplicates("global", 0.9, 10);
        assert.ok(result.mergedPairs >= 1, `expected ≥1 merged pair, got ${JSON.stringify(result)}`);
        assert.equal((await store.readByScopes(["global"])).length, 1, "sanity: merged row is hidden from visible reads");
        assert.equal((await store.readByScopesIncludingMerged(["global"])).length, 2, "sanity: both rows still on disk");

        const cleared = await store.clearScope("global");
        assert.equal(cleared, 2, "count must include merged rows the delete actually removes");
        assert.equal((await store.readByScopesIncludingMerged(["global"])).length, 0, "no rows survive clearScope");
    }
    finally {
        store.close();
    }
});

// PRUNE_SCOPE_BATCH_DELETE (1.4.6): pruneScope used one delete round trip per
// row; the batched id IN (...) delete must preserve the same selection
// semantics (flagged oldest first) and remove exactly the over-cap rows.
test("integration: pruneScope removes over-cap entries flagged-first via batched delete (PRUNE_SCOPE_BATCH_DELETE)", async () => {
    const store = await newStore("mem-prunebatch-");
    try {
        for (let i = 0; i < 5; i++) {
            const flagged = i < 2; // the two oldest rows are flagged duplicates
            await store.put(makeRecord(`prune-${i}`, `prune batch row number ${i} with some text`, {
                timestamp: Date.now() - (100 - i) * 1000,
                metadataJson: JSON.stringify(flagged ? { isPotentialDuplicate: true } : {}),
            }));
        }
        const pruned = await store.pruneScope("global", 3);
        assert.equal(pruned, 2, "over-cap rows (the two flagged oldest) must be pruned");
        const survivors = await store.readByScopesIncludingMerged(["global"]);
        assert.equal(survivors.length, 3, "exactly maxEntries rows remain");
        const ids = survivors.map((r) => r.id).sort();
        assert.deepEqual(ids, ["prune-2", "prune-3", "prune-4"], "flagged oldest rows removed, unflagged survive");
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

// CACHE_TTL_DEFAULT (1.4.8): the default staleness bound was 60s — shorter
// than a turn gap — so with per-put invalidation every recall rebuilt the
// scope (observed 14/14 + 17/17 cacheMiss). The default is now 10 minutes;
// an entry aged 5 minutes must still HIT under the default config. Mutant:
// reverting the default to 60 * 1000 makes this a miss and the test fails.
test("integration: scope cache hits within the default staleness bound", async () => {
    const store = await newStore("mem-cachehit-");
    try {
        await store.put(makeRecord("cachehit-1", "cache hit regression memory about recall speed"));
        await store.search(searchParams("cache hit regression", deterministicEmbed("cache hit regression")));
        const entry = store.scopeCache.get("global");
        assert.ok(entry, "scope cache entry must exist after the first search");
        entry.loadedAt = Date.now() - 5 * 60 * 1000;
        entry.lastAccessTimestamp = entry.loadedAt;
        const hitsBefore = store.cacheStats.hits;
        await store.search(searchParams("cache hit regression", deterministicEmbed("cache hit regression")));
        assert.equal(store.cacheStats.hits, hitsBefore + 1, "entry aged 5 minutes must be a cache HIT under the 10-minute default");
    }
    finally {
        store.close();
    }
});

// CACHE_PATCH_USAGE (1.4.9): updateMemoryUsage called invalidateScope on
// every recall result, so in active sessions (auto-recall fires per LLM
// request) the scope cache never survived one round — every getCachedScopes
// paid a full rebuild (observed 20+/20+ cacheMiss live, recall.pipeline
// 1279-1570ms vs the 630-880ms clean baseline). Usage fields are not used by
// _search scoring, so the write now patches the cached record in place and
// the cache stays hot. Mutant: restoring `this.invalidateScope(match.scope)`
// makes the second search a miss and this test fails.
test("integration: updateMemoryUsage patches the scope cache without invalidating (CACHE_PATCH_USAGE)", async () => {
    const store = await newStore("mem-cachepatch-");
    try {
        await store.put(makeRecord("usage-1", "usage updates must keep the scope cache hot"));
        await store.search(searchParams("usage updates keep hot", deterministicEmbed("usage updates keep hot")));
        const entry = store.scopeCache.get("global");
        assert.ok(entry, "scope cache entry must exist after the first search");
        const hitsBefore = store.cacheStats.hits;
        await store.updateMemoryUsage("usage-1", "project:probe", ["global"]);
        const results = await store.search(searchParams("usage updates keep hot", deterministicEmbed("usage updates keep hot")));
        assert.equal(store.cacheStats.hits, hitsBefore + 1, "second search must be a cache HIT (no invalidation)");
        assert.ok(results.some((r) => r.record.id === "usage-1"), "memory must still be searchable after the usage update");
        const cachedRecord = entry.records.find((r) => r.id === "usage-1");
        assert.ok(cachedRecord, "cached record must exist in the entry");
        assert.equal(cachedRecord.recallCount, 1, "cached record must reflect the bumped usage in place");
        assert.ok(cachedRecord.lastRecalled > 0, "cached record must have lastRecalled stamped");
        const dbRow = (await store.readByScopes(["global"])).find((r) => r.id === "usage-1");
        assert.equal(dbRow.recallCount, 1, "DB row must still be updated (table.update preserved)");
    }
    finally {
        store.close();
    }
});

// FEEDBACK_STATS_CACHE (perf review): getMemoryFeedbackStatsMap was
// refactored to cache the events-table aggregate per scope (invalidated by
// invalidateFeedbackStats, called from _putEvent) instead of re-querying
// with a fresh memoryId-bounded filter on every search. Comparing the SAME
// record's score across two searches that only differ in feedbackWeight
// isolates the feedbackFactor multiplier exactly (rank/rrfScore/recency/
// importance/scope factors are identical between the two calls), so this
// verifies both the formula end-to-end through the new cached path and that
// a new feedback event invalidates the cache immediately (no stale reads).
test("integration: feedback weighting applies the correct multiplier and the stats cache invalidates on new events (FEEDBACK_STATS_CACHE)", async () => {
    const store = await newStore("mem-feedback-");
    try {
        const text = "shared topic for feedback weighting test";
        const vector = deterministicEmbed(text);
        await store.put(makeRecord("mem-good", text));
        // 2x useful+helpful -> helpfulRate=1, wrongPenalty=0 -> feedbackFactor = 1 + (1-0.5)*2 - 0 = 2
        await store.putEvent({
            id: "evt-fb-1", type: "feedback", feedbackType: "useful", scope: "global",
            sessionID: "s", timestamp: Date.now(), memoryId: "mem-good", helpful: true, metadataJson: "{}",
        });
        await store.putEvent({
            id: "evt-fb-2", type: "feedback", feedbackType: "useful", scope: "global",
            sessionID: "s", timestamp: Date.now(), memoryId: "mem-good", helpful: true, metadataJson: "{}",
        });
        const baseParams = searchParams(text, vector, { feedbackWeight: 0, minScore: 0 });
        const boostedParams = searchParams(text, vector, { feedbackWeight: 1, minScore: 0 });
        const baseScore = (await store.search(baseParams)).find((r) => r.record.id === "mem-good").score;
        const boostedScore = (await store.search(boostedParams)).find((r) => r.record.id === "mem-good").score;
        assert.ok(Math.abs(boostedScore / baseScore - 2) < 1e-6, `expected exactly 2x boost, got base=${baseScore} boosted=${boostedScore} ratio=${boostedScore / baseScore}`);
        // Add a "wrong" event for the same memory: helpfulRate stays 1 (still
        // 2 helpful/0 unhelpful), but wrongPenalty=min(0.3,0.1)=0.1, so the
        // new factor is 1 + (1-0.5)*2 - 0.1 = 1.9. The search above already
        // populated the per-scope feedback cache; this write must bump the
        // version so the very next search recomputes instead of reusing the
        // stale 2.0x aggregate.
        await store.putEvent({
            id: "evt-fb-3", type: "feedback", feedbackType: "wrong", scope: "global",
            sessionID: "s", timestamp: Date.now(), memoryId: "mem-good", metadataJson: "{}",
        });
        const boostedScore2 = (await store.search(boostedParams)).find((r) => r.record.id === "mem-good").score;
        assert.ok(Math.abs(boostedScore2 / baseScore - 1.9) < 1e-6, `expected updated 1.9x factor after new feedback (cache must not serve stale stats), got base=${baseScore} boosted2=${boostedScore2} ratio=${boostedScore2 / baseScore}`);
    }
    finally {
        store.close();
    }
});

// FEEDBACK_SCAN_BOUND (1.5.8-post): computeFeedbackStatsForScope used the
// global SCAN_LIMIT (5M default) on every feedback-cache miss/stale window,
// so a recall turn could stall scanning effectiveness_events.lance for
// seconds. The per-instance bound must cap how many feedback rows are
// aggregated (newest-first). Seeding 3 events with the bound=2 and a stale
// cache forces a recompute; the oldest (the "wrong") must be dropped, so the
// factor is the 2x helpful-only rate, not 1.9x.
test("integration: feedback stats scan honors the per-instance bound (FEEDBACK_SCAN_BOUND)", async () => {
    process.env.OPENCODE_MEMORY_PRO_FEEDBACK_STATS_SCAN_LIMIT = "2";
    const store = await newStore("mem-fb-bound-");
    delete process.env.OPENCODE_MEMORY_PRO_FEEDBACK_STATS_SCAN_LIMIT;
    try {
        const text = "bounded feedback scan probe";
        const vector = deterministicEmbed(text);
        await store.put(makeRecord("mem-fb-b", text));
        const base = Date.now() - 60 * 1000;
        await store.putEvent({ id: "evt-fb-b1", type: "feedback", feedbackType: "wrong", scope: "global", sessionID: "s", timestamp: base, memoryId: "mem-fb-b", metadataJson: "{}" });
        await store.putEvent({ id: "evt-fb-b2", type: "feedback", feedbackType: "useful", scope: "global", sessionID: "s", timestamp: base + 1, memoryId: "mem-fb-b", helpful: true, metadataJson: "{}" });
        await store.putEvent({ id: "evt-fb-b3", type: "feedback", feedbackType: "useful", scope: "global", sessionID: "s", timestamp: base + 2, memoryId: "mem-fb-b", helpful: true, metadataJson: "{}" });
        const boostedParams = searchParams(text, vector, { feedbackWeight: 1, minScore: 0 });
        const boostedScore = (await store.search(boostedParams)).find((r) => r.record.id === "mem-fb-b").score;
        const baseParams = searchParams(text, vector, { feedbackWeight: 0, minScore: 0 });
        const baseScore = (await store.search(baseParams)).find((r) => r.record.id === "mem-fb-b").score;
        assert.ok(Math.abs(boostedScore / baseScore - 2) < 1e-6, `bound=2 must drop the oldest (wrong) event; expected 2x, got ${boostedScore / baseScore}`);
    }
    finally {
        store.close();
    }
});
// NEWEST records, so an old-but-valuable memory (important, verified,
// positively fed back) was silently dropped from search the moment enough
// newer records landed. With retention weights configured, the survivors are
// the top-N by a composite retention score. Mutant: reverting the truncation
// sort to a bare timestamp sort drops rt-gold (oldest) and keeps all three
// fresh trash records, failing the gold-present and trash-absent asserts.
test("integration: scope cache truncation keeps high-retention records over newer ones (RETENTION_SCORING)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-retention-"));
    const store = new MemoryStore(join(dir, "lancedb"), { maxRecordsPerScope: 3 });
    store.setRetentionScoringConfig({ recencyHalfLifeHours: 72, importanceWeight: 1.5, feedbackWeight: 0.5 });
    try {
        await store.init(DIM);
        const now = Date.now();
        const old = now - 365 * 24 * 60 * 60 * 1000;
        await store.put(makeRecord("rt-gold", "the golden rule: never delete the build cache and always pin dependencies", {
            importance: 1,
            citationStatus: "verified",
            timestamp: old,
        }));
        await store.put(makeRecord("rt-old-trash", "old scribbles about pizza toppings and nap schedules", {
            importance: 0,
            timestamp: old - 1000,
        }));
        await store.put(makeRecord("rt-new-trash-1", "ephemeral note about what to reorder for the fridge", {
            importance: 0.3,
            timestamp: now - 1000,
        }));
        await store.put(makeRecord("rt-new-trash-2", "another ephemeral note about printer paper", {
            importance: 0.3,
            timestamp: now - 2000,
        }));
        await store.put(makeRecord("rt-new-trash-3", "yet another ephemeral note about desk snacks", {
            importance: 0.3,
            timestamp: now - 3000,
        }));
        // 2x useful+helpful -> feedbackFactor = 2 for rt-gold only.
        for (let i = 0; i < 2; i += 1) {
            await store.putEvent({
                id: `rt-evt-${i}`, type: "feedback", feedbackType: "useful", scope: "global",
                sessionID: "s", timestamp: Date.now(), memoryId: "rt-gold", helpful: true, metadataJson: "{}",
            });
        }
        await store.search(searchParams("build cache pinned dependencies", deterministicEmbed("build cache pinned dependencies")));
        const entry = store.scopeCache.get("global");
        assert.ok(entry, "scope cache entry must exist after the search");
        const ids = entry.records.map((r) => r.id);
        assert.equal(ids.length, 3, `truncation must keep exactly maxRecordsPerScope records, got ${ids.join(",")}`);
        assert.ok(ids.includes("rt-gold"), `important verified + feedback-boosted OLD memory must survive truncation, got ${ids.join(",")}`);
        assert.ok(!ids.includes("rt-new-trash-3"), `oldest fresh-trash record must be evicted over rt-gold, got ${ids.join(",")}`);
        assert.equal(entry.tokenized.length, 3, "tokenized must stay aligned with the truncated record set");
        assert.equal(entry.norms.size, 3, "norms must stay aligned with the truncated record set");
    }
    finally {
        store.close();
    }
});

// RETENTION_SCORING (1.5.5): without setRetentionScoringConfig the store must
// keep the LEGACY recency-only truncation (bare new MemoryStore() users see
// exactly 1.5.4 behavior). Catches a future refactor that applies retention
// scoring on unconfigured stores.
test("integration: scope cache truncation stays recency-only without retention config (RETENTION_SCORING fallback)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-retention-fallback-"));
    const store = new MemoryStore(join(dir, "lancedb"), { maxRecordsPerScope: 3 });
    try {
        await store.init(DIM);
        const now = Date.now();
        for (let i = 1; i <= 5; i += 1) {
            await store.put(makeRecord(`fb-${i}`, `fallback memory number ${i} about cache truncation contracts`, {
                importance: i === 1 ? 1 : 0,
                citationStatus: i === 1 ? "verified" : undefined,
                timestamp: now - i * 1000,
            }));
        }
        await store.search(searchParams("cache truncation contracts", deterministicEmbed("cache truncation contracts")));
        const ids = store.scopeCache.get("global").records.map((r) => r.id);
        assert.equal(ids.length, 3, "truncation must keep exactly maxRecordsPerScope records");
        assert.deepEqual(ids, ["fb-1", "fb-2", "fb-3"], "without retention config, the N NEWEST records must survive (fb-1 is newest)");
    }
    finally {
        store.close();
    }
});

// RETENTION_SCORING (1.5.5): END-TO-END through real config resolution.
// retention.scoring.importanceWeight=1.5 diverges from retrieval.importanceWeight
// (0.4). The store must consume the RETENTION weights for truncation (old
// gold survives) while the live retrieval ranking weight stays untouched.
// Mutant: wiring index.js to pass resolved.retrieval instead of
// resolved.retention.scoring makes rt-cfg-gold (ancient, low-importance
// weight 0.4) lose its cache slot and fails the gold-present assert.
test("integration: config-driven divergent retention.scoring protects old memories without changing ranking (RETENTION_SCORING config)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-retcfg-"));
    const cfg = resolveMemoryConfig({
        memory: {
            dbPath: join(dir, "lancedb"),
            retrieval: { importanceWeight: 0.4, feedbackWeight: 0.3, recencyHalfLifeHours: 72 },
            retention: { scoring: { importanceWeight: 1.5 } },
        },
    }, "/tmp");
    assert.equal(cfg.retention.scoring.importanceWeight, 1.5, "retention scoring must diverge from retrieval");
    assert.equal(cfg.retrieval.importanceWeight, 0.4, "retrieval ranking weight must stay at its configured value");
    const store = new MemoryStore(cfg.dbPath, { maxRecordsPerScope: 3 });
    store.setRetentionScoringConfig(cfg.retention.scoring);
    try {
        await store.init(DIM);
        const now = Date.now();
        const old = now - 365 * 24 * 60 * 60 * 1000;
        await store.put(makeRecord("rt-cfg-gold", "the golden rule: never delete the build cache and always pin dependencies", {
            importance: 1,
            citationStatus: "verified",
            timestamp: old,
        }));
        await store.put(makeRecord("rt-cfg-new-trash-1", "ephemeral note about what to reorder for the fridge", {
            importance: 0.3,
            timestamp: now - 1000,
        }));
        await store.put(makeRecord("rt-cfg-new-trash-2", "another ephemeral note about printer paper", {
            importance: 0.3,
            timestamp: now - 2000,
        }));
        await store.put(makeRecord("rt-cfg-new-trash-3", "yet another ephemeral note about desk snacks", {
            importance: 0.3,
            timestamp: now - 3000,
        }));
        for (let i = 0; i < 2; i += 1) {
            await store.putEvent({
                id: `rt-cfg-evt-${i}`, type: "feedback", feedbackType: "useful", scope: "global",
                sessionID: "s", timestamp: Date.now(), memoryId: "rt-cfg-gold", helpful: true, metadataJson: "{}",
            });
        }
        await store.search(searchParams("build cache pinned dependencies", deterministicEmbed("build cache pinned dependencies")));
        const ids = store.scopeCache.get("global").records.map((r) => r.id);
        assert.equal(ids.length, 3, "truncation must keep exactly maxRecordsPerScope records");
        assert.ok(ids.includes("rt-cfg-gold"), `divergent retention scoring must keep the old gold memory, got ${ids.join(",")}`);
        assert.ok(!ids.includes("rt-cfg-new-trash-3"), `oldest fresh trash must be evicted over gold, got ${ids.join(",")}`);
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

test("integration: concurrent store.init calls coalesce (single-flight)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "init-race-"));
    const store = new MemoryStore(join(dir, "lancedb"));
    try {
        // INIT_SINGLE_FLIGHT regression: two concurrent inits on a FRESH
        // directory. Before the guard, both failed openTable and raced
        // createTable, so one threw "table already exists" and leaked its
        // connection; both callers in ensureInitialized could also double-run
        // the graph backfill (compounding the non-idempotent mention_count).
        // Single-flight coalesces them onto one init, so both resolve.
        await Promise.all([
            store.init(DIM),
            store.init(DIM),
        ]);
        // Store must be fully usable after coalesced init.
        await store.put(makeRecord("race-1", "concurrent init must not corrupt the store"));
        const results = await store.search(searchParams("concurrent init", deterministicEmbed("concurrent init")));
        assert.ok(results.some((r) => r.record.id === "race-1"), "record written after concurrent init must be searchable");
        // A third init AFTER completion re-runs (single-flight only coalesces
        // in-flight calls, not completed ones — re-init must stay possible for
        // the embedding-config-change path).
        await store.init(DIM);
        const again = await store.search(searchParams("concurrent init", deterministicEmbed("concurrent init")));
        assert.ok(again.some((r) => r.record.id === "race-1"), "store still usable after sequential re-init");
    }
    finally {
        store.close();
    }
});

test("integration: initializeStore auto-repairs dimension mismatch (EMBEDDING_CONFIG_REEMBED)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reembed-auto-"));
    const dbPath = join(dir, "lancedb");
    const store1 = new MemoryStore(dbPath);
    try {
        await store1.init(DIM);
        await store1.put(makeRecord("orig-1", "the original memory before the embedding switch"));
    }
    finally {
        store1.close();
    }
    // Reopen the same store with a different-dim embedder (what a config hook
    // swap produces: new embedder + initialized=false). initializeStore must
    // auto-repair instead of silently corrupting the old fixed-width column.
    const NEW_DIM = 8;
    const store2 = new MemoryStore(dbPath);
    try {
        const state = {
            initialized: false,
            embedder: {
                model: "test-embed-new",
                dim: async () => NEW_DIM,
                embed: async (text) => deterministicEmbed(text).slice(0, NEW_DIM),
            },
            store: store2,
            config: { provider: "test", dbPath },
        };
        await initializeStore(state);
        assert.equal(state.initialized, true, "auto-repair must leave the store initialized");
        assert.equal(store2.getIndexHealth().dimensionMismatch, false, "no mismatch after auto-repair");
        assert.equal(await store2.getPhysicalVectorDim(), NEW_DIM, "table must be physically rebuilt at the new dim");
        const scopes = await store2.listDistinctScopes();
        const records = await store2.exportAllRecords(scopes);
        assert.equal(records.length, 1, "data must survive the rebuild");
        assert.equal(records[0].id, "orig-1", "original id preserved");
        assert.equal(records[0].vector.length, NEW_DIM, "row carries a vector at the new dim");
        assert.equal(records[0].embeddingModel, "test-embed-new", "row records the new embedding model");
        const results = await store2.search(searchParams("original memory", deterministicEmbed("original memory").slice(0, NEW_DIM)));
        assert.ok(results.some((r) => r.record.id === "orig-1"), "rebuilt store must be searchable at the new dim");
    }
    finally {
        store2.close();
    }
});

// EPISODE_SCAN_ORDER (1.5.0): queryTaskEpisodes previously returned an
// UNORDERED scan — task_episode_query's client-side .slice(0, limit) silently
// truncated newer episodes once a scope exceeded the limit. With recency
// ordering (startTime DESC) the slice means "most recent N" — the newest
// episode MUST always be present. Mutant: reverting to a no-orderBy query
// makes this fail (empirical check: in the pre-fix store the newest of 1109
// rows sat at scan position 1101 and was truncated at any limit <= 100).
test("integration: task episode query orders by startTime desc so newest episodes are never hidden by limit (EPISODE_SCAN_ORDER)", async () => {
    const store = await newStore("mem-episode-order-");
    const mk = (id, taskId, startTime, state = "running") => ({
        id,
        sessionId: `sess-${id}`,
        scope: "global",
        taskId,
        state,
        startTime,
        commandsJson: "[]",
        validationOutcomesJson: "[]",
        successPatternsJson: "[]",
        retryAttemptsJson: "[]",
        recoveryStrategiesJson: "[]",
        metadataJson: "{}",
    });
    try {
        const base = Date.now() - 10_000;
        for (let i = 0; i < 12; i += 1) {
            await store.createTaskEpisode(mk(`ep-${i}`, `task-${i}`, base + i));
        }
        const episodes = await store.queryTaskEpisodes("global");
        assert.equal(episodes.length, 12, "all episodes must be returned");
        assert.equal(episodes[0].taskId, "task-11", "newest episode must be first (startTime desc)");
        assert.equal(episodes[episodes.length - 1].taskId, "task-0", "oldest episode must be last");
        const limited = episodes.slice(0, 5);
        assert.equal(limited[0].taskId, "task-11", "top-5 slice must include the newest episode");
        assert.ok(limited.some((e) => e.taskId === "task-7"), "top-5 slice must hold the 5 most recent");
        for (let i = 0; i < 12; i += 1) {
            assert.ok(episodes.some((e) => e.taskId === `task-${i}`), `episode ${i} must be present`);
        }
    }
    finally {
        store.close();
    }
});

// EPISODE_SCAN_ORDER (1.5.0): suggestRetryBudget's failedEpisodes[0] must be
// the MOST RECENT failure (the reference error), not an arbitrary scan-order
// row — recency ordering makes sameErrorCount/shouldStop well-defined.
// Mutant: no-orderBy query leaves [0] arbitrary (oldest in a stable scan) and
// fails this.
test("integration: suggestRetryBudget uses the most recent failure as the reference error (EPISODE_SCAN_ORDER)", async () => {
    const store = await newStore("mem-retry-ref-");
    const mk = (id, taskId, startTime, errorMessage) => ({
        id,
        sessionId: `sess-${id}`,
        scope: "global",
        taskId,
        state: "running",
        startTime,
        commandsJson: "[]",
        validationOutcomesJson: "[]",
        successPatternsJson: "[]",
        retryAttemptsJson: "[]",
        recoveryStrategiesJson: "[]",
        metadataJson: "{}",
        errorMessage,
    });
    try {
        const base = Date.now() - 10_000;
        for (const data of [
            mk("ref-old", "ref-old", base, "OLD-ERROR"),
            mk("ref-new", "ref-new", base + 5000, "NEW-ERROR"),
            mk("ref-mid", "ref-mid", base + 2500, "OLD-ERROR"),
            mk("ref-last", "ref-last", base + 7500, "OLD-ERROR"),
        ]) {
            await store.createTaskEpisode(data);
            await store.updateTaskState(data.taskId, "failed", "global", "runtime", data.errorMessage);
        }
        const budget = await store.suggestRetryBudget("global", 4);
        assert.ok(budget, "budget must be returned with 4 failed samples");
        const failed = await store.queryTaskEpisodes("global", "failed");
        assert.equal(failed[0].taskId, "ref-last", "most recent failure must be first");
        assert.equal(failed[0].errorMessage, "OLD-ERROR", "most recent failure's error is the reference");
        assert.equal(budget.suggestedRetries, 1, "no retry attempts -> median 0 -> suggest 1");
        assert.equal(budget.shouldStop, false, "sameErrorCount < 3 -> no stop");
    }
    finally {
        store.close();
    }
});

// RETRY_BUDGET_PARSE (1.4.5): suggestRetryBudget used .length on the raw
// retryAttemptsJson STRING (z.string() contract), so "[]" counted as 2 and
// every failed episode looked "retried" — inflating the median into
// triple-digit suggestedRetries and firing shouldStop for episodes that
// never retried. The median must be over the PARSED array lengths.
test("integration: suggestRetryBudget medians parsed retryAttemptsJson, not string length (RETRY_BUDGET_PARSE)", async () => {
    const store = await newStore("mem-retry-budget-");
    try {
        const failed = async (taskId, errorMessage) => {
            await store.createTaskEpisode({
                id: `ep-${taskId}`,
                sessionId: `sess-${taskId}`,
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
            await store.updateTaskState(taskId, "failed", "global", "resource", errorMessage);
        };
        const err = "ECONNREFUSED to 127.0.0.1:8080";
        // Two failed episodes that never retried (retryAttemptsJson "[]").
        for (const t of ["t-zero-a", "t-zero-b"]) {
            await failed(t, err);
        }
        // Two failed episodes with real retry attempts (2 and 3).
        for (const t of ["t-retried-a", "t-retried-b"]) {
            await failed(t, err);
        }
        for (const t of ["t-retried-a", "t-retried-a"]) {
            await store.addRetryAttempt(t, "global", { outcome: "failed", errorMessage: err });
        }
        for (const t of ["t-retried-b", "t-retried-b", "t-retried-b"]) {
            await store.addRetryAttempt(t, "global", { outcome: "failed", errorMessage: err });
        }
        // One failed episode with a malformed retryAttemptsJson: excluded from
        // the median instead of crashing or masquerading as a datapoint.
        await failed("t-corrupt", err);
        await store.requireEpisodicTaskTable().update({
            where: `taskId = 't-corrupt' AND scope = 'global'`,
            values: { retryAttemptsJson: "{not json" },
        });

        const budget = await store.suggestRetryBudget("global");
        assert.ok(budget, "expected a budget suggestion");
        assert.equal(budget.basedOnCount, 4, "malformed row must be excluded from the median");
        // Parsed retryCounts = [0, 0, 2, 3] → median 2 → suggestedRetries 3.
        assert.equal(budget.suggestedRetries, 3, `expected median of [0,0,2,3] + 1, got ${budget.suggestedRetries}`);
        // Pre-fix: every episode "had attempts" (non-empty JSON string), so
        // the shared error pushed sameErrorCount to 5 ≥ 3 → shouldStop true.
        assert.equal(budget.shouldStop, false, "episodes that never retried must not trigger shouldStop");
    }
    finally {
        store.close();
    }
});

// FAST_PATH_USAGE_LOOKUP (perf review): updateMemoryUsage now finds the row
// via the warm scope cache, then an id-bounded findRecordsByIds, and only
// falls back to the full readByScopes scan. Behavior must be preserved across
// all three paths: full-id updates hit the cache path; prefix-id updates with
// a COLD cache must still land via the scan fallback (findRecordsByIds is
// exact-id only). Mutant: dropping the scan fallback loses the prefix update.
test("integration: updateMemoryUsage updates rows via cache and via fallback scan (FAST_PATH_USAGE_LOOKUP)", async () => {
    const store = await newStore("mem-usagefast-");
    try {
        await store.put(makeRecord("usage-fast-1", "fast path usage lookup memory"));
        // Warm the scope cache, then update by FULL id → cache path.
        await store.search(searchParams("fast path usage", deterministicEmbed("fast path usage")));
        await store.updateMemoryUsage("usage-fast-1", "project:probe", ["global"]);
        // Cold cache (entry dropped) + PREFIX id (findRecordsByIds is
        // exact-id only, so this exercises the scan fallback) → still lands.
        store.scopeCache.delete("global");
        await store.updateMemoryUsage("usage-fast", "project:probe2", ["global"]);
        const row = (await store.readByScopes(["global"])).find((r) => r.id === "usage-fast-1");
        assert.equal(row.recallCount, 2, "both updates must land (cache path + fallback scan)");
        const meta = JSON.parse(row.metadataJson);
        assert.equal((meta.recalledProjects ?? []).length, 2, "both project scopes must register");
    }
    finally {
        store.close();
    }
});

// INDEX_RECHECK_INTERVAL_MS (perf review): a store that crosses
// MIN_ROWS_FOR_INDEX mid-process must build the vector ANN index on the next
// recheck instead of staying on the brute-force fallback until restart.
// Mutant (pre-fix): no recheck exists, so indexState.vector stays false.
test("integration: store crossing MIN_ROWS_FOR_INDEX builds the vector index on recheck (INDEX_RECHECK_INTERVAL_MS)", async () => {
    const store = await newStore("mem-indexrecheck-");
    try {
        const N = MemoryStore.MIN_ROWS_FOR_INDEX + 1;
        for (let i = 0; i < N; i += 1) {
            await store.put(makeRecord(`idx-${i}`, `index recheck row ${i} with some filler text about the memory plugin`));
        }
        assert.equal(store.indexState.vector, false, "index not built at init (store started below the threshold)");
        store.lastIndexCheckAt = 0;
        await store.maybeRecheckVectorIndex();
        assert.equal(store.indexState.vector, true, "recheck must build the vector index once rows cross the threshold");
    }
    finally {
        store.close();
    }
});

// SAFE_EPISODIC_PARSE (1.5.3): the episodic read/write paths used raw
// JSON.parse on stored JSON columns with no guard — one malformed row (a
// legacy/lossy write) threw out of findSimilarTasks,
// extractSuccessPatternsFromScope, addCommandToEpisode or addSuccessPatterns.
// All four now parse via parseJsonObject and must degrade to []/{}, not throw.
test("integration: malformed episodic JSON columns are parsed safely, never thrown (SAFE_EPISODIC_PARSE)", async () => {
    const store = await newStore("mem-safe-parse-");
    try {
        await store.createTaskEpisode({
            id: "ep-safe-1",
            sessionId: "sess-safe-1",
            scope: "global",
            taskId: "t-safe-1",
            state: "success",
            startTime: Date.now(),
            commandsJson: "[]",
            validationOutcomesJson: "[]",
            successPatternsJson: "[]",
            retryAttemptsJson: "[]",
            recoveryStrategiesJson: "[]",
            metadataJson: "{}",
        });
        await store.requireEpisodicTaskTable().update({
            where: `taskId = 't-safe-1' AND scope = 'global'`,
            values: { commandsJson: "{not json", metadataJson: "{also not json", successPatternsJson: "{nope" },
        });
        const similar = await store.findSimilarTasks("global", "t-safe-1");
        assert.ok(Array.isArray(similar), "findSimilarTasks must not throw on a malformed commandsJson/metadataJson");
        const patterns = await store.extractSuccessPatternsFromScope("global");
        assert.ok(Array.isArray(patterns), "extractSuccessPatternsFromScope must not throw on a malformed commandsJson");
        assert.equal(patterns.length, 0, "no patterns from a corrupted commandsJson");
        const appended = await store.addCommandToEpisode("t-safe-1", "global", "npm test");
        assert.equal(appended, true, "addCommandToEpisode must append onto a malformed commandsJson (reparsed as [])");
        const withPatterns = await store.addSuccessPatterns("t-safe-1", "global", [{ commands: ["npm test"], tools: ["npm"], confidence: 0.5, extractedAt: Date.now() }]);
        assert.equal(withPatterns, true, "addSuccessPatterns must overwrite a malformed successPatternsJson");
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