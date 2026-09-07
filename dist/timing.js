import { log } from "./logger.js";

// TIMING_SPANS (1.4.7): lightweight performance tracing for tuning.
//
// Design goals:
// - Near-zero cost when idle: spans always aggregate into a fixed-size map
//   (keyed by op name, so memory is bounded); per-span log lines are emitted
//   only when OPENCODE_MEMORY_PRO_TIMING=1.
// - Nesting-friendly: spans measure their own wall time independently; a
//   nested span's time is naturally included in its parent (by design — the
//   parent/child split is visible in the summary, e.g. recall.pipeline vs
//   store.search vs embedder.embed).
// - Never throws into the host flow: all span bookkeeping is wrapped.
//
// Usage:
//   const stop = startSpan("store.search");
//   try { ... } finally { stop({ candidates: 1234 }); }
//
// Tune/observe:
//   - memory_stats exposes a `timing` section (getTimingStats()).
//   - OPENCODE_MEMORY_PRO_TIMING=1 streams one info line per completed span
//     (visible in the opencode log file / TUI log).

const enabled = /^(1|true|yes)$/i.test(process.env.OPENCODE_MEMORY_PRO_TIMING ?? "");

// name -> { count, totalMs, maxMs, lastMs, lastExtra }
const stats = new Map();

function record(name, durationMs, extra) {
    let entry = stats.get(name);
    if (!entry) {
        entry = { count: 0, totalMs: 0, maxMs: 0, lastMs: 0, lastExtra: undefined };
        stats.set(name, entry);
    }
    entry.count += 1;
    entry.totalMs += durationMs;
    if (durationMs > entry.maxMs)
        entry.maxMs = durationMs;
    entry.lastMs = durationMs;
    entry.lastExtra = extra;
}

export function startSpan(name) {
    if (typeof name !== "string" || name.length === 0)
        return () => 0;
    let started;
    try {
        started = performance.now();
    }
    catch {
        return () => 0;
    }
    return (extra) => {
        try {
            const durationMs = performance.now() - started;
            record(name, durationMs, extra);
            if (enabled) {
                const extraSuffix = extra && typeof extra === "object" && Object.keys(extra).length > 0
                    ? ` ${JSON.stringify(extra)}`
                    : "";
                log("info", `[timing] ${name} took ${durationMs.toFixed(1)}ms${extraSuffix}`);
            }
            return durationMs;
        }
        catch {
            return 0;
        }
    };
}

// Aggregate snapshot, sorted by cumulative total (hottest ops first). Returns
// plain objects so callers can serialize straight into tool output.
export function getTimingStats() {
    const out = [];
    try {
        for (const [name, entry] of stats) {
            out.push({
                op: name,
                count: entry.count,
                totalMs: Math.round(entry.totalMs * 10) / 10,
                avgMs: entry.count > 0 ? Math.round((entry.totalMs / entry.count) * 10) / 10 : 0,
                maxMs: Math.round(entry.maxMs * 10) / 10,
                lastMs: Math.round(entry.lastMs * 10) / 10,
                ...(entry.lastExtra !== undefined ? { lastExtra: entry.lastExtra } : {}),
            });
        }
    }
    catch {
        return [];
    }
    out.sort((a, b) => b.totalMs - a.totalMs);
    return out;
}

export function resetTimingStats() {
    try {
        stats.clear();
    }
    catch { }
}
