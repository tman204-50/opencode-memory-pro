const POSITIVE_SIGNALS = [
    // original
    "fixed",
    "resolved",
    "works now",
    "successful",
    "完成",
    "已解決",
    "修復",
    "成功",
    // SIGNAL_TIGHTEN (1.5.3): the expanded list leaned on generic narration
    // verbs ("created", "updated", "configured", "done", "ready", ...) that
    // appear in nearly every assistant turn, so auto-capture fired on routine
    // descriptions of work instead of durable conclusions. Removed the
    // action/filler words; kept outcome and completion claims ("fixed",
    // "verified", "passed", "works now", ...) that mark a real conclusion.
    "successfully",
    "confirmed",
    "verified",
    "validated",
    "passed",
    "working now",
    "corrected",
    "solved",
    "operational",
    "up and running",
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
// SIGNAL_WORD_BOUNDARY (1.6.2): the capture gate matched signals via
// substring includes() — "passed" matched "bypassed", "fixed" matched
// "prefixed", "solved" matched "unsolved" → false auto-captures. The
// sibling GLOBAL_KEYWORD_REGEXES already uses \b for the same reason (see
// below). The gate uses a START-OF-WORD boundary only (no trailing \b):
// capture signals are word stems ("decide" must still match "decided",
// "fix" matches "fixed"), and embedding inside a larger word is exactly
// what produced the false positives. CJK signals skip the boundary (CJK
// chars are not \w in JS regex, so \b/\W-wrapped CJK would never match).
const SIGNAL_REGEXES = ALL_CAPTURE_SIGNALS.map((signal) => {
    const escaped = signal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const asciiWord = /^[\w\s.-]+$/.test(signal);
    return asciiWord ? new RegExp(`(?:^|\\W)${escaped}`) : new RegExp(escaped);
});
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
    if (!SIGNAL_REGEXES.some((regex) => regex.test(lower))) {
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