const PREFERENCE_PATTERNS = [
    // PREFERENCE_VERB_LOOKAHEAD (1.6.2): "I prefer to use docker" used to
    // capture the verb — "to" here (optional "(?:using )?" skipped, next word
    // grabbed), and "use" in the sibling "prefer(red) (?:to )?" pattern below.
    // Junk keys ("to"/"use"/"avoid") were injected into the preference block
    // on every recall turn. The negative lookahead skips generic verbs; the
    // real object is still captured by the other patterns ("use docker" →
    // "use X" pattern, "avoid docker" → "avoid" pattern).
    { regex: /I prefer (?:using )?(?!using\b|use\b|to\b|avoid\b)([\w#.+-]+)/i, category: "tool", source: "explicit" },
    { regex: /I (?:always |)(?:use |use |using )([\w#.+-]+)/i, category: "tool", source: "explicit" },
    // PREFERENCE_VERB_LOOKAHEAD (1.6.2): "I prefer to use docker" used to
    // capture the verb ("use" — via the optional "(?:to )?" consuming "to "
    // then grabbing the next word; backtracking could even capture "to"
    // itself). Junk keys ("use"/"to"/"avoid") were injected into the
    // preference block on every recall turn. The negative lookahead skips
    // generic verbs; the real object is still captured by the other patterns
    // ("use docker" → line 5, "avoid docker" → line 11).
    { regex: /(?:prefer|preferred) (?:to )?(?!using\b|use\b|to\b|avoid\b)([\w#.+-]+)/i, category: "tool", source: "explicit" },
    { regex: /use ([\w#.+-]+) (?:for |)/i, category: "tool", source: "explicit" },
    { regex: /I like (?:using |)([\w#.+-]+)/i, category: "tool", source: "explicit" },
    { regex: /(typescript|javascript|python|rust|go|java)/i, category: "language", source: "explicit" },
    { regex: /(jest|vitest|mocha|pytest|rubocop|prettier)/i, category: "tool", source: "explicit" },
    { regex: /(react|vue|angular|svelte)/i, category: "tool", source: "explicit" },
    { regex: /(eslint|prettier|black|ruff|gofmt)/i, category: "style", source: "explicit" },
    { regex: /avoid (?:using |)([\w#.+-]+)/i, category: "tool", source: "explicit" },
    { regex: /test(-|ing) (?:with |)([\w#.+-]+)/i, category: "tool", source: "explicit" },
];
const DEFAULT_DECAY_HALF_LIFE_DAYS = 30;
export function extractPreferenceSignals(memory) {
    const signals = [];
    const text = memory.text;
    for (const pattern of PREFERENCE_PATTERNS) {
        const match = text.match(pattern.regex);
        if (match) {
            signals.push({
                key: normalizePreferenceKey(match[1]),
                value: match[1],
                category: pattern.category,
                source: pattern.source,
                timestamp: memory.timestamp,
                memoryId: memory.id,
            });
        }
    }
    return signals;
}
function normalizePreferenceKey(value) {
    return value.toLowerCase().trim().replace(/\s+/g, "-");
}
export function aggregatePreferences(signals, scope) {
    const preferenceMap = new Map();
    for (const signal of signals) {
        const existing = preferenceMap.get(signal.key);
        if (existing) {
            existing.count += 1;
            if (signal.timestamp > existing.signal.timestamp) {
                existing.signal = signal;
            }
        }
        else {
            preferenceMap.set(signal.key, { signal, count: 1 });
        }
    }
    const preferences = [];
    const now = Date.now();
    for (const [key, data] of preferenceMap) {
        const confidence = calculateConfidence(data.count, data.signal.timestamp, now);
        preferences.push({
            key,
            value: data.signal.value,
            category: data.signal.category,
            confidence,
            scope,
            lastUpdated: data.signal.timestamp,
            sourceCount: data.count,
        });
    }
    preferences.sort((a, b) => b.confidence - a.confidence);
    return {
        scope,
        preferences,
        updatedAt: now,
    };
}
function calculateConfidence(count, timestamp, now) {
    const baseConfidence = Math.min(count / 5, 1);
    const ageDays = (now - timestamp) / (1000 * 60 * 60 * 24);
    const decayFactor = Math.pow(0.5, ageDays / DEFAULT_DECAY_HALF_LIFE_DAYS);
    return baseConfidence * decayFactor;
}
export function resolveConflicts(projectPrefs, globalPrefs) {
    const prefMap = new Map();
    for (const pref of globalPrefs) {
        prefMap.set(pref.key, { ...pref, scope: "global" });
    }
    for (const pref of projectPrefs) {
        const existing = prefMap.get(pref.key);
        if (!existing) {
            prefMap.set(pref.key, { ...pref, scope: "project" });
        }
        else {
            const winner = resolveSingleConflict(pref, existing);
            prefMap.set(pref.key, winner);
        }
    }
    return Array.from(prefMap.values()).sort((a, b) => b.confidence - a.confidence);
}
function resolveSingleConflict(a, b) {
    if (a.lastUpdated > b.lastUpdated) {
        return { ...a, scope: "project" };
    }
    return { ...b, scope: "global" };
}
export function buildPreferenceInjection(preferences, config) {
    if (preferences.length === 0) {
        return "";
    }
    const lines = [];
    lines.push("## User Preferences");
    if (config.mode === "fixed") {
        const selected = preferences.slice(0, config.maxMemories);
        for (const pref of selected) {
            lines.push(`- [${pref.category}] ${pref.value} (confidence: ${Math.round(pref.confidence * 100)}%)`);
        }
    }
    else {
        let currentTokens = 0;
        const budget = config.tokenBudget ?? 500;
        for (const pref of preferences) {
            const estimatedTokens = pref.value.length / 4;
            if (currentTokens + estimatedTokens > budget) {
                break;
            }
            lines.push(`- [${pref.category}] ${pref.value}`);
            currentTokens += estimatedTokens;
        }
    }
    return lines.join("\n");
}
