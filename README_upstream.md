# lancedb-opencode-pro

**LanceDB-backed long-term memory provider for OpenCode**

[![npm version](https://img.shields.io/npm/v/lancedb-opencode-pro)](https://www.npmjs.com/package/lancedb-opencode-pro)
[![OpenCode](https://img.shields.io/badge/OpenCode-1.4.3-blue)](https://opencode.ai)

Welcome to **lancedb-opencode-pro**! This plugin empowers OpenCode with a durable, long-term memory system powered by LanceDB.

To help you find what you need quickly, please select the guide that best fits your needs:

## 🗺️ Choose Your Path

### ⚠️ Experiencing Issues?
*You see "Memory store unavailable" error or plugin not loading*
👉 **[Read the Compatibility Guide (10 min)](docs/OPENCODE_COMPATIBILITY.md)** 
- Fix: `rm -rf ~/.cache/opencode/node_modules/` then restart
- OpenCode v1.4.3 fully supported (NAPI issue was a cache problem, not a loader bug)
- Diagnosis checklist and solutions

### 🚀 First-Time Users
*You are new to this project and want to get it running quickly.*
👉 **[Read the Quick Start Guide (15 min)](docs/QUICK_START.md)**
- Complete installation steps & examples
- Basic memory operations
- Troubleshooting common issues

### ⚙️ Advanced Users
*You have it running and want to tune retrieval, use OpenAI, or share memory across projects.*
👉 **[Read the Advanced Configuration (30 min)](docs/ADVANCED_CONFIG.md)**
- Hybrid retrieval (RRF, recency boost, importance weighting)
- Memory injection controls (budget/adaptive modes)
- OpenAI Embedding setup
- Cross-project memory sharing (global scope)

### 🛠️ Developers & Contributors
*You want to understand the architecture, run tests, or contribute to the source code.*
👉 **[Read the Development Workflow (20 min)](docs/DEVELOPMENT_WORKFLOW.md)**
- Local environment setup
- OpenCode skills usage guide
- Testing and validation processes
- Release workflow

---

## 🎯 Quick Start (5 Minutes)

### 1. Registration

Register the plugin in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "lancedb-opencode-pro"
  ]
}
```

### 2. Configuration

Create `~/.config/opencode/lancedb-opencode-pro.json`:

```json
{
  "provider": "lancedb-opencode-pro",
  "dbPath": "~/.opencode/memory/lancedb",
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "baseUrl": "http://127.0.0.1:11434"
  }
}
```

### 3. Start Ollama and Restart OpenCode

```bash
# Verify Ollama is accessible
curl http://127.0.0.1:11434/api/tags

# Restart OpenCode
```

That's it! OpenCode will now automatically capture key decisions and inject them into future conversations.

---

## ✨ Core Features

### Auto Memory Capture
- Automatically extracts decisions, lessons, and patterns from assistant responses.
- Configurable minimum capture length (default: 80 chars).
- Auto-categorization into project or global scope.

### Hybrid Retrieval (v0.1.4+)
- **Vector Search** + **BM25 Lexical Search**
- Reciprocal Rank Fusion (RRF)
- Recency boost & Importance weighting

### Memory Management Tools
| Tool | Description | Documentation |
|------|-------------|---------------|
| `memory_search` | Hybrid search for long-term memory | [Doc](docs/ADVANCED_CONFIG.md#memory_search) |
| `memory_delete` | Delete a single memory entry | [Doc](docs/ADVANCED_CONFIG.md#memory_delete) |
| `memory_clear` | Clear all memories in a specific scope | [Doc](docs/ADVANCED_CONFIG.md#memory_clear) |
| `memory_stats` | View memory statistics | [Doc](docs/ADVANCED_CONFIG.md#memory_stats) |
| `memory_remember` | Manually store a memory | [Doc](docs/ADVANCED_CONFIG.md#memory_remember) |
| `memory_forget` | Remove or disable a memory | [Doc](docs/ADVANCED_CONFIG.md#memory_forget) |
| `memory_what_did_you_learn` | Show recent learning summaries | [Doc](docs/ADVANCED_CONFIG.md#memory_what_did_you_learn) |
| `memory_dashboard` | Weekly learning dashboard with trends | [Doc](docs/ADVANCED_CONFIG.md#memory_dashboard) |
| `memory_kpi` | Learning effectiveness KPIs (retry-to-success, memory lift) | [Doc](docs/ADVANCED_CONFIG.md#memory_kpi) |

*(For full details on tools like **Effectiveness Feedback**, **Cross-Project Sharing**, **Deduplication**, **Citations**, and **Episodic Learning**, please refer to the [Advanced Configuration](docs/ADVANCED_CONFIG.md).)*

---

## ⚙️ Configuration Overview

### Basic Setup
```json
{
  "provider": "lancedb-opencode-pro",
  "dbPath": "~/.opencode/memory/lancedb",
  "embedding": {
    "provider": "ollama",
    "model": "nomic-embed-text",
    "baseUrl": "http://127.0.0.1:11434"
  },
  "retrieval": {
    "mode": "hybrid",
    "vectorWeight": 0.7,
    "bm25Weight": 0.3,
    "minScore": 0.2
  }
}
```
*Full configuration options including injection control, deduplication, and OpenAI setup are available in [docs/ADVANCED_CONFIG.md](docs/ADVANCED_CONFIG.md).*

### Priority Order
1. Environment Variables (`LANCEDB_OPENCODE_PRO_*`)
2. `LANCEDB_OPENCODE_PRO_CONFIG_PATH`
3. Project sidecar: `.opencode/lancedb-opencode-pro.json`
4. Global sidecar: `~/.config/opencode/lancedb-opencode-pro.json`
5. Legacy sidecar or built-in defaults

---

## 🧪 Validation & Testing

Quick validation using Docker:
```bash
docker compose build --no-cache && docker compose up -d
docker compose exec opencode-dev npm run verify
```

Full pre-release validation:
```bash
docker compose exec opencode-dev npm run verify:full
```

Check [docs/memory-validation-checklist.md](docs/memory-validation-checklist.md) for more details.

---

## 📦 Installation Options

Primary method: npm package (recommended)
Alternatively, install via `.tgz` release asset or build from source. See [Install Options](docs/QUICK_START.md#install-options).

---

## 🗺️ Version History

- **v0.8.1**: @opencode-ai/sdk and plugin upgrade to 1.4.3, bunfig.toml test isolation fix
- **v0.8.0**: Structured Logging via client.app.log() per OpenCode best practices, Test Environment Isolation Fix
- **v0.7.0**: OpenCode SDK v1.3.14 Compatibility, Node 22 memory_search Race Condition Fix
- **v0.6.3**: Index Creation Guard (defer on empty/insufficient tables, fix #70), LanceDB 0.27.2
- **v0.6.2**: Index Race Condition Fix (concurrent-process conflict handling, jitter backoff)
- **v0.6.1**: Event TTL/Archival, Index Creation Resilience, Duplicate Consolidation Performance
- **v0.6.0**: Learning Dashboard, KPI Pipeline, Feedback-Driven Ranking, Task-Type Aware Injection

_[older versions removed - see CHANGELOG.md for full history]_

See [CHANGELOG.md](CHANGELOG.md) for all changes.

---

## 🤝 Contributing

1. Read [docs/DEVELOPMENT_WORKFLOW.md](docs/DEVELOPMENT_WORKFLOW.md)
2. Understand OpenSpec specs in `openspec/specs/`
3. Use `backlog-to-openspec` to create proposals

---

## 📞 Support & License

- **Issues**: Submit errors or requests on [GitHub Issues](https://github.com/tryweb/lancedb-opencode-pro/issues).
- **License**: MIT License - see [LICENSE](LICENSE).

**Last Updated**: 2026-04-10
**Latest Version**: v0.8.1
