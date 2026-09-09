import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
export function expandHomePath(input) {
    if (input === "~")
        return homedir();
    if (input.startsWith("~/"))
        return join(homedir(), input.slice(2));
    return input;
}
export function toNumber(value, fallback) {
    if (typeof value === "number" && Number.isFinite(value))
        return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed))
            return parsed;
    }
    return fallback;
}
export function toBoolean(value, fallback) {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["1", "true", "yes", "on"].includes(normalized))
            return true;
        if (["0", "false", "no", "off"].includes(normalized))
            return false;
    }
    return fallback;
}
export function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}
// STABLE_HASH_NONSTRING (1.6.2): update(undefined) throws a TypeError —
        // deriveProjectScope(undefined) crashed in project mode (odd
        // hosts/tests only). Hash the empty string instead of throwing.
export function stableHash(input) {
    return createHash("sha256").update(typeof input === "string" ? input : "", "utf8").digest("hex");
}
export function tokenize(text) {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
        .split(/\s+/)
        .filter((token) => token.length > 1);
}
export function cosineSimilarity(a, b) {
    if (a.length === 0 || b.length === 0 || a.length !== b.length)
        return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}
export function generateId() {
    return randomUUID();
}
export function parseJsonObject(value, fallback) {
    if (!value)
        return fallback;
    try {
        const parsed = JSON.parse(value);
        return parsed;
    }
    catch {
        return fallback;
    }
}
const SYNTAX_PATTERNS = [
    /SyntaxError/i,
    /unexpected token/i,
    /unexpected character/i,
    /parse error/i,
    /Invalid syntax/i,
    /syntax error/i,
    /unterminated string/i,
    /unterminated/i,
    /Expected .+ but found/i,
];
const RUNTIME_PATTERNS = [
    /ReferenceError/i,
    /TypeError/i,
    /RangeError/i,
    /ReferenceError/i,
    /^Error:/i,
    /^Exception:/i,
    /Cannot read property/i,
    /is not a function/i,
    /is not defined/i,
    /Cannot read/i,
    /is null/i,
    /is not an object/i,
    /unhandled promise rejection/i,
    /UnhandledPromiseRejection/i,
];
const LOGIC_PATTERNS = [
    /AssertionError/i,
    /assert.*failed/i,
    /expected .+ but got/i,
    /expected .+ received/i,
    /test failed/i,
    /assertion failed/i,
    /does not equal/i,
    /not equal/i,
];
const RESOURCE_PATTERNS = [
    /OutOfMemoryError/i,
    /JavaScript heap out of memory/i,
    /ETIMEDOUT/i,
    /ECONNREFUSED/i,
    /ECONNRESET/i,
    /ENOMEM/i,
    /EADDRINUSE/i,
    /timeout/i,
    /memory limit/i,
    /disk full/i,
    /no space left/i,
    /resource.*exhausted/i,
];
export function classifyFailure(errorMessage) {
    const lowerMessage = errorMessage.toLowerCase();
    for (const pattern of SYNTAX_PATTERNS) {
        if (pattern.test(errorMessage)) {
            return "syntax";
        }
    }
    for (const pattern of RUNTIME_PATTERNS) {
        if (pattern.test(errorMessage)) {
            return "runtime";
        }
    }
    for (const pattern of LOGIC_PATTERNS) {
        if (pattern.test(errorMessage)) {
            return "logic";
        }
    }
    for (const pattern of RESOURCE_PATTERNS) {
        if (pattern.test(errorMessage)) {
            return "resource";
        }
    }
    return "unknown";
}
const TYPE_CHECK_PATTERNS = [
    /tsc|typescript.*error/i,
    /type error/i,
    /property .* does not exist/i,
    /argument of type/i,
    /Type '.*' is not assignable/i,
];
const BUILD_PATTERNS = [
    /build failed/i,
    /compilation failed/i,
    /webpack.*error/i,
    /vite.*error/i,
    /esbuild.*error/i,
    /rollup.*error/i,
    /failed to build/i,
];
const TEST_PATTERNS = [
    /test.*failed/i,
    /\d+ passed, \d+ failed/i,
    /PASS|FAIL/i,
    /failed.*test/i,
];
export function parseValidationOutput(output, type) {
    const hasError = (pattern) => pattern.test(output);
    const extractCount = (pattern) => {
        const match = output.match(pattern);
        return match ? parseInt(match[1], 10) : undefined;
    };
    switch (type) {
        case "type-check": {
            // VALIDATION_ZERO_COUNT (1.6.2): `||` collapsed a legitimate 0
            // (extractCount returns 0 = falsy) into the hasError fallback, so
            // "0 errors" (no "Found" prefix) hit /error|fail/i → false fail.
            // `??` preserves a parsed count of 0 → status pass.
            const errorCount = extractCount(/(\d+)\s+error/i) ?? extractCount(/Found (\d+) error/i);
            if (errorCount !== undefined) {
                return {
                    status: errorCount > 0 ? "fail" : "pass",
                    errorCount,
                    errorTypes: TYPE_CHECK_PATTERNS.filter(p => hasError(p)).map(p => p.source),
                };
            }
            return { status: hasError(/error|fail/i) ? "fail" : "pass" };
        }
        case "build": {
            const errorCount = extractCount(/(\d+)\s+error/i);
            if (errorCount !== undefined) {
                return {
                    status: errorCount > 0 ? "fail" : "pass",
                    errorCount,
                };
            }
            return { status: hasError(/failed|error/i) ? "fail" : "pass" };
        }
        case "test": {
            const passed = extractCount(/(\d+)\s+passed/i);
            const failed = extractCount(/(\d+)\s+failed/i);
            if (passed !== undefined || failed !== undefined) {
                return {
                    status: (failed && failed > 0) ? "fail" : "pass",
                    passedCount: passed,
                    failedCount: failed,
                };
            }
            return { status: hasError(/fail|error/i) ? "fail" : "pass" };
        }
        default:
            return { status: "skipped" };
    }
}
