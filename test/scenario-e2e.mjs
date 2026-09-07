// End-to-end plugin scenario: boots the real plugin against a mock Ollama
// embedding server and real LanceDB (temp dir), then drives the opencode
// lifecycle (session.created → remember/search → text.complete → session.idle
// auto-capture → session.deleted) through the actual hooks and tools.
//
// Run standalone: node test/scenario-e2e.mjs
// (also spawned by test/integration.test.mjs)
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIM = 64;

function hashWord(word) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i += 1) {
        h ^= word.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

// Deterministic bag-of-words embedding: each token lands energy in two fixed
// buckets, so overlapping vocabulary ⇒ non-zero cosine similarity, and the
// same query/doc always produce the same vector across processes.
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

const workdir = mkdtempSync(join(tmpdir(), "memory-e2e-"));
const dbPath = join(workdir, "lancedb");
const worktree = join(workdir, "proj");

const server = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/embeddings") {
        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", () => {
            try {
                const { prompt } = JSON.parse(body);
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ embedding: deterministicEmbed(prompt) }));
            }
            catch {
                res.writeHead(500).end();
            }
        });
        return;
    }
    res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

process.env.OPENCODE_MEMORY_PRO_SKIP_SIDECAR = "true";
process.env.OPENCODE_MEMORY_PRO_LOG_LEVEL = "error";
process.env.OPENCODE_MEMORY_PRO_DB_PATH = dbPath;
process.env.OPENCODE_MEMORY_PRO_OLLAMA_BASE_URL = `http://127.0.0.1:${port}`;
process.env.OPENCODE_MEMORY_PRO_EMBEDDING_RETRY_INITIAL_DELAY_MS = "100";
process.env.OPENCODE_MEMORY_PRO_MIN_CAPTURE_CHARS = "30";

const { default: plugin } = await import("../dist/index.js");

const sessionID = "e2e-session-1";
// getLastUserText / detectTaskType both read session.messages; a fixed user
// message gives the system.transform hook a real query to recall with.
const recallQuery = "standardized on Goo for bakend servces and Postgres storage";
const client = {
    app: {
        log: async () => { },
    },
    session: {
        get: async () => ({ data: { id: sessionID, directory: worktree } }),
        messages: async () => ({
            data: [
                { info: { role: "user" }, parts: [{ type: "text", text: recallQuery }] },
            ],
        }),
    },
};

const hooks = await plugin({ client, worktree });

function fail(message) {
    throw new Error(`E2E FAILED: ${message}`);
}

const summary = {};

await hooks.config({});

await hooks.event({
    event: { type: "session.created", properties: { info: { id: sessionID, directory: worktree } } },
});

const rememberText = "The team standardized on Go for all new backend services and uses PostgreSQL as their primary database for long-term storage.";
const rememberOut = await hooks.tool.memory_remember.execute(
    { text: rememberText, category: "fact" },
    { directory: worktree, worktree, sessionID },
);
const rememberMatch = rememberOut.match(/Stored memory ([0-9a-f-]{36}) in scope (\S+)/);
if (!rememberMatch) {
    fail(`memory_remember output unexpected: ${rememberOut}`);
}
const [memoryId, scope] = [rememberMatch[1], rememberMatch[2]];
summary.remembered = { id: memoryId, scope };

const searchOut = await hooks.tool.memory_search.execute(
    { query: "Go backend services", limit: 5 },
    { directory: worktree, worktree, sessionID },
);
summary.searchFound = searchOut.includes(memoryId);
if (!summary.searchFound) {
    fail(`memory_search did not return remembered memory:\n${searchOut}`);
}

// Auto-recall path (experimental.chat.system.transform): the hook must inject
// the remembered memory into the system prompt for a typo'd query — this is
// the wiring that previously omitted fuzzyWeight/fuzzyThreshold entirely.
const systemOutput = { system: [] };
await hooks["experimental.chat.system.transform"]({ sessionID }, systemOutput);
summary.autoRecallBlocks = systemOutput.system.length;
summary.autoRecallInjected = systemOutput.system.some((block) => block.includes(memoryId));
if (!summary.autoRecallInjected) {
    fail(`auto-recall (system.transform) did not inject the remembered memory:\n${JSON.stringify(systemOutput.system)}`);
}

const captureText = "The team decided to use LanceDB for long-term memory storage because it supports vector search natively and never deletes memories.";
await hooks["experimental.text.complete"]({ sessionID }, { text: captureText });
await hooks.event({ event: { type: "session.idle", properties: { sessionID } } });

const statsOut = await hooks.tool.memory_stats.execute({}, { directory: worktree, worktree, sessionID });
let stats;
try {
    stats = JSON.parse(statsOut);
}
catch {
    fail(`memory_stats returned non-JSON: ${statsOut}`);
}
summary.autoCaptured = stats.recentCount >= 2;
summary.recentCount = stats.recentCount;
summary.provider = stats.provider;
if (stats.provider !== "opencode-memory-pro") {
    fail(`unexpected provider: ${stats.provider}`);
}
if (!summary.autoCaptured) {
    fail(`auto-capture did not store a memory (recentCount=${stats.recentCount})`);
}

await hooks.event({
    event: { type: "session.deleted", properties: { info: { id: sessionID, directory: worktree } } },
});

const episodesOut = await hooks.tool.task_episode_query.execute(
    { state: "success", limit: 10 },
    { directory: worktree, worktree, sessionID },
);
summary.episodeSuccessful = /- success \(/.test(episodesOut);
if (!summary.episodeSuccessful) {
    fail(`expected a successful episode, got:\n${episodesOut}`);
}

server.closeAllConnections?.();
server.close?.();
process.exitCode = 0;

const payload = `E2E_OK ${JSON.stringify(summary)}`;
writeFileSync(1, `${payload}\n`);
process.exit(0);