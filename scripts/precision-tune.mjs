// Precision tuning harness for opencode-memory-pro recall.
//
// Drives the REAL recall pipeline (store.search + graph.boostResults +
// graph.expandRecall, mirroring dist/tools/memory.js) against the live LanceDB
// store, over a curated ground-truth query set, and scores each config
// candidate on MRR@5 / Recall@5 / Precision@5 / expansion-noise.
//
// Usage:
//   node scripts/precision-tune.mjs              # baseline + applied + grid sweep, leaderboard
//   node scripts/precision-tune.mjs --candidate '{"graph":{"boostLambda":0.1},"retrieval":{"minScore":0.3}}'
//   OPENCODE_MEMORY_PRO_DB_PATH=/tmp/lance node scripts/precision-tune.mjs
//
// The store is opened read-only (no writes, no graph backfill) so it can run
// side-by-side with a live plugin process.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveMemoryConfig } from "../dist/config.js";
import { MemoryStore } from "../dist/store.js";
import { createEmbedder } from "../dist/embedder.js";
import { createGraphStore } from "../dist/graph.js";

process.env.OPENCODE_MEMORY_PRO_LOG_LEVEL = "error";

const HOME = homedir();
const CONFIG_PATH = process.env.OPENCODE_MEMORY_PRO_CONFIG ?? join(HOME, ".config/opencode/opencode-memory-pro.json");
const DB_PATH = process.env.OPENCODE_MEMORY_PRO_DB_PATH ?? join(HOME, ".opencode/memory/lancedb");
const TOP_K = 5;

// ---------------------------------------------------------------------------
// Ground truth: query -> memory IDs that should rank in the top-5.
// Queries are phrased naturally (user-style), relevant IDs picked from live
// store contents verified by inspection of past recalls.
// ---------------------------------------------------------------------------
const CASES = [
    {
        q: "default capture model for the memory plugin openrouter deepseek",
        relevant: [
            "a27ac002-b9f5-4a53-af2e-7f5b577b865f",
            "6c5745db-d41b-41fd-8bf9-a80b7f4ae955",
            "f22af971-a155-4f30-8732-37bccb4ada12",
            "42c0b69a-8f73-426b-aae1-1906fb147653",
        ],
    },
    {
        q: "LanceDB vector store search performance optimization",
        relevant: [
            "0f1cf2e8-05eb-41cb-9f61-fce7d3537a2b",
            "764b3111-a02c-445c-81bb-046773a3b042",
            "500d41aa-a525-4713-b0fc-2c6a2f49cebb",
            "f6a648d0-b8d3-45b9-8bcd-5876a75e2f36",
            "08af481c-06de-4047-a836-1a3cf4411678",
        ],
    },
    {
        q: "where is the lancedb data directory and npm package installed",
        relevant: [
            "0f1cf2e8-05eb-41cb-9f61-fce7d3537a2b",
            "764b3111-a02c-445c-81bb-046773a3b042",
        ],
    },
    {
        q: "weekly grocery list Cub Foods budget shopping",
        relevant: [
            "90b4749c-30c8-4000-bac7-c538913a883c",
            "14a320b1-1cc2-4bf7-9cd6-72db808c8b45",
            "92422934-77a8-49a9-a880-d83c6ea09d26",
            "abdbec3b-0ec0-48ef-a5f2-3ef621db1966",
        ],
    },
    {
        q: "print via CUPS Brother HL-2270DW lpr command",
        relevant: [
            "49f20eb3-4564-4e62-ab32-668d726a53cd",
            "b44f4377-71b9-43d3-a152-e39bf95f7d32",
            "b1c6a681-77ab-4eb0-8f5a-387eb073f45b",
        ],
    },
    {
        q: "A2A mesh Adriana Hermes agent JANUS protocol",
        relevant: [
            "59e8201e-9d49-4d34-b3f9-414f469fc44f",
            "7d76df27-3563-4a73-acde-30bf2a7c7d78",
            "c742409a-fdfc-4c61-860b-896ec75aea58",
            "56d004b2-81a1-48a2-98ba-c3c6a6ca1257",
        ],
    },
    {
        q: "Hyperion and JANUS server specs IP addresses",
        relevant: [
            "60a5780b-a070-4839-939e-cf003017288f",
            "3fa64d79-91a6-4db0-b09d-c6cc552a7546",
            "71aa4cc3-8bb3-462a-a983-26bc71535fab",
            "fa35312c-0546-4069-a8ee-705f121f631a",
            "071663f1-6d8",
            "ea72dc1f-3b38-4202-b3c8-e362cbf7bd6a",
        ],
    },
    {
        q: "opencode-memory-pro graceful shutdown lance cancellation fix",
        relevant: [
            "3589a7f0-4259-4a2b-b02f-f7e43b17b748",
        ],
    },
];

// ---------------------------------------------------------------------------
// Pipeline replica of tools/memory.js memory_search (search + boost + expand).
// ---------------------------------------------------------------------------
async function runRecall({ store, graph, embedder }, cfg, query, queryVector, scopes) {
    const results = await store.search({
        query,
        queryVector,
        scopes,
        limit: TOP_K * 2,
        vectorWeight: cfg.retrieval.mode === "vector" ? 1 : cfg.retrieval.vectorWeight,
        bm25Weight: cfg.retrieval.mode === "vector" ? 0 : cfg.retrieval.bm25Weight,
        fuzzyWeight: cfg.retrieval.mode === "vector" ? 0 : cfg.retrieval.fuzzyWeight,
        fuzzyThreshold: cfg.retrieval.fuzzyThreshold,
        minScore: Math.max(cfg.retrieval.minScore, cfg.injection.injectionFloor),
        rrfK: cfg.retrieval.rrfK,
        recencyBoost: cfg.retrieval.recencyBoost,
        recencyHalfLifeHours: cfg.retrieval.recencyHalfLifeHours,
        importanceWeight: cfg.retrieval.importanceWeight,
        feedbackWeight: cfg.retrieval.feedbackWeight,
        globalDiscountFactor: cfg.globalDiscountFactor,
    });
    let boosted = results;
    if (cfg.graph?.enabled && graph?.enabled) {
        boosted = graph.boostResults(query, results, cfg.graph.boostLambda);
    }
    const expanded = [];
    if (cfg.graph?.enabled && graph?.enabled && cfg.graph.expansionEnabled !== false) {
        const candidates = graph.expandRecall(query, {
            maxHops: cfg.graph.maxHops,
            expansionLimit: cfg.graph.expansionLimit,
            expansionLambda: cfg.graph.expansionLambda,
        });
        if (candidates.length > 0) {
            const records = await store.findRecordsByIds(candidates.map((c) => c.memoryId), scopes);
            const byId = new Map(records.map((r) => [r.id, r]));
            const existing = new Set(boosted.map((r) => r.record.id));
            const floor = boosted.length > 0
                ? Math.min(...boosted.map((r) => r.score))
                : Math.max(cfg.retrieval.minScore, cfg.injection.injectionFloor);
            for (const c of candidates) {
                const record = byId.get(c.memoryId);
                if (!record || existing.has(record.id))
                    continue;
                expanded.push({
                    record,
                    score: floor * c.scoreFactor,
                    vectorScore: 0,
                    bm25Score: 0,
                    graphBFS: { hops: c.hops, relation: c.relation, typed: c.typed, path: c.path },
                });
            }
        }
    }
    const effectiveLimit = expanded.length > 0
        ? TOP_K + (cfg.graph?.expansionLimit ?? 5)
        : TOP_K;
    return [...boosted, ...expanded]
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, effectiveLimit);
}

// ---------------------------------------------------------------------------
// Metrics per case + aggregate.
// ---------------------------------------------------------------------------
function scoreCase(ranked, relevant) {
    const ids = ranked.map((r) => r.record.id);
    const top = ids.slice(0, TOP_K);
    const relevantSet = new Set(relevant);
    const hitCount = top.filter((id) => relevantSet.has(id)).length;
    let mrr = 0;
    for (let i = 0; i < top.length; i += 1) {
        if (relevantSet.has(top[i])) { mrr = 1 / (i + 1); break; }
    }
    const recall = relevant.length > 0 ? hitCount / relevant.length : (hitCount > 0 ? 1 : 0);
    const precision = hitCount / TOP_K;
    const noise = ranked.filter((r) => r.graphBFS && r.score >= ranked[TOP_K - 1]?.score).length;
    return { mrr, recall, precision, ids: top, noise };
}

function aggregate(scores) {
    const n = scores.length;
    return {
        mrr: scores.reduce((s, x) => s + x.mrr, 0) / n,
        recall: scores.reduce((s, x) => s + x.recall, 0) / n,
        precision: scores.reduce((s, x) => s + x.precision, 0) / n,
        noise: scores.reduce((s, x) => s + x.noise, 0),
    };
}

function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function applyPatch(base, patch) {
    const out = deepClone(base);
    for (const [section, values] of Object.entries(patch ?? {})) {
        Object.assign(out[section] ??= {}, values);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------
const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const baseConfig = resolveMemoryConfig(raw, process.cwd());

console.log(`Config: ${CONFIG_PATH}\nDB:    ${DB_PATH}\nCases: ${CASES.length} queries, ${TOP_K}-shot\n`);

const embedder = createEmbedder(baseConfig.embedding);
const store = new MemoryStore(DB_PATH);
const graph = baseConfig.graph?.enabled ? await createGraphStore(baseConfig.graph) : null;
try {
    await store.init(await embedder.dim());
} catch (error) {
    console.error(`store.init failed (is the live plugin holding a write lock?): ${error.message}`);
    process.exit(1);
}

// SCOPE_CACHE_CAP: the store's searchable-cache cap (MAX_RECORDS_PER_SCOPE,
// default 1000) is separate from config maxEntriesPerScope (3000). Override it
// here to quantify how many memories are hidden from recall by the cap.
const CAP_OVERRIDE = Number(process.env.OPENCODE_MEMORY_PRO_CAP ?? 0);
if (CAP_OVERRIDE > 0) {
    console.log(`Overriding searchable cache cap: 1000 -> ${CAP_OVERRIDE}`);
    store.cacheConfig.maxRecordsPerScope = CAP_OVERRIDE;
}

const scopes = ["global"];
const cachedVectors = new Map();
async function vectorFor(query) {
    if (!cachedVectors.has(query)) {
        cachedVectors.set(query, await embedder.embed(query));
    }
    return cachedVectors.get(query);
}

async function evaluate(cfg, label) {
    const scores = [];
    for (const c of CASES) {
        const ranked = await runRecall({ store, graph, embedder }, cfg, c.q, await vectorFor(c.q), scopes);
        scores.push(scoreCase(ranked, c.relevant));
    }
    const agg = aggregate(scores);
    console.log(`\n=== ${label} ===`);
    console.log(`MRR@5=${agg.mrr.toFixed(3)}  Recall@5=${agg.recall.toFixed(3)}  Prec@5=${agg.precision.toFixed(3)}  expansionNoiseTop5=${agg.noise}`);
    for (let i = 0; i < CASES.length; i += 1) {
        const s = scores[i];
        const mark = s.mrr > 0 ? "[hit]" : "[MISS]";
        console.log(`  ${mark} ${CASES[i].q.slice(0, 60).padEnd(62)} MRR=${s.mrr.toFixed(2)} P=${s.precision.toFixed(2)} R=${s.recall.toFixed(2)}`);
        const hitCount = s.ids.filter((id) => CASES[i].relevant.includes(id)).length;
        console.log(`        top5=${s.ids.join(",").slice(0, 160)} relHits=${hitCount}/${CASES[i].relevant.length}`);
    }
    return { agg, scores, label };
}

const candidates = [];
if (process.argv.includes("--candidate")) {
    const idx = process.argv.indexOf("--candidate");
    const patch = JSON.parse(process.argv[idx + 1]);
    candidates.push({ label: `candidate ${JSON.stringify(patch)}`, patch, done: false });
} else {
    candidates.push({ label: "baseline (OLD: b0.3 e0.3 hops2 min0.2 vw0.7)", patch: { graph: { boostLambda: 0.3, expansionLambda: 0.3, maxHops: 2 }, retrieval: { minScore: 0.2, vectorWeight: 0.7 } }, done: false });
    candidates.push({ label: "applied (NEW: b0.1 e0.1 hops1 min0.3 vw0.7)", patch: { graph: { boostLambda: 0.1, expansionLambda: 0.1, maxHops: 1 }, retrieval: { minScore: 0.3, vectorWeight: 0.7 } }, done: false });
    for (const boostLambda of [0, 0.1, 0.3]) {
        for (const minScore of [0.2, 0.3]) {
            for (const maxHops of [1, 2]) {
                for (const expansionLambda of [0, 0.1, 0.3]) {
                    for (const recencyHalfLifeHours of [72, 168, 504]) {
                        candidates.push({
                            label: `b${boostLambda} e${expansionLambda} hops${maxHops} min${minScore} rhl${recencyHalfLifeHours} vw0.7`,
                            patch: { graph: { boostLambda, expansionLambda, maxHops }, retrieval: { minScore, vectorWeight: 0.7, recencyHalfLifeHours } },
                            done: false,
                        });
                    }
                }
            }
        }
    }
}

const results = [];
for (const c of candidates) {
    const evaluated = await evaluate(applyPatch(baseConfig, c.patch), c.label);
    results.push({ label: c.label, ...evaluated.agg });
}

console.log(`\n\n================ LEADERBOARD (${results.length} candidates) ================`);
console.log("rank | MRR@5 | Recall@5 | Prec@5 | noiseTop5 | config");
results
    .sort((a, b) => b.mrr - a.mrr || b.recall - a.recall || b.precision - a.precision || a.noise - b.noise)
    .forEach((r, i) => {
        console.log(` ${String(i + 1).padStart(2)} | ${r.mrr.toFixed(3)} | ${r.recall.toFixed(3)}  | ${r.precision.toFixed(3)} | ${String(r.noise).padStart(5)}    | ${r.label}`);
    });

store.close?.();
graph?.close?.();