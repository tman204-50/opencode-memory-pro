# opencode-memory-pro

Standalone, forked long-term memory provider for OpenCode — a maintained fork
of `lancedb-opencode-pro` with an entity graph, memory lifecycle tools, and
retention built in. No source patching required: install the package directly.

## What's different from upstream lancedb-opencode-pro

- **Entity graph (offline, no LLM)** — sqlite-backed co-occurrence graph with
  typed relation edges (`uses`, `depends_on`, `runs_on`, ...), heuristic
  entity extraction, and BFS graph-expansion recall with a multiplicative
  `graphBoost` shown as `[graph+X%/n]` in search results.
- **Memory lifecycle tools** — `memory_export` / `memory_import` (full-fidelity
  JSON backup, merge/replace), `memory_summarize` (digests).
- **LLM capture mode (optional)** — switch auto-capture and digests from the
  offline keyword heuristics to LLM-quality structured extraction and
  abstractive digests, driven through the OpenCode SDK (no API keys in plugin
  config). See [Capture modes](#capture-modes) below.
- **Retention (digest-then-hide, never deletes)** — old unused memories are
  rolled into per-category digests and hidden from recall (`memory_expire`,
  `memory_stats` retention block).
- **Event-driven dedup consolidation** — runs on `session.idle` /
  `session.deleted` / `session.compacted`.
- **Global/project scoping toggle** and single-user global scope mode.
- Correct OpenCode >= 1.x session event wiring (`session.created` /
  `session.deleted` with sessionID at `properties.info.id`) and working
  episodic learning (task episodes, success-pattern persistence).

## Install

The package is loaded like any other OpenCode plugin. From a local tarball:

```bash
npm pack            # produces opencode-memory-pro-1.1.0.tgz
opencode plugin ./opencode-memory-pro-1.1.0.tgz -g
```

Or once published:

```bash
opencode plugin opencode-memory-pro
```

Remove the old plugin pin at the same time:

```bash
opencode plugin lancedb-opencode-pro -g   # removes pin (if installed)
```

## Configuration

Sidecar file: `~/.config/opencode/opencode-memory-pro.json` (also checked in
`~/.opencode/opencode-memory-pro.json` and `<worktree>/.opencode/opencode-memory-pro.json`).
Example — see the upstream README for the full schema (`README_upstream.md` in
this repo):

```json
{
  "provider": "opencode-memory-pro",
  "dbPath": "~/.opencode/memory/lancedb",
  "embedding": { "provider": "openai", "model": "openai/text-embedding-3-small" },
  "graph": { "enabled": true },
  "retention": { "memory": { "enabled": true } }
}
```

Environment overrides use the `OPENCODE_MEMORY_PRO_*` prefix
(e.g. `OPENCODE_MEMORY_PRO_DB_PATH`, `OPENCODE_MEMORY_PRO_GRAPH_ENABLED`).

### Capture modes

`capture.mode` selects how session content becomes memories (and how
`memory_summarize` / `memory_expire` build digests):

- **`"heuristics"`** (default) — the historical offline pipeline: keyword
  signal detection, zero LLM cost, works with the embedder offline.
- **`"llm"`** — structured extraction: on `session.idle`, the session buffer is
  sent to the configured LLM (via an ephemeral OpenCode SDK session; tools
  disabled), which returns `[{content, type, importance}]` JSON; each item is
  embedded, dedup-checked, stored, and graph-indexed. Digests become
  LLM-written abstractive summaries (`digestKind: "llm"` in metadata).
  Preference extraction is unaffected (it runs at recall time, offline).
  On any LLM failure (provider offline, timeout, unparseable reply) the
  pipeline **falls back to heuristics** and records a `llm-fallback` capture
  event, matching the plugin's offline-tolerant philosophy.

The LLM is addressed by **OpenCode provider + model IDs** — OpenCode owns
routing, auth, and base URLs, so no API key or baseUrl lives in the plugin
config. The provider must be resolvable in your `opencode.json` (its base URL
can be the same one your embeddings use).

```json
{
  "capture": {
    "mode": "llm",
    "llm": {
      "provider": "openrouter",
      "model": "z-ai/glm-5.3-flash"
    }
  }
}
```

Env overrides: `OPENCODE_MEMORY_PRO_CAPTURE_MODE`,
`OPENCODE_MEMORY_PRO_CAPTURE_LLM_PROVIDER`,
`OPENCODE_MEMORY_PRO_CAPTURE_LLM_MODEL`.

### Logging

`logging` controls the plugin's log sink. Logs still route to opencode's
`/log` bus (shows in the TUI); the optional `file` adds a crash-surviving
append-only file (timestamps, level, message, JSON extras) — useful for
diagnosing plugin crashes that take the TUI down with them.

```json
{
  "logging": {
    "level": "debug",
    "file": "~/.opencode/memory/opencode-memory-pro.log"
  }
}
```

- `level` — `"debug"` | `"info"` (default) | `"warn"` | `"error"`; minimum
  level emitted. `"debug"` traces index creation, consolidation, compaction,
  and embedder/retrieval internals.
- `file` — log file path (`~` expanded). Omit or set `null` to keep bus-only.

Env overrides: `OPENCODE_MEMORY_PRO_LOG_LEVEL`,
`OPENCODE_MEMORY_PRO_LOG_FILE`. The env overrides are applied at plugin
initialization, so they work even before sidecar config is resolved.

> Migrating from `lancedb-opencode-pro`: this is a clean-break rename —
> sidecar is `opencode-memory-pro.json`, env prefix is `OPENCODE_MEMORY_PRO_*`.
> Data is **not** affected: the default storage path is unchanged
> (`~/.opencode/memory/lancedb` + `~/.opencode/memory/graph.db`), so your
> memories and graph carry over untouched.

## Development

```bash
npm install
npm test        # node --test (unit + smoke)
npm run verify  # test + pack dry-run
```

## License

MIT — fork of `lancedb-opencode-pro` (MIT, tryweb).