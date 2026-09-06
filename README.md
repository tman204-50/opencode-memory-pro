# opencode-memory-pro

[![npm version](https://img.shields.io/npm/v/opencode-memory-pro.svg)](https://www.npmjs.com/package/opencode-memory-pro)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/tman204-50/opencode-memory-pro/actions/workflows/ci.yml/badge.svg)](https://github.com/tman204-50/opencode-memory-pro/actions/workflows/ci.yml)

Long-term memory subsystem for [OpenCode](https://opencode.ai) — a maintained,
standalone fork of `lancedb-opencode-pro` (source: [GitHub](https://github.com/tman204-50/opencode-memory-pro)). It stores memories in LanceDB,
embeds them locally or via OpenAI, builds an offline entity graph to boost and
expand recall, tracks its own effectiveness, and ships a full lifecycle toolkit
(backup, digests, retention, scoping, episodic learning). No source patching
required: install the package directly.

## Highlights

- **LanceDB vector store** with IVF + hybrid (vector ✚ BM25) retrieval, real
  recency/importance/feedback scoring, and automatic compaction.
- **Offline entity graph (no LLM)** — sqlite-backed co-occurrence + typed
  relation edges (`uses`, `depends_on`, ...), BFS graph-expansion recall, and a
  `[graph+X%/n]` boost on search results.
- **Hybrid capture** — offline keyword heuristics by default, or LLM-quality
  structured extraction and abstractive digests via the OpenCode SDK (no API
  keys in plugin config).
- **Memory lifecycle tools** — export/import, summarize/digest, expiry,
  dedup consolidation, scoping (promote/demote), citations, and a retention
  policy that *digests then hides* — it never deletes memories.
- **Self-observing** — effectiveness events, KPI dashboard, weekly learning
  summary, and feedback wiring (`memory_feedback_*`) that feeds recall scoring.
- **Episodic learning** — session/task episodes, similar-task recall, retry
  budget and recovery-strategy suggestions, success-pattern persistence.
- **Correct OpenCode ≥ 1.x wiring** — `session.created` / `session.deleted`,
  per-session scoping, and fault-tolerant capture (falls back to heuristics
  when the LLM or embedder is offline).

## Install

Published on npm — install directly (requires OpenCode ≥ 1.x and Node.js ≥ 22):

```bash
opencode plugin opencode-memory-pro
```

The latest release is **v1.3.8** on [npm](https://www.npmjs.com/package/opencode-memory-pro); source and releases are on [GitHub](https://github.com/tman204-50/opencode-memory-pro).

Remove the old plugin pin at the same time:

```bash
opencode plugin lancedb-opencode-pro -g   # removes pin (if installed)
```

## Configuration

The sidecar file `opencode-memory-pro.json` is resolved from (first match
wins, then depth-merges):

1. `~/.opencode/opencode-memory-pro.json`
2. `~/.config/opencode/opencode-memory-pro.json`
3. `<worktree>/.opencode/opencode-memory-pro.json`
4. `OPENCODE_MEMORY_PRO_CONFIG_PATH` (explicit path; set
   `OPENCODE_MEMORY_PRO_SKIP_SIDECAR=true` to disable sidecar loading entirely)

Legacy `config.memory` blocks in `opencode.json` are still honored and
deep-merged underneath the sidecar. Every setting below has an
`OPENCODE_MEMORY_PRO_*` environment override that always wins over the file.

```json
{
  "provider": "opencode-memory-pro",
  "dbPath": "~/.opencode/memory/lancedb",
  "embedding": { "provider": "openai", "model": "openai/text-embedding-3-small" },
  "graph": { "enabled": true },
  "retention": { "memory": { "enabled": true } }
}
```

### Embedding

| Key | Default | Description |
|---|---|---|
| `embedding.provider` | `"ollama"` | `"ollama"` or `"openai"`. |
| `embedding.model` | `"nomic-embed-text"` (ollama) / required (openai) | Embedding model. |
| `embedding.baseUrl` | `http://127.0.0.1:11434` / `https://api.openai.com/v1` | API base URL. |
| `embedding.apiKey` | — | OpenAI only; required (or via env). |
| `embedding.timeoutMs` | `6000` | Request timeout (min 500). |
| `embedding.retry.enabled` | `true` | Retry failed embedding calls. |
| `embedding.retry.maxAttempts` | `3` | Max attempts. |
| `embedding.retry.initialDelayMs` | `1000` | Initial backoff delay. |
| `embedding.retry.backoffMultiplier` | `2` | Exponential backoff factor. |

Env: `OPENCODE_MEMORY_PRO_EMBEDDING_PROVIDER`, `..._EMBEDDING_MODEL`,
`..._OPENAI_BASE_URL`, `..._OLLAMA_BASE_URL`, `..._OPENAI_API_KEY`,
`..._OPENAI_MODEL`, `..._OPENAI_TIMEOUT_MS` / `..._EMBEDDING_TIMEOUT_MS`,
`..._EMBEDDING_RETRY_ENABLED`, `..._EMBEDDING_RETRY_MAX_ATTEMPTS`,
`..._EMBEDDING_RETRY_INITIAL_DELAY_MS`, `..._EMBEDDING_RETRY_BACKOFF_MULTIPLIER`.

If the embedder is unreachable, recall falls back to pure BM25 over the FTS
index and capture still works — the plugin is offline-tolerant by design.

### Retrieval

| Key | Default | Description |
|---|---|---|
| `retrieval.mode` | `"hybrid"` | `"hybrid"` (vector+BM25 RRF) or `"vector"`. |
| `retrieval.vectorWeight` | `0.7` | Vector/BM25 ratio before normalization. |
| `retrieval.bm25Weight` | `0.3` | (Weights are normalized to sum 1.) |
| `retrieval.minScore` | `0.2` | Minimum score for a result to qualify. |
| `retrieval.rrfK` | `60` | RRF constant. |
| `retrieval.recencyBoost` | `true` | Boost recently recalled/created memories. |
| `retrieval.recencyHalfLifeHours` | `72` | Half-life of the recency boost. |
| `retrieval.importanceWeight` | `0.4` | Weight of stored importance in scoring (0–2). |
| `retrieval.feedbackWeight` | `0.3` | Weight of feedback history in scoring (0–1). |

Env: `OPENCODE_MEMORY_PRO_RETRIEVAL_MODE`, `..._VECTOR_WEIGHT`,
`..._BM25_WEIGHT`, `..._MIN_SCORE`, `..._RRF_K`, `..._RECENCY_BOOST`,
`..._RECENCY_HALF_LIFE_HOURS`, `..._IMPORTANCE_WEIGHT`, `..._FEEDBACK_WEIGHT`.

### Injection

How memories are injected into the model context.

| Key | Default | Description |
|---|---|---|
| `injection.mode` | `"fixed"` | `"fixed"` (n memories), `"budget"` (fill token budget), `"adaptive"` (score-aware). |
| `injection.maxMemories` | `3` | Max memories injected (fixed mode). |
| `injection.minMemories` | `1` | Min memories always injected. |
| `injection.budgetTokens` | `4096` | Token budget (budget/adaptive modes). |
| `injection.maxCharsPerMemory` | `1200` | Per-memory character cap. |
| `injection.summarization` | `"none"` | `"none"` / `"truncate"` / `"extract"` / `"auto"`. |
| `injection.summaryTargetChars` | `300` | Target length for summarized memories. |
| `injection.scoreDropTolerance` | `0.15` | Allowed score drop when filling a budget. |
| `injection.injectionFloor` | `0.2` | Hard score floor for injected memories. |
| `injection.codeSummarization.enabled` | `true` | Summarize code-heavy memories on injection. |
| `injection.codeSummarization.pureCodeThreshold` | `500` | Chars of pure code that trigger it. |
| `injection.codeSummarization.maxCodeLines` | `15` | Max code lines kept. |
| `injection.codeSummarization.codeTruncationMode` | `"smart"` | `"smart"` / `"signature"` / `"preserve"`. |
| `injection.codeSummarization.preserveComments` | `true` | Keep leading comments. |
| `injection.codeSummarization.preserveImports` | `false` | Keep import statements. |
| `injection.taskTypeProfiles.*` | per-type | Per task type: `maxMemories`, `budgetTokens`, `summaryTargetChars`, `categoryWeights`. |

Task types: `coding`, `documentation`, `review`, `release`, `general`.

Env (subset): `OPENCODE_MEMORY_PRO_INJECTION_MODE`, `..._INJECTION_MAX_MEMORIES`,
`..._INJECTION_MIN_MEMORIES`, `..._INJECTION_BUDGET_TOKENS`,
`..._INJECTION_MAX_CHARS`, `..._INJECTION_SUMMARIZATION`,
`..._INJECTION_SUMMARY_TARGET_CHARS`, `..._INJECTION_SCORE_DROP_TOLERANCE`,
`..._INJECTION_FLOOR`, `..._CODE_SUMMARIZATION_ENABLED`, plus
`..._INJECTION_{CODING,DOCS,REVIEW,RELEASE,GENERAL}_{MAX_MEMORIES,BUDGET_TOKENS,SUMMARY_CHARS}`.

### Dedup

| Key | Default | Description |
|---|---|---|
| `dedup.enabled` | `true` | Write-time dedup + consolidation. |
| `dedup.writeThreshold` | `0.92` | Cosine similarity that blocks a duplicate write. |
| `dedup.consolidateThreshold` | `0.95` | Similarity that merges duplicates during consolidation. |
| `dedup.candidateLimit` | `50` | ANN candidates considered per row (10–200, clamped). |

Env: `OPENCODE_MEMORY_PRO_DEDUP_ENABLED`, `..._DEDUP_WRITE_THRESHOLD`,
`..._DEDUP_CONSOLIDATE_THRESHOLD`, `..._DEDUP_CANDIDATE_LIMIT`.

Consolidation runs automatically on `session.idle` (throttled to a 30-min
cooldown), `session.deleted` (forced final pass), and `session.compacted`.
Recent memories (last-recalled within 5 min) and already-merged rows are
skipped. The batch size of the ANN consolidation queries is tunable via
`OPENCODE_MEMORY_PRO_QUERY_BATCH` (default `16`).

### Entity graph

| Key | Default | Description |
|---|---|---|
| `graph.enabled` | `true` | Enable the offline entity graph. |
| `graph.dbPath` | `~/.opencode/memory/graph.db` | sqlite location. |
| `graph.boostLambda` | `0.3` | Entity-overlap score boost (0–1). |
| `graph.maxEntitiesPerMemory` | `20` | Max entities extracted per memory/query. |
| `graph.maxEdgeProvenance` | `20` | Max memories backing an edge (bounds stored weight). |
| `graph.typedEdges` | `true` | Emit typed relation edges (`uses`, `depends_on`, ...). |
| `graph.expansionEnabled` | `true` | BFS graph-expansion recall. |
| `graph.maxHops` | `2` | BFS depth (1–4). |
| `graph.expansionLimit` | `5` | Max expanded candidates. |
| `graph.expansionLambda` | `0.3` | Expansion score weight (0–1). |

Env: `OPENCODE_MEMORY_PRO_GRAPH_ENABLED`, `..._GRAPH_DB_PATH`,
`..._GRAPH_BOOST_LAMBDA`, `..._GRAPH_TYPED_EDGES`, `..._GRAPH_EXPANSION_ENABLED`,
`..._GRAPH_MAX_HOPS`, `..._GRAPH_EXPANSION_LIMIT`, `..._GRAPH_EXPANSION_LAMBDA`.

Expansion fetches each entity's strongest, most-recent edges first and applies
a ranking-only recency decay (edges ≥ 1 year old fade to a 0.35 floor), so
stale connections lose influence without ever being deleted.

### Capture modes

`capture.mode` selects how session content becomes memories (and how
`memory_summarize` / `memory_expire` build digests):

- **`"heuristics"`** (default) — offline keyword-signal detection (success,
  decision, fact, preference signals), zero LLM cost, works with the embedder
  offline.
- **`"llm"`** — structured extraction: on `session.idle`, the session buffer is
  sent to the configured LLM (via an ephemeral OpenCode SDK session; tools
  disabled), which returns `[{content, type, importance}]` JSON; each item is
  embedded, dedup-checked, stored, and graph-indexed. Digests become
  LLM-written abstractive summaries (`digestKind: "llm"` in metadata).
  Preference extraction is unaffected (it runs at recall time, offline).
  On any LLM failure the pipeline **falls back to heuristics** and records a
  `llm-fallback` capture event.

The LLM is addressed by **OpenCode provider + model IDs** — OpenCode owns
routing, auth, and base URLs, so no API key or baseUrl lives in the plugin
config. The provider must be resolvable in your `opencode.json`.

```json
{
  "capture": {
    "mode": "llm",
    "llm": { "provider": "openrouter", "model": "z-ai/glm-5.3-flash" }
  }
}
```

Env: `OPENCODE_MEMORY_PRO_CAPTURE_MODE`,
`OPENCODE_MEMORY_PRO_CAPTURE_LLM_PROVIDER`,
`OPENCODE_MEMORY_PRO_CAPTURE_LLM_MODEL`.

Capture thresholds: `OPENCODE_MEMORY_PRO_MIN_CAPTURE_CHARS` (default `80`,
min 30) and `OPENCODE_MEMORY_PRO_MAX_ENTRIES_PER_SCOPE` (default `3000`,
min 50) bound what gets captured.

### Summarize & retention

`memory_summarize` builds digests of old memories; `memory_expire` runs the
retention sweep (digest-then-hide — originals are marked `digested` and hidden
from recall, **never deleted**).

`summarize`:

| Key | Default | Description |
|---|---|---|
| `summarize.enabled` | `true` | Allow digest creation. |
| `summarize.minAgeDays` | `30` | Min memory age to be digest-eligible. |
| `summarize.minGroupSize` | `3` | Smallest group earning a digest. |
| `summarize.targetChars` | `500` | Digest length. |
| `summarize.replace` | `false` | Mark originals `digested` after absorbing. |

Env: `OPENCODE_MEMORY_PRO_SUMMARIZE_ENABLED`, `..._SUMMARIZE_MIN_AGE_DAYS`,
`..._SUMMARIZE_MIN_GROUP_SIZE`, `..._SUMMARIZE_TARGET_CHARS`,
`..._SUMMARIZE_REPLACE`.

`retention`:

| Key | Default | Description |
|---|---|---|
| `retention.effectivenessEventsDays` | `90` | TTL for effectiveness events (0 disables; negative → 90). |
| `retention.memory.enabled` | `true` | Enable the memory-level digest-then-hide sweep. |
| `retention.memory.unusedDays` | `60` | Unused (not recalled) for this many days → candidate. |
| `retention.memory.minAgeDays` | `180` | Minimum memory age. |
| `retention.memory.minGroupSize` | `2` | Smallest per-category group that earns a digest. |
| `retention.memory.targetChars` | `500` | Digest length. |
| `retention.memory.minImportance` | `0.3` | Importance floor — protects high-value rows. |
| `retention.memory.protectedCategories` | `["digest"]` | Categories never expired. |

Env: `OPENCODE_MEMORY_PRO_RETENTION_EVENTS_DAYS`,
`..._RETENTION_MEMORY_ENABLED`, `..._RETENTION_MEMORY_UNUSED_DAYS`,
`..._RETENTION_MEMORY_MIN_AGE_DAYS`, `..._RETENTION_MEMORY_MIN_GROUP_SIZE`,
`..._RETENTION_MEMORY_TARGET_CHARS`, `..._RETENTION_MEMORY_MIN_IMPORTANCE`.

### Scoping

| Key | Default | Description |
|---|---|---|
| `scoping` | `"global"` | `"global"` collapses all scopes (single-user mode); `"project"` restores per-project scoping. |
| `includeGlobalScope` | `true` | Project queries also see global memories. |
| `globalDetectionThreshold` | `2` | Projects with ≥ N memories become "detected" scopes. |
| `globalDiscountFactor` | `0.7` | Score discount applied to cross-scope global hits. |
| `unusedDaysThreshold` | `30` | Threshold for "unused" classification in lifecycle views. |

Env: `OPENCODE_MEMORY_PRO_SCOPING`, `..._INCLUDE_GLOBAL_SCOPE`,
`..._GLOBAL_DETECTION_THRESHOLD`, `..._GLOBAL_DISCOUNT_FACTOR`,
`..._UNUSED_DAYS_THRESHOLD`.

### Logging

`logging` controls the plugin's log sink. Logs route to opencode's `/log` bus
(shows in the TUI); the optional `file` adds a crash-surviving append-only file
(timestamps, level, message, JSON extras).

```json
{
  "logging": { "level": "debug", "file": "~/.opencode/memory/opencode-memory-pro.log" }
}
```

- `level` — `"debug"` | `"info"` (default) | `"warn"` | `"error"`.
  `"debug"` traces index creation, consolidation, compaction, and
  embedder/retrieval internals.
- `file` — log file path (`~` expanded). Omit or set `null` to keep bus-only.

Env: `OPENCODE_MEMORY_PRO_LOG_LEVEL`, `OPENCODE_MEMORY_PRO_LOG_FILE` (applied at
plugin initialization, before sidecar resolution).

### ANN tunables

Advanced knobs for the vector-search layer. Defaults are conservative; raise
`nprobes` if you see recall misses, raise `QUERY_BATCH` if consolidation is
slow.

- `OPENCODE_MEMORY_PRO_NPROBES` — IVF probe count for filtered vector searches
  (recall vs. latency). Default `40`.
- `OPENCODE_MEMORY_PRO_QUERY_BATCH` — ANN queries per batched vector-search call
  during consolidation. Default `16`.

## Tools

All tools are auto-registered when the plugin loads. Hybrid recall surfaces
`.d.ts` type declarations for the IDEs.

**Memory core**

| Tool | Description |
|---|---|
| `memory_search` | Hybrid semantic search using vector + BM25 + graph boost. |
| `memory_remember` | Explicitly store a memory (with optional category). |
| `memory_delete` | Remove or disable a memory. |
| `memory_clear` | Clear all memories in a scope. |
| `memory_why` | Explain why a specific memory was recalled. |
| `memory_explain_recall` | Explain the factors behind the last recall. |
| `memory_citation` | View or update citation info for a memory. |
| `memory_validate_citation` | Validate a citation and update its status. |
| `memory_global_list` | List global-scoped memories (with filter). |
| `memory_stats` | Memory provider status and index health. |

**Feedback & effectiveness**

| Tool | Description |
|---|---|
| `memory_feedback_useful` | Record whether a recalled memory was helpful. |
| `memory_feedback_wrong` | Record memory that should not have been stored. |
| `memory_feedback_missing` | Record memory that should have been stored. |
| `memory_effectiveness` | Effectiveness metrics for capture recall and feedback. |
| `memory_dashboard` | Weekly learning dashboard with trends and insights. |
| `memory_kpi` | Learning KPIs (retry-to-success rate, memory lift). |
| `memory_what_did_you_learn` | Recent learning summary by category. |

**Lifecycle**

| Tool | Description |
|---|---|
| `memory_export` | Backup all memories to JSON. |
| `memory_import` | Restore memories from an export (merge/replace). |
| `memory_summarize` | Create digests of old memories. |
| `memory_expire` | Retention sweep: fold unused memories into digests. |
| `memory_event_cleanup` | Clean up expired effectiveness events (optional archive). |
| `memory_consolidate` | Merge near-duplicate memories in a scope. |
| `memory_consolidate_all` | Global duplicate cleanup (daily cron friendly). |

**Scoping**

| Tool | Description |
|---|---|
| `memory_scope_promote` | Promote a project memory to global scope. |
| `memory_scope_demote` | Demote a memory from global to project scope. |

**Episodic learning**

| Tool | Description |
|---|---|
| `task_episode_create` | Create a task episode record. |
| `task_episode_query` | Query task episodes by scope and state. |
| `similar_task_recall` | Find similar past tasks via semantic search. |
| `retry_budget_suggest` | Retry budget suggestion from historical data. |
| `recovery_strategy_suggest` | Recovery strategy suggestions after failures. |

**Tooling extras**

| Tool | Description |
|---|---|
| `memory_port_plan` | Plan non-conflicting host ports for compose services. |

Failed sessions additionally record a classified `failureType`
(`syntax`/`runtime`/`logic`/`resource`/`unknown`) and the raw `errorMessage` on
their task episode, so `similar_task_recall` / `retry_budget_suggest` /
`recovery_strategy_suggest` learn from real failures.

## Data locations

- Memories + events: `~/.opencode/memory/lancedb` (LanceDB) — override with
  `dbPath` / `OPENCODE_MEMORY_PRO_DB_PATH`.
- Entity graph: `~/.opencode/memory/graph.db` (sqlite) — override with
  `graph.dbPath`.
- Log file (optional): `~/.opencode/memory/opencode-memory-pro.log`.

## Development

```bash
npm install
npm test            # node --test (unit + integration suites)
npm run test:e2e    # full plugin E2E scenario (mock embedder, real LanceDB)
npm run verify      # tests + pack dry-run
```

CI runs on GitHub Actions (Node 22 + 24) on every push/PR to `main`.

## Migrating from `lancedb-opencode-pro`

Clean-break rename: sidecar is `opencode-memory-pro.json`, env prefix is
`OPENCODE_MEMORY_PRO_*`. Data is **not** affected — the default storage paths
are unchanged (`~/.opencode/memory/lancedb` + `~/.opencode/memory/graph.db`),
so your memories and graph carry over untouched.

## Changelog

### v1.3.8 (2026-09-06)

Fixes `memory_forget(force=true)` being unable to permanently delete a memory
that was soft-deleted first:

- **Force delete now sees hidden rows**: `softDeleteMemory` marks a row
  `status='disabled'`, and the force path previously used `deleteById`, whose
  `readByScopes` query filters out `status='disabled'` (and `merged`/`digested`)
  rows — so "Use force=true for permanent deletion" silently failed and left
  the hidden row on disk forever. The force path now uses the new
  `deleteByIdForce` in `dist/store.js`, which tries the exact-id raw delete
  first and otherwise scans unfiltered rows (so id prefixes still match).
- **Tests**: integration test covers the exact scenario — soft-delete, confirm
  the old path returns `false`, then `deleteByIdForce` removes the row and
  reports `false` on a second attempt.

### v1.3.7 (2026-09-06)

Scope normalization — fixes lost memories when a `scope` argument is
explicitly passed to a tool while `scoping` is `"global"`:

- **Explicit scopes now collapse to `global` in global mode**: previously
  `memory_remember(scope="project")` (and every other tool accepting a `scope`
  arg) stored the row under the literal string `"project"` — but scope-filtered
  reads derive the scope via `deriveProjectScope()`, which returns `"global"`
  in global mode, so the memory was effectively lost (invisible to search,
  promote, why, `memory_global_list`, ...; reachable only by passing
  `scope="project"` explicitly).
- **New `resolveScope(scope, worktree)` helper** in `dist/scope.js` — collapses
  any explicit scope to `"global"` in global mode and honors it in project
  mode (falling back to the derived project scope when omitted). Applied to all
  30 scope-arg sites across `dist/tools/memory.js`, `dist/tools/episodic.js`,
  and `dist/tools/feedback.js`, including `memory_clear`, which previously
  called `clearScope(args.scope)` without any normalization.
- **Tests**: two new unit tests cover the collapse-to-global and
  honor-in-project-mode behavior.

### v1.3.6 (2026-09-06)

Compaction lock hardening — fixes the "Compaction commit failed; leaving N
rewritten fragment(s) in place for GC" warning reappearing on the TUI at
startup / first turn when two opencode instances share one store:

- **No more lock stealing during the owner's init window**: the owner creates
  `.optimize.lock` with `open("wx")` and *then* writes its pid; a contender
  reading in between saw an empty file, declared it stale, deleted it, and
  created its own — so both processes "owned" the lock and raced `optimize()`
  (the native LanceDB stderr line is uninterceptable by the plugin). The lock
  now treats an empty file as "being initialized" for a short grace instead of
  reclaiming it.
- **Contenders wait instead of giving up instantly**: when a live process holds
  the lock, the second instance now polls up to 10s for it to finish (serializing
  compaction across processes) before skipping this cycle and retrying next
  interval, instead of racing it.
- **In-process guard set synchronously**: `maybeOptimizeAll` now sets
  `optimizing = true` before any `await`, so overlapping calls in one process
  (fire-and-forget write trigger + awaited explicit call on the first turn)
  can no longer both run `optimize()` concurrently.
- **Tests**: two new unit tests cover the open→write TOCTOU (old lock returns
  `true` and steals; new lock returns `false` and preserves ownership) and
  stale-lock reclamation.

### v1.3.5 (2026-09-06)

Code-review hardening pass — bug fixes, no breaking changes:

- **Metadata is no longer destroyed on recall** (`updateMemoryUsage`): the
  first recall of a global memory used to *replace* `metadataJson` with
  `{ recalledProjects: [...] }`, silently dropping `pinned`, duplicate flags,
  source, and graph entities — breaking `memory_export` provenance, duplicate-
  aware pruning, and the pin protection in retention. It now merges into the
  existing metadata blob.
- **LLM capture respects an explicit "nothing to store" verdict**: when the LLM
  extraction succeeds but returns `[]`, the transcript no longer falls through
  to the keyword heuristics and gets stored against the model's judgment — the
  heuristic fallback now only runs when extraction actually fails.
- **Ephemeral LLM sessions no longer trigger consolidate/sweep**: the
  `session.deleted` cleanup ran unconditionally with `force=true`, so in
  `capture.mode="llm"` every ephemeral extraction/digest session paid a full
  dedup + retention scan on teardown (and could spawn further LLM digests).
  Own sessions are skipped entirely; pending transcript fragments are flushed
  before user sessions close.
- **Consolidation only merges active memories**: digested (retention-hidden)
  and disabled (soft-deleted) rows can no longer be picked as merge endpoints,
  which previously flipped their status to `merged` and could resurrect
  disabled memories / corrupt digest provenance.
- **`memory_import` replace-mode can't duplicate ids**: existence is now
  checked against raw rows (digested/merged/disabled included) and replace
  deletes the exact id before re-adding, so a hidden row is truly replaced
  instead of leaving two physical rows per id. Citation chains are also
  stringified consistently on write.
- **Episodic data is actually recorded**: failed validations now write numbered
  retry attempts (so `retry_budget_suggest` has real data), and sessions that
  receive injected memories are stamped `recallUsed` (so `memory_kpi`'s memory
  lift is meaningful).
- **Smaller fixes**: `session.error` session-id fallback (`info.id`), bounded
  `getEventTtlStatus` read, graph backfill covers all scopes, embedder
  `fallbackActive` resets on recovery, scope-cache truncation is logged,
  `memory_forget` records `wrong` feedback instead of polluting unhelpful
  stats.

## License

MIT — fork of `lancedb-opencode-pro` (MIT, tryweb).