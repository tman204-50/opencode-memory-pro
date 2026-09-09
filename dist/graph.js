// GRAPH_STORE_PHASE1: offline entity graph for opencode-memory-pro.
// Pure-heuristic entity extraction (no LLM), sqlite-backed co-occurrence
// edges, and a multiplicative graphBoost factor applied to recall scores.
// Storage is global-only by design (single-user scope patch).
// GRAPH_STORE_PHASE2: typed-relation edges. On top of every co-occurrence
// edge, sentence-level verb-pattern heuristics emit directional relations
// (uses / depends_on / runs_on / configured_in / connects_to / part_of /
// managed_by / manages / imports / writes_to / reads_from). Only emitted
// when BOTH endpoints are real extracted entities — plain words are ignored.
// Config: graph.typedEdges (default true), env OPENCODE_MEMORY_PRO_GRAPH_TYPED_EDGES.
// GRAPH_STORE_PHASE2B: graph-expansion recall. BFS from the query's
// extracted entities over the edge table (up to graph.maxHops, preferring
// typed relations to generic co_occurs), collecting memory ids attached to
// the visited non-seed entities via memory_entities. Callers merge the
// returned candidates into hybrid-search results with a graph-origin score,
// so memories that DON'T text/vector-match can still surface when they are
// 1..maxHops away in the entity graph. Work is bounded (per-entity edge
// fanout + total visited-entity budget) so a recall never scans the whole
// graph. Config: graph.expansionEnabled / maxHops / expansionLimit /
// expansionLambda (env OPENCODE_MEMORY_PRO_GRAPH_EXPANSION_*).
// GRAPH_STORE_POLISH: phased scoring polish (0.9) — boostResults strength
// smoothed (single-entity match 0.75 instead of 0.5; >=2 entities capped at
// 1.0) and typed-edge preference in expandRecall raised 1.3x -> 1.5x.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { GLOBAL_KEYWORDS, GLOBAL_KEYWORD_REGEXES } from "./extract.js";
import { log } from "./logger.js";
const FILE_EXTENSION_RE = /\b[\w@./-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|jsonc|sh|bash|py|md|markdown|toml|yaml|yml|css|scss|html|go|rs|c|h|cpp|hpp|java|kt|sql|lock|mod|sum|env|conf|ini|cfg|service|db|sqlite|png|jpg|jpeg|svg|webp|gif|pdf|zip|tar|gz|log|txt|xml|proto|graphql|prisma|d\.ts|tsbuildinfo)\b/gi;
const DOT_KEY_RE = /\b[a-zA-Z][\w-]*(?:\.[\w-]+){1,4}\b/g;
const SCOPED_PKG_RE = /(?<![\w@.-])@[\w-]+\/[\w@./-]+\b/g;
const CAMEL_CASE_RE = /\b[a-z][a-z0-9]{1,}[A-Z][a-zA-Z0-9]*\b/g;
const SNAKE_CASE_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+){1,}\b/g;
const STOPWORDS = new Set([
    "the", "and", "for", "with", "this", "that", "from", "were", "have", "been", "when", "what", "which",
    "your", "you", "our", "about", "into", "after", "before", "over", "under", "again", "then", "them",
    "some", "such", "only", "other", "just", "than", "very", "will", "would", "there", "their", "these",
    "those", "can", "could", "should", "shall", "may", "might", "must", "not", "are", "was", "out", "off",
    "does", "did", "done", "also", "because", "until", "while", "using", "used", "use", "via", "per", "its",
    "has", "had", "being", "both", "each", "few", "more", "most", "nor", "own", "same", "so", "too", "up",
    "down", "in", "on", "at", "to", "of", "is", "as", "by", "be", "or", "an", "a", "it", "no", "yes",
]);
// ---------------------------------------------------------------------------
// GRAPH_STORE_PHASE2: typed-relation patterns.
// Each pattern matches a verbal phrase; the subject/object are resolved by
// finding the extracted entities closest to the phrase (rightmost on the
// left / leftmost on the right), so only real entity pairs become edges.
// ---------------------------------------------------------------------------
const RELATION_PATTERNS = [
    { relation: "uses", re: /\b(?:uses|use|using|consumes?|leverages?|utilizes?)\b/g },
    { relation: "depends_on", re: /\b(?:depends?\s+(?:on|upon)|requires?|needs?)\b/g },
    { relation: "runs_on", re: /\b(?:runs?\s+on|running\s+on|deployed\s+(?:on|to)|hosted\s+on|installed\s+on|executes?\s+on)\b/g },
    { relation: "configured_in", re: /\b(?:configured\s+(?:in|via|through|by|with)|configures?\s+(?:in|via|through)|set\s+in|defined\s+in)\b/g },
    { relation: "connects_to", re: /\b(?:connects?\s+to|connected\s+to|talks?\s+to|communicates?\s+with|listens?\s+on|bound\s+to|attached\s+to)\b/g },
    { relation: "part_of", re: /\b(?:part\s+of|portion\s+of|member\s+of|included\s+in|bundled\s+with|shipped\s+with)\b/g },
    { relation: "managed_by", re: /\b(?:managed\s+(?:by|with|via)|controlled\s+by|orchestrated\s+by|supervised\s+by|handled\s+by)\b/g },
    { relation: "manages", re: /\b(?:manages?|controls?|orchestrates?|supervises?)\b/g },
    { relation: "imports", re: /\b(?:imports?|importing|bundles?|embeds?|includes?)\b/g },
    { relation: "writes_to", re: /\b(?:writes?\s+to|writing\s+to|pushes?\s+to|saves?\s+to|persists?\s+to|logs?\s+to)\b/g },
    { relation: "reads_from", re: /\b(?:reads?\s+from|reading\s+from|pulls?\s+from|loads?\s+from)\b/g },
];
const MAX_TYPED_RELATIONS_PER_MEMORY = 40;
// GRAPH_STORE_PHASE2: conjunctive-continuation heuristic. When a verb phrase
// directly follows a conjunction ("A uses B and runs on C"), the clause has
// no explicit subject — inherit it from the preceding clause.
const CONJUNCTION_RE = /\b(?:and|but|then|so|while|because)\s*$/;
// ---------------------------------------------------------------------------
export function extractTypedRelations(text, entities) {
    if (!text || !entities || entities.length < 2)
        return [];
    const names = Array.from(new Set(entities.map((e) => e.name).filter(Boolean)))
        .sort((a, b) => b.length - a.length);
    if (names.length < 2)
        return [];
    const found = new Map();
    const sentences = text.toLowerCase().split(/[.!?;]+\s+|\n+/);
    for (const sentence of sentences) {
        if (sentence.trim().length === 0)
            continue;
        for (const pattern of RELATION_PATTERNS) {
            pattern.re.lastIndex = 0;
            let match;
            while ((match = pattern.re.exec(sentence)) !== null) {
                if (found.size >= MAX_TYPED_RELATIONS_PER_MEMORY)
                    return Array.from(found.values());
                const left = sentence.slice(0, match.index);
                // Ellipsis rule: "docker-compose uses postgres and runs on linux" —
                // the verb directly follows a conjunction, so the clause has no
                // subject of its own; reuse the preceding clause's subject
                // (approximated as the leftmost entity before the conjunction).
                const conj = CONJUNCTION_RE.exec(left);
                const subject = conj ? pickClosestEntity(left.slice(0, conj.index), names, true) : pickClosestEntity(left, names, false);
                const object = pickClosestEntity(sentence.slice(match.index + match[0].length), names, true);
                if (subject && object && subject !== object) {
                    found.set(`${subject}|${pattern.relation}|${object}`, { src: subject, dst: object, relation: pattern.relation });
                }
            }
        }
    }
    return Array.from(found.values());
}
function pickClosestEntity(windowText, names, fromStart) {
    let best = null;
    let bestIdx = fromStart ? Infinity : -1;
    let bestLen = -1;
    for (const name of names) {
        const idx = windowText.indexOf(name);
        if (idx === -1)
            continue;
        const better = fromStart ? idx < bestIdx : idx > bestIdx;
        if (better || (idx === bestIdx && name.length > bestLen)) {
            best = name;
            bestIdx = idx;
            bestLen = name.length;
        }
    }
    return best;
}
let driverModulePromise = null;
function loadDriverModule() {
    if (driverModulePromise)
        return driverModulePromise;
    driverModulePromise = (async () => {
        try {
            const mod = await import("bun:sqlite");
            if (mod?.Database)
                return { ctor: mod.Database, name: "bun:sqlite" };
        }
        catch { }
        try {
            const mod = await import("node:sqlite");
            if (mod?.DatabaseSync)
                return { ctor: mod.DatabaseSync, name: "node:sqlite" };
        }
        catch { }
        return null;
    })();
    return driverModulePromise;
}
function normalizeEntityName(raw, type, skipDotted = false) {
    let name = raw.trim().toLowerCase().replace(/\s+/g, " ");
    name = name.replace(/^[`'"(\[{~]/, "");
    name = name.replace(/[`'")\]},;:.]+$/, "");
    name = name.replace(/^\.\//, "");
    if (name.length < 3 || name.length > 96)
        return null;
    if (/^\d+(\.\d+)*$/.test(name))
        return null;
    if (skipDotted) {
        const segments = name.split(".");
        if (segments.length > 1 && segments.some((s) => s.length < 2 || /^\d+$/.test(s)))
            return null;
    }
    if (STOPWORDS.has(name))
        return null;
    return { name, type };
}
export function extractEntities(text) {
    if (!text || text.trim().length === 0)
        return [];
    const seen = new Map();
    const add = (raw, type, skipDotted = false) => {
        if (!raw)
            return;
        const normalized = normalizeEntityName(raw, type, skipDotted);
        if (!normalized)
            return;
        if (!seen.has(normalized.name)) {
            seen.set(normalized.name, normalized);
        }
    };
    let m;
    FILE_EXTENSION_RE.lastIndex = 0;
    while ((m = FILE_EXTENSION_RE.exec(text)) !== null) {
        add(m[0], "file");
    }
    DOT_KEY_RE.lastIndex = 0;
    while ((m = DOT_KEY_RE.exec(text)) !== null) {
        const candidate = m[0];
        if (/\.(?:js|jsx|ts|tsx|json|jsonc|sh|py|md|toml|yaml|yml|css|html|go|rs|sql)$/i.test(candidate))
            continue;
        add(candidate, "config-key", true);
    }
    SCOPED_PKG_RE.lastIndex = 0;
    while ((m = SCOPED_PKG_RE.exec(text)) !== null) {
        add(m[0], "package");
    }
    CAMEL_CASE_RE.lastIndex = 0;
    while ((m = CAMEL_CASE_RE.exec(text)) !== null) {
        const candidate = m[0];
        if (candidate.length < 6)
            continue;
        add(candidate, "identifier");
    }
    SNAKE_CASE_RE.lastIndex = 0;
    while ((m = SNAKE_CASE_RE.exec(text)) !== null) {
        const candidate = m[0];
        if (candidate.length < 5)
            continue;
        add(candidate, "identifier");
    }
    // REGEX_DEDUP (perf review): reuse extract.js's precompiled regexes
    // instead of building a fresh RegExp per keyword on every call — this
    // ran on every recall turn (boostResults + expandRecall each call
    // extractEntities(query)) plus once per capture/digest text.
    for (let i = 0; i < GLOBAL_KEYWORDS.length; i++) {
        if (GLOBAL_KEYWORD_REGEXES[i].test(text)) {
            add(GLOBAL_KEYWORDS[i], "infra");
        }
    }
    return Array.from(seen.values());
}
export async function createGraphStore(config) {
    try {
        const driver = await loadDriverModule();
        if (!driver) {
            log("warn", "[graph] no sqlite driver available (bun:sqlite/node:sqlite) - graph disabled");
            return new DisabledGraphStore();
        }
        return new GraphStore(config, driver);
    }
    catch (error) {
        log("warn", `[graph] failed to initialize graph store: ${error instanceof Error ? error.message : String(error)}`);
        return new DisabledGraphStore();
    }
}
export class GraphStore {
    db = null;
    enabled = false;
    maxEntitiesPerMemory;
    maxEdgeProvenance;
    typedEdges = true;
    // QUERY_ENTITY_MEMO (perf review): see getEntitiesForQuery.
    lastQueryEntitiesKey = null;
    lastQueryEntities = null;
    constructor(config, driver) {
        this.maxEntitiesPerMemory = config.maxEntitiesPerMemory ?? 20;
        this.maxEdgeProvenance = config.maxEdgeProvenance ?? 20;
        this.typedEdges = config.typedEdges !== false;
        const expanded = config.dbPath.replace(/^~(?=\/)/, process.env.HOME ?? "");
        mkdirSync(dirname(expanded), { recursive: true });
        this.db = new driver.ctor(expanded);
        this.db.exec("PRAGMA journal_mode=WAL");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS entities (
                name TEXT PRIMARY KEY,
                type TEXT NOT NULL DEFAULT 'other',
                first_seen INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                mention_count INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS memory_entities (
                memory_id TEXT NOT NULL,
                entity_name TEXT NOT NULL,
                PRIMARY KEY (memory_id, entity_name)
            );
            CREATE INDEX IF NOT EXISTS idx_memory_entities_entity ON memory_entities(entity_name);
            CREATE TABLE IF NOT EXISTS edges (
                src TEXT NOT NULL,
                dst TEXT NOT NULL,
                relation TEXT NOT NULL DEFAULT 'co_occurs',
                weight REAL NOT NULL DEFAULT 1,
                first_seen INTEGER NOT NULL,
                last_seen INTEGER NOT NULL,
                provenance TEXT NOT NULL DEFAULT '[]',
                PRIMARY KEY (src, dst, relation)
            );
            CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src);
            CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
        `);
        this.enabled = true;
        log("info", `[graph] enabled (sqlite: ${driver.name}, ${config.dbPath}, typedEdges=${this.typedEdges})`);
    }
    extract(text) {
        if (!this.enabled)
            return [];
        return extractEntities(text).slice(0, this.maxEntitiesPerMemory);
    }
    indexMemory(memoryId, text, timestamp) {
        if (!this.enabled || !memoryId || !text)
            return;
        const entities = extractEntities(text).slice(0, this.maxEntitiesPerMemory);
        if (entities.length === 0)
            return;
        this.begin();
        try {
            for (const entity of entities) {
                // REINDEX_COUNT_IDEMPOTENT (1.4.5): mention_count must only
                // grow when a NEW memory->entity link is created. The link
                // table is INSERT OR IGNORE, so re-indexing the same memory
                // (update, re-embed, backfill) previously bumped the count
                // while the link set stayed the same — inflated counts then
                // survived onMemoryRemoved's -1 and blocked GC forever.
                const link = this.db.prepare(`
                    INSERT OR IGNORE INTO memory_entities (memory_id, entity_name) VALUES (?, ?)
                `).run(memoryId, entity.name);
                const bump = link.changes > 0 ? 1 : 0;
                // REINDEX_ENTITY_HEAL (1.6.2): the old upsert always INSERTed
                // the entity row with VALUES(bump) — when the link already
                // existed (bump=0) but the entity row was missing (pre-1.4.5
                // desync), it created a mention_count=0 ghost that GC
                // (decrement-only) could never collect. A live link means
                // the count is at least 1, so a missing row is healed with 1.
                const entityRow = this.db.prepare("SELECT mention_count FROM entities WHERE name = ?").get(entity.name);
                if (entityRow) {
                    this.db.prepare(`
                        UPDATE entities SET last_seen = ?, mention_count = mention_count + ? WHERE name = ?
                    `).run(timestamp, bump, entity.name);
                }
                else {
                    this.db.prepare(`
                        INSERT INTO entities (name, type, first_seen, last_seen, mention_count)
                        VALUES (?, ?, ?, ?, 1)
                    `).run(entity.name, entity.type, timestamp, timestamp);
                }
            }
            for (let i = 0; i < entities.length; i += 1) {
                for (let j = i + 1; j < entities.length; j += 1) {
                    const a = entities[i].name;
                    const b = entities[j].name;
                    const pair = a < b ? [a, b] : [b, a];
                    this.upsertEdge(pair[0], pair[1], "co_occurs", memoryId, timestamp);
                }
            }
            if (this.typedEdges) {
                const typed = extractTypedRelations(text, entities);
                for (const t of typed) {
                    this.upsertEdge(t.src, t.dst, t.relation, memoryId, timestamp);
                }
            }
            this.commit();
        }
        catch (error) {
            this.rollback();
            log("warn", `[graph] indexMemory failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    upsertEdge(src, dst, relation, memoryId, timestamp) {
        const row = this.db.prepare("SELECT weight, provenance, first_seen FROM edges WHERE src = ? AND dst = ? AND relation = ?").get(src, dst, relation);
        let provenance = [];
        let firstSeen = timestamp;
        let weight = 0;
        if (row) {
            try {
                provenance = JSON.parse(row.provenance ?? "[]");
            }
            catch {
                provenance = [];
            }
            firstSeen = row.first_seen;
            weight = typeof row.weight === "number" ? row.weight : 0;
        }
        if (!provenance.includes(memoryId)) {
            provenance.push(memoryId);
            if (provenance.length > this.maxEdgeProvenance) {
                provenance = provenance.slice(-this.maxEdgeProvenance);
            }
            weight = provenance.length;
        }
        this.db.prepare(`
            INSERT INTO edges (src, dst, relation, weight, first_seen, last_seen, provenance)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(src, dst, relation) DO UPDATE SET
                weight = excluded.weight,
                last_seen = excluded.last_seen,
                provenance = excluded.provenance
        `).run(src, dst, relation, weight, firstSeen, timestamp, JSON.stringify(provenance));
    }
    // GRAPH_STORE_PHASE2: one-time/manual pass that adds typed edges for
    // memories indexed before typed relations existed. Does NOT touch
    // entities/memory_entities (idempotent: upsertEdge only appends a
    // memory_id to provenance if it isn't already there).
    backfillTypedEdges(records) {
        if (!this.enabled || !this.typedEdges || !records || records.length === 0)
            return;
        const now = Date.now();
        let added = 0;
        for (const record of records) {
            if (!record?.id || !record?.text)
                continue;
            const entities = extractEntities(record.text).slice(0, this.maxEntitiesPerMemory);
            const typed = extractTypedRelations(record.text, entities);
            if (typed.length === 0)
                continue;
            this.begin();
            try {
                for (const t of typed) {
                    this.upsertEdge(t.src, t.dst, t.relation, record.id, record.timestamp ?? now);
                }
                added += typed.length;
                this.commit();
            }
            catch (error) {
                this.rollback();
                log("warn", `[graph] backfillTypedEdges failed for ${record.id}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        log("info", `[graph] typed-edge backfill: scanned ${records.length} memories, +${added} typed edges`);
    }
    onMemoryRemoved(memoryId) {
        if (!this.enabled || !memoryId)
            return;
        this.begin();
        try {
            const mapped = this.db.prepare("SELECT entity_name FROM memory_entities WHERE memory_id = ?").all(memoryId);
            const entityNames = mapped.map((r) => r.entity_name);
            this.db.prepare("DELETE FROM memory_entities WHERE memory_id = ?").run(memoryId);
            const edges = this.db.prepare(`
                SELECT src, dst, relation, weight, provenance FROM edges
                WHERE instr(provenance, ?) > 0
            `).all(JSON.stringify(memoryId));
            for (const edge of edges) {
                let provenance = [];
                try {
                    provenance = JSON.parse(edge.provenance ?? "[]");
                }
                catch {
                    provenance = [];
                }
                const filtered = provenance.filter((id) => id !== memoryId);
                if (filtered.length === 0) {
                    this.db.prepare("DELETE FROM edges WHERE src = ? AND dst = ? AND relation = ?").run(edge.src, edge.dst, edge.relation);
                }
                else {
                    this.db.prepare(`
                        UPDATE edges SET weight = ?, provenance = ? WHERE src = ? AND dst = ? AND relation = ?
                    `).run(filtered.length, JSON.stringify(filtered), edge.src, edge.dst, edge.relation);
                }
            }
            for (const name of entityNames) {
                this.db.prepare("UPDATE entities SET mention_count = mention_count - 1 WHERE name = ?").run(name);
                const entity = this.db.prepare("SELECT mention_count FROM entities WHERE name = ?").get(name);
                if (entity && entity.mention_count <= 0) {
                    // ENTITY_GC_EDGE_CLEANUP (1.6.2): the row delete used to
                    // leave the entity's edges behind → BFS traversed dead
                    // entities as intermediates (stale-noise expansion). A
                    // zero-count entity has no live memory links, so its
                    // edges are stale; delete them with the row.
                    this.db.prepare("DELETE FROM edges WHERE src = ? OR dst = ?").run(name, name);
                    this.db.prepare("DELETE FROM entities WHERE name = ?").run(name);
                }
            }
            this.commit();
        }
        catch (error) {
            this.rollback();
            log("warn", `[graph] onMemoryRemoved failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    onMemoryMerged(olderId, newerId) {
        if (!this.enabled || !olderId || !newerId || olderId === newerId)
            return;
        this.begin();
        try {
            // MERGE_ENTITY_GC (1.4.5): links the OLDER memory shares with the
            // NEWER one collapse into a single memory_entities row via the
            // INSERT OR IGNORE below, but mention_count kept the extra
            // reference — when the surviving memory was later removed it was
            // decremented once and the entity sat at 1 with zero references,
            // never GC'd. Decrement exactly the duplicated links (moved links
            // keep their count: one reference, under the newer memory) and
            // GC entities that hit zero, mirroring onMemoryRemoved.
            const dupNames = this.db.prepare(`
                SELECT o.entity_name FROM memory_entities o
                JOIN memory_entities n ON n.memory_id = ? AND n.entity_name = o.entity_name
                WHERE o.memory_id = ?
            `).all(newerId, olderId).map((r) => r.entity_name);
            this.db.prepare(`
                INSERT OR IGNORE INTO memory_entities (memory_id, entity_name)
                SELECT ?, entity_name FROM memory_entities WHERE memory_id = ?
            `).run(newerId, olderId);
            this.db.prepare("DELETE FROM memory_entities WHERE memory_id = ?").run(olderId);
            for (const name of dupNames) {
                this.db.prepare("UPDATE entities SET mention_count = mention_count - 1 WHERE name = ?").run(name);
                const entity = this.db.prepare("SELECT mention_count FROM entities WHERE name = ?").get(name);
                if (entity && entity.mention_count <= 0) {
                    this.db.prepare("DELETE FROM entities WHERE name = ?").run(name);
                }
            }
            const edges = this.db.prepare(`
                SELECT src, dst, relation, weight, provenance FROM edges
                WHERE instr(provenance, ?) > 0
            `).all(JSON.stringify(olderId));
            for (const edge of edges) {
                let provenance = [];
                try {
                    provenance = JSON.parse(edge.provenance ?? "[]");
                }
                catch {
                    provenance = [];
                }
                let filtered = provenance.filter((id) => id !== olderId);
                if (!filtered.includes(newerId)) {
                    filtered.push(newerId);
                }
                if (filtered.length > this.maxEdgeProvenance) {
                    filtered = filtered.slice(-this.maxEdgeProvenance);
                }
                this.db.prepare(`
                    UPDATE edges SET weight = ?, provenance = ? WHERE src = ? AND dst = ? AND relation = ?
                `).run(filtered.length, JSON.stringify(filtered), edge.src, edge.dst, edge.relation);
            }
            this.commit();
        }
        catch (error) {
            this.rollback();
            log("warn", `[graph] onMemoryMerged failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    getMemoryEntities(memoryIds) {
        const out = new Map();
        if (!this.enabled || !memoryIds || memoryIds.length === 0)
            return out;
        const validIds = memoryIds.filter((id) => typeof id === "string" && id.length > 0);
        if (validIds.length === 0)
            return out;
        for (let i = 0; i < validIds.length; i += 200) {
            const chunk = validIds.slice(i, i + 200);
            const placeholders = chunk.map(() => "?").join(",");
            const rows = this.db.prepare(`SELECT memory_id, entity_name FROM memory_entities WHERE memory_id IN (${placeholders})`).all(...chunk);
            for (const row of rows) {
                let set = out.get(row.memory_id);
                if (!set) {
                    set = new Set();
                    out.set(row.memory_id, set);
                }
                set.add(row.entity_name);
            }
        }
        return out;
    }
    // QUERY_ENTITY_MEMO (perf review): boostResults and expandRecall are both
    // called once per recall turn with the SAME query string (index.js runs
    // them back-to-back on one `query` variable), each previously re-running
    // the full extraction pass independently. A size-1 memo on the last
    // query is enough to dedupe that intra-turn repeat; it still recomputes
    // on any different query, so behavior for callers is unchanged.
    getEntitiesForQuery(text) {
        if (!this.enabled)
            return [];
        if (this.lastQueryEntitiesKey === text && this.lastQueryEntities) {
            return this.lastQueryEntities;
        }
        const entities = extractEntities(text).slice(0, this.maxEntitiesPerMemory);
        this.lastQueryEntitiesKey = text;
        this.lastQueryEntities = entities;
        return entities;
    }
    boostResults(query, results, lambda) {
        if (!this.enabled || !results || results.length === 0)
            return results;
        const boostLambda = lambda && Number.isFinite(lambda) ? lambda : 0;
        if (boostLambda <= 0)
            return results;
        const queryEntities = this.getEntitiesForQuery(query);
        if (queryEntities.length === 0)
            return results;
        const idToEntityMap = this.getMemoryEntities(results.map((r) => r.record?.id));
        return results.map((r) => {
            const record = r.record;
            if (!record)
                return r;
            const memEntities = idToEntityMap.get(record.id);
            if (!memEntities || memEntities.size === 0)
                return r;
            let overlap = 0;
            for (const qe of queryEntities) {
                if (memEntities.has(qe.name)) {
                    overlap += 1;
                }
            }
            if (overlap === 0)
                return r;
            // GRAPH_STORE_POLISH: smoothed strength curve — 1 entity = 0.75,
            // 2 or more = 1.0 (capped). Previously 1 entity only got 0.5,
            // which under-rated sparse-but-relevant single-topic matches.
            const strength = Math.min(1, 0.5 + overlap * 0.25);
            const graphBoost = 1 + boostLambda * strength;
            return { ...r, score: r.score * graphBoost, graphBoost, graphOverlap: overlap };
        });
    }
    // GRAPH_STORE_PHASE2B: graph-expansion recall (BFS). See header comment.
    // Returns candidates [{memoryId, hops, path, relation, typed, scoreFactor}]
    // SORTED best-first, capped at opts.expansionLimit. Callers resolve the
    // actual records (scope-filtered) and merge with a graph-origin score:
    // entryScore = floorScore * scoreFactor, where floorScore is the weakest
    // retrieved result (or the retrieve floor when nothing matched) — so
    // expansions rank just below/around real matches, never above them.
    expandRecall(query, opts = {}) {
        if (!this.enabled || !query)
            return [];
        const queryEntities = this.getEntitiesForQuery(query);
        if (queryEntities.length === 0)
            return [];
        const seeds = new Set(queryEntities.map((e) => e.name));
        const maxHops = Math.min(4, Math.max(1, Math.floor(opts.maxHops ?? 2)));
        const expansionLimit = Math.max(1, Math.floor(opts.expansionLimit ?? 5));
        const expansionLambda = opts.expansionLambda != null && Number.isFinite(opts.expansionLambda)
            ? Math.max(0, Math.min(1, opts.expansionLambda))
            : 0.3;
        const hopDecay = opts.hopDecay != null && Number.isFinite(opts.hopDecay)
            ? Math.max(0, Math.min(1, opts.hopDecay))
            : 0.7;
        const MAX_EDGES_PER_ENTITY = 100;
        const MAX_VISITED_ENTITIES = 200;
        // GRAPH_STORE_POLISH: typed-edge preference raised from 1.3x to
        // 1.5x (the phase-2a weight nudge) — directional relations should
        // outrank generic co-occurrence when both reach the same neighbor.
        const TYPED_RELATION_STRENGTH = 1.5;
        const visitedEntities = new Set(seeds);
        const chainByEntity = new Map();
        for (const seed of seeds) {
            chainByEntity.set(seed, [seed]);
        }
        const memCache = new Map();
        const best = new Map();
        const now = Date.now();
        let frontier = Array.from(seeds);
        let hop = 1;
        while (hop <= maxHops && frontier.length > 0 && visitedEntities.size <= MAX_VISITED_ENTITIES) {
            const next = [];
            for (const entity of frontier) {
                if (visitedEntities.size > MAX_VISITED_ENTITIES)
                    break;
                let edgeRows = [];
                try {
                    // EDGE_ORDER (1.3.0): was LIMIT-without-ORDER-BY, i.e. an
                    // arbitrary fanout subset; now the strongest/most-recent
                    // edges win the per-entity budget so weak stale links no
                    // longer crowd out good ones.
                    edgeRows = this.db.prepare("SELECT src, dst, relation, weight, last_seen FROM edges WHERE src = ? OR dst = ? ORDER BY weight DESC, last_seen DESC LIMIT ?").all(entity, entity, MAX_EDGES_PER_ENTITY);
                }
                catch {
                    edgeRows = [];
                }
                const chainToEntity = chainByEntity.get(entity) ?? [entity];
                for (const edge of edgeRows) {
                    const neighbor = edge.src === entity ? edge.dst : edge.src;
                    if (!neighbor)
                        continue;
                    const typed = edge.relation !== "co_occurs";
                    const edgeStrength = Math.min(1, (typeof edge.weight === "number" && edge.weight > 0 ? edge.weight : 1) / 3);
                    const relationStrength = typed ? TYPED_RELATION_STRENGTH : 1.0;
                    // EDGE_DECAY (1.3.0): stored weights are bounded by
                    // maxEdgeProvenance but never age — add a ranking-only
                    // recency factor so long-dormant pairs (>=1yr) fade to a
                    // 0.35 floor instead of holding their old strength forever.
                    const edgeAgeMs = now - (typeof edge.last_seen === "number" ? edge.last_seen : now);
                    const edgeAgeDays = Math.max(0, edgeAgeMs) / 86400000;
                    const recencyFactor = Math.max(0.35, 1 - edgeAgeDays / 365);
                    const scoreFactor = (1 + expansionLambda) * Math.pow(hopDecay, hop - 1) * relationStrength * edgeStrength * recencyFactor;
                    // Every edge is scored (a typed edge reaching the SAME
                    // neighbor as an earlier co_occurs edge upgrades the
                    // candidate); the discovered set only prevents duplicate
                    // next-hop frontier entries.
                    let memoryIds = memCache.get(neighbor);
                    if (memoryIds === undefined) {
                        try {
                            memoryIds = this.db.prepare("SELECT memory_id AS id FROM memory_entities WHERE entity_name = ?").all(neighbor).map((r) => r.id);
                        }
                        catch {
                            memoryIds = [];
                        }
                        memCache.set(neighbor, memoryIds);
                    }
                    const chainToNeighbor = [...chainToEntity, neighbor];
                    for (const memoryId of memoryIds) {
                        const existing = best.get(memoryId);
                        if (!existing || hop < existing.hops || (hop === existing.hops && scoreFactor > existing.scoreFactor)) {
                            best.set(memoryId, {
                                memoryId,
                                hops: hop,
                                path: chainToNeighbor,
                                relation: edge.relation,
                                typed,
                                scoreFactor,
                            });
                        }
                    }
                    if (!visitedEntities.has(neighbor)) {
                        visitedEntities.add(neighbor);
                        if (next.length < MAX_VISITED_ENTITIES) {
                            chainByEntity.set(neighbor, chainToNeighbor);
                            next.push(neighbor);
                        }
                    }
                }
            }
            frontier = next;
            hop += 1;
        }
        return Array.from(best.values())
            .sort((a, b) => b.scoreFactor - a.scoreFactor || a.hops - b.hops)
            .slice(0, expansionLimit);
    }
    reindexMemories(records) {
        if (!this.enabled || !records || records.length === 0)
            return;
        // REINDEX_BACKFILL_HEAL (1.6.2): the old `COUNT(*) > 0 → return`
        // guard permanently blocked backfill healing — ANY memory_entities
        // row skipped the one-time backfill forever, so a crash mid-backfill
        // left a partial graph with no recovery path. indexMemory is
        // idempotent since REINDEX_COUNT_IDEMPOTENT (1.4.5) (INSERT OR IGNORE
        // link + bump-only-on-new-link), so re-running over all active
        // memories on every init heals partial graphs safely.
        log("info", `[graph] backfilling/re-indexing ${records.length} existing memories into entity graph`);
        for (const record of records) {
            if (!record?.id || !record?.text)
                continue;
            this.indexMemory(record.id, record.text, record.timestamp ?? Date.now());
        }
    }
    stats() {
        if (!this.enabled)
            return { enabled: false, entities: 0, memoryMappings: 0, edges: 0, relations: {} };
        const count = (sql) => {
            const row = this.db.prepare(`SELECT COUNT(*) AS c FROM ${sql}`).get();
            return row?.c ?? 0;
        };
        const relations = {};
        for (const row of this.db.prepare("SELECT relation AS r, COUNT(*) AS c FROM edges GROUP BY relation ORDER BY c DESC").all()) {
            relations[row.r] = row.c;
        }
        return {
            enabled: true,
            entities: count("entities"),
            memoryMappings: count("memory_entities"),
            edges: count("edges"),
            relations,
        };
    }
    begin() {
        this.db.exec("BEGIN");
    }
    commit() {
        this.db.exec("COMMIT");
    }
    rollback() {
        this.db.exec("ROLLBACK");
    }
}
export class DisabledGraphStore {
    enabled = false;
    extract() {
        return [];
    }
    indexMemory() { }
    backfillTypedEdges() { }
    onMemoryRemoved() { }
    onMemoryMerged() { }
    getMemoryEntities() {
        return new Map();
    }
    getEntitiesForQuery() {
        return [];
    }
    boostResults(_query, results) {
        return results;
    }
    expandRecall() {
        return [];
    }
    reindexMemories() { }
    stats() {
        return { enabled: false, entities: 0, memoryMappings: 0, edges: 0, relations: {} };
    }
}