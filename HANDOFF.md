# HANDOFF — opencode-memory-pro 1.2.1 (2026-09-06)

Give this file to the agent on restart (also stored in memory as
`969ec905` [versioning rule] and `0193fb44` [1.1.6 history]).

## State
- Working tree: `<repo-root>` (patched `dist/*.js` directly; no TS source).
- **1.2.1 tarball built**: `opencode-memory-pro-1.2.1.tgz` (38 files; 2 stale duplicates removed).
- `~/.config/opencode/opencode.json` repinned to `opencode-memory-pro-1.2.1.tgz`.
- `~/.config/opencode/opencode-memory-pro.json`: logging.level=debug, file=~/.opencode/memory/opencode-memory-pro.log.
- **Tests 22/22 pass** (`npm test`). 1.2.0 never got live verification (needed restart, superseded by 1.2.1).
- **Requires opencode restart to load 1.2.1** (1.1.9 was the last verified-live version).

## What 1.2.1 changed (this review round — graph.js + the remaining unreviewed files)
1. **H: stale duplicates deleted** — `dist/tools/graph.js` (byte-identical copy of `dist/graph.js`) and `dist/tools/config.js` (DRIFTED copy of the config resolver: missing capture/logging/summarize sections — would silently lose those settings if anyone ever imported it). Nothing imported either; same cleanup category as dist/tools/store.js + dist/memory.js in 1.1.8.
2. **M: `mergeMemoryConfig` deep-merges `retention` (incl. `memory`), `summarize`, `logging`** — a sidecar fragment (e.g. `{retention: {memory: {enabled: false}}}`) previously REPLACED the whole section, silently dropping every other key (effectivenessEventsDays, protectedCategories, summarize.targetChars, logging.level...). Now matches the embedding/retrieval/dedup/graph deep-merge pattern. Function exported for a pure unit test.
3. **M: `getMemoryEntities` filters falsy ids** (`record?.id` could be undefined → SQL bind error in node:sqlite would have nuked the whole boost/expand path via the outer try/catch).
4. **L: episodic tools parse stored JSON via `parseJsonObject`** (metadataJson/commandsJson/validationOutcomesJson) — a malformed row no longer throws the whole tool.

## What 1.2.0 changed (previous round, UNVERIFIED live)
- H: `memory_event_cleanup` exact-scope matching (no cross-project deletes); archive/delete use same scopes.
- M: `memory_summarize` warns+skips a group on embed failure (was hard abort); `memory_expire` dryRun works while retention disabled with honest enabled:false.
- L: real recency factors in lastRecall (index.js + tools/memory.js + explainMemory kept in sync); memory_port_plan warns instead of TDZ-crashing on exhausted range.

## What 1.1.9 changed (verified live 2026-09-05)
- H1: `memory_event_cleanup` archives REAL events; M1: summarize excludes digested/disabled; M2: dry runs skip LLM digest; L: what_did_you_learn ellipsis; export/archive mkdir.

## Review status
- FULLY reviewed: index.js, store.js, tools/memory.js, tools/feedback.js, tools/episodic.js, graph.js, embedder.js, ports.js, preference.js, summarize.js, config.js, logger.js, extract.js, llm.js, scope.js, utils.js, types.js. All remaining dist code is reviewed.
- Unreviewed remainder: `.d.ts` files only (types; llm.d.ts verified in sync with parseExtractionJSON).

## Known remaining issues / next steps (not done)
- `nprobes(40)` still a guess for recall-vs-latency; tune via `findSimilarVectorsBatch` if consolidation misses duplicates.
- `updateTaskState`/episodic `values` include failureType/errorMessage (nullable now) — callers only pass `state`, so they stay null.
- Graph store (`~/.opencode/memory/graph.db`) — healthy; revisit only if RSS grows again. Handoff databases staged in graph.js: co-occurrence weight only grows (no decay); expandRecall `LIMIT 100` per entity is unordered — both acceptable approximations.
- `memory_forget` logs `feedbackType:"useful"` + `helpful:false` — intentionally maps to "unhelpful" at consumers; considered correct, no change.
- ⚠️ Recurring benign optimize warns: (a) retryable commit conflict (two compactions raced); (b) phantom manifest `_versions/18446744073709549627.manifest` on effectiveness_events — warn-only, self-heals; do not hand-edit the lance dir while running.
- `QUERY_BATCH=16` starting point; raise if consolidated latency high.

## Versioning rule (user-mandated)
Every build = new tarball with INCREMENTAL version: bump `"version"` in package.json AND `PLUGIN_VERSION` in dist/index.js, `npm pack`, repin opencode.json. Never overwrite an existing version tarball. Next is 1.2.2 (or 1.3.0 for new features).

## Deploy flow (from memory)
edit code → `node --check` → `npm test` (22 tests) → optional smoke → bump versions → `npm pack` → sed-repin opencode.json → user restarts opencode.