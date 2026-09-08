const POSITIVE_SIGNALS = [
    // original
    "fixed",
    "resolved",
    "works now",
    "successful",
    "done",
    "完成",
    "已解決",
    "修復",
    "成功",
    // expanded: completion / success synonyms
    "successfully",
    "completed",
    "complete",
    "confirmed",
    "verified",
    "validated",
    "passed",
    "working now",
    "corrected",
    "solved",
    "solution",
    "addressed",
    "implemented",
    "configured",
    "installed",
    "deployed",
    "updated",
    "migrated",
    "upgraded",
    "enabled",
    "operational",
    "up and running",
    "no errors",
    "no issues",
    "finished",
    "ready",
    "created",
    "wrote the file",
    "here's how",
    "the reason",
    "the cause",
    "the answer is",
    "in summary",
    "to summarize",
    "已完成",
    "已修復",
    "已驗證",
    "已確認",
    "已部署",
];
const DECISION_SIGNALS = ["decide", "decision", "tradeoff", "architecture", "採用", "決定", "架構"];
const FACT_SIGNALS = ["because", "root cause", "原因", "由於"];
const PREF_SIGNALS = ["prefer", "preference", "偏好", "習慣"];
// Gate now considers every signal category, not just POSITIVE_SIGNALS,
// so decisions/facts/preferences can also trigger auto-capture.
const ALL_CAPTURE_SIGNALS = [
    ...POSITIVE_SIGNALS,
    ...DECISION_SIGNALS,
    ...FACT_SIGNALS,
    ...PREF_SIGNALS,
];
// Exported so graph.js can reuse the infra lexicon for entity extraction.
export const GLOBAL_KEYWORDS = [
    // Distributions
    "alpine",
    "debian",
    "ubuntu",
    "centos",
    "fedora",
    "arch",
    // Containers
    "docker",
    "dockerfile",
    "docker-compose",
    "containerd",
    // Orchestration
    "kubernetes",
    "k8s",
    "helm",
    "kubectl",
    // Shells/Systems
    "bash",
    "shell",
    "linux",
    "unix",
    "posix",
    "busybox",
    // Web servers
    "nginx",
    "apache",
    "caddy",
    // Databases
    "postgres",
    "postgresql",
    "mysql",
    "redis",
    "mongodb",
    "sqlite",
    // Cloud
    "aws",
    "gcp",
    "azure",
    "digitalocean",
    // VCS
    "git",
    "github",
    "gitlab",
    "bitbucket",
    // Protocols
    "api",
    "rest",
    "graphql",
    "grpc",
    "http",
    "https",
    // Package managers
    "npm",
    "yarn",
    "pnpm",
    "pip",
    "cargo",
    "make",
    "cmake",
    // GRAPH_STORE_PHASE2: high-frequency app/runtime terms so typed-relation
    // extraction can anchor on the nouns this user actually writes about.
    "opencode",
    "lancedb",
    "systemd",
    "journalctl",
    "plugin",
    "graph",
    "memory",
];
export function extractCaptureCandidate(text, minChars) {
    const normalized = text.trim();
    if (normalized.length < minChars) {
        return { candidate: null, skipReason: "below-min-chars" };
    }
    const lower = normalized.toLowerCase();
    if (!ALL_CAPTURE_SIGNALS.some((signal) => lower.includes(signal.toLowerCase()))) {
        return { candidate: null, skipReason: "no-positive-signal" };
    }
    const category = classifyCategory(lower);
    const importance = category === "decision" ? 0.9 : category === "fact" ? 0.75 : 0.65;
    return {
        candidate: {
            text: clipText(normalized, 1200),
            category,
            importance,
        },
    };
}
function classifyCategory(text) {
    if (DECISION_SIGNALS.some((signal) => text.includes(signal.toLowerCase())))
        return "decision";
    if (FACT_SIGNALS.some((signal) => text.includes(signal.toLowerCase())))
        return "fact";
    if (PREF_SIGNALS.some((signal) => text.includes(signal.toLowerCase())))
        return "preference";
    return "other";
}
function clipText(text, maxLen) {
    if (text.length <= maxLen)
        return text;
    return `${text.slice(0, maxLen - 3)}...`;
}
export function detectGlobalWorthiness(content) {
    const lower = content.toLowerCase();
    let matches = 0;
    for (const re of GLOBAL_KEYWORD_REGEXES) {
        if (re.test(lower)) {
            matches += 1;
        }
    }
    return matches;
}

export function isGlobalCandidate(content, threshold) {
    return detectGlobalWorthiness(content) >= threshold;
}

// Word-boundary matchers for GLOBAL_KEYWORDS (precompiled once). Plain
// substring includes() produced false positives — "cap[al]ital" contains
// "api", "di[g]italocean" contains "git" — inflating global-worthiness
// counts. Mirrors graph.js's keyword matching, which already used \b.
// REGEX_DEDUP (perf review): exported so graph.js's extractEntities can
// reuse these instead of recompiling the same 57 keyword regexes from
// scratch on every call (it used to do `new RegExp(...)` inside its loop,
// duplicating work this module already did once at load time).
export const GLOBAL_KEYWORD_REGEXES = GLOBAL_KEYWORDS.map((keyword) => {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i");
});