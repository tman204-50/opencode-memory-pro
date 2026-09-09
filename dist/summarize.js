// Code keywords used for content detection
const CODE_KEYWORDS = [
    "function", "async", "await", "const", "let", "var", "return", "class", "interface", "type",
    "import", "export", "from", "default", "extends", "implements", "new", "this", "super",
    "def ", "async def", "func ", "fn ", "pub fn", "impl ", "struct ", "enum ",
    "=>", "->", "::", "if (", "for (", "while (", "try {", "catch (", "throw ",
];
// Keywords for key sentence extraction
const KEY_SENTENCE_PATTERNS = [
    /(?:fixed|resolved|works?\s+now|successful|done|完成|已解決|修復|成功)/i,
    /(?:probleme|issue|bug|error|fail|錯誤|問題|失敗)/i,
    /(?:solution|fix|resolve|解決方案|修正)/i,
    /(?:because|root\s+cause|原因|由於)/i,
    /(?:decide|decision|tradeoff|architecture|決定|架構|採用)/i,
    /(?:prefer|preference|偏好|習慣)/i,
];
/**
 * Detects whether content contains code and its type
 */
export function detectContentType(text) {
    const hasMarkdownCode = /```[\s\S]*?```/.test(text);
    const bracketBalance = calculateBracketBalance(text);
    const codeKeywords = countCodeKeywords(text);
    const indentationRatio = calculateIndentationRatio(text);
    const codeScore = (hasMarkdownCode ? 2 : 0) +
        (bracketBalance > 3 ? 1 : 0) +
        (codeKeywords > 5 ? 1 : 0) +
        (indentationRatio > 0.3 ? 1 : 0);
    if (codeScore >= 5) {
        return { hasCode: true, isPureCode: true };
    }
    if (codeScore >= 3) {
        return { hasCode: true, isPureCode: false };
    }
    if (hasMarkdownCode || codeKeywords > 10) {
        return { hasCode: true, isPureCode: false };
    }
    return { hasCode: false, isPureCode: false };
}
/**
 * Calculates bracket balance for code detection
 */
export function calculateBracketBalance(text) {
    const openBrackets = (text.match(/[{([]/g) || []).length;
    const closeBrackets = (text.match(/[})\]]/g) || []).length;
    return Math.abs(openBrackets - closeBrackets) + Math.min(openBrackets, closeBrackets);
}
/**
 * Counts code-related keywords
 */
export function countCodeKeywords(text) {
    const lower = text.toLowerCase();
    let count = 0;
    for (const keyword of CODE_KEYWORDS) {
        if (lower.includes(keyword.toLowerCase())) {
            count += 1;
        }
    }
    return count;
}
/**
 * Calculates ratio of indented lines
 */
export function calculateIndentationRatio(text) {
    const lines = text.split("\n");
    if (lines.length === 0)
        return 0;
    const indentedLines = lines.filter((line) => /^\s{2,}/.test(line));
    return indentedLines.length / lines.length;
}
/**
 * Estimates token count for content
 */
export function estimateTokens(text, contentType) {
    // Count Chinese characters
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const nonChineseChars = text.length - chineseChars;
    // Chinese ~2 chars/token, English/other ~4 chars/token
    const baseTokens = Math.ceil(chineseChars / 2 + nonChineseChars / 4);
    // Code has higher token density
    if (contentType === "code") {
        return Math.ceil(baseTokens * 1.2);
    }
    return baseTokens;
}
/**
 * Truncates text to max characters
 */
export function truncateText(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars - 3)}...`;
}
/**
 * Smart truncation for code - finds complete statement boundaries
 */
export function smartTruncateCode(code, maxLines, config) {
    const lines = code.split("\n");
    if (lines.length <= maxLines)
        return code;
    let braceBalance = 0;
    let lastCompleteIndex = maxLines;
    let foundComplete = false;
    // Calculate brace balance and find last complete statement
    for (let i = 0; i < Math.min(lines.length, maxLines + 10); i++) {
        const line = lines[i];
        braceBalance += (line.match(/{/g) || []).length;
        braceBalance -= (line.match(/}/g) || []).length;
        if (i >= maxLines - 5 && braceBalance === 0 && i < lines.length - 1) {
            lastCompleteIndex = i + 1;
            foundComplete = true;
            break;
        }
    }
    // If no complete boundary found, use maxLines
    if (!foundComplete) {
        lastCompleteIndex = maxLines;
    }
    // Build truncated code
    let result = lines.slice(0, lastCompleteIndex).join("\n");
    // Add truncation indicator
    result += "\n// ... (truncated)";
    return result;
}
/**
 * Extracts key sentences from text
 */
export function extractKeySentences(text, targetChars) {
    const sentences = text.split(/[。.!?\n]+/).filter((s) => s.trim().length > 0);
    const keySentences = [];
    let currentLength = 0;
    // First pass: sentences matching key patterns
    for (const sentence of sentences) {
        const trimmed = sentence.trim();
        if (KEY_SENTENCE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
            if (currentLength + trimmed.length > targetChars && keySentences.length > 0) {
                break;
            }
            keySentences.push(trimmed);
            currentLength += trimmed.length + 1;
        }
    }
    // Second pass: fill remaining with first sentences if needed
    if (currentLength < targetChars * 0.5) {
        for (const sentence of sentences) {
            const trimmed = sentence.trim();
            if (!keySentences.includes(trimmed)) {
                if (currentLength + trimmed.length > targetChars) {
                    break;
                }
                keySentences.push(trimmed);
                currentLength += trimmed.length + 1;
            }
        }
    }
    // KEY_SENTENCE_FALLBACK (1.6.2): when the FIRST sentence alone exceeds
    // targetChars the loops above can break before pushing anything —
    // extractKeySentences returned "" and an empty summarized block was
    // injected into the system prompt. Fall back to a truncated first
    // sentence so the result is never empty for non-empty input.
    if (keySentences.length === 0 && sentences.length > 0) {
        const first = sentences[0].trim();
        if (first.length > targetChars) {
            keySentences.push(`${first.slice(0, Math.max(1, targetChars - 3))}...`);
        }
        else {
            keySentences.push(first);
        }
    }
    return keySentences.join(" → ");
}
export function splitCodeAndText(text) {
    const parts = [];
    const codeBlockRegex = /```[\s\S]*?```/g;
    let lastIndex = 0;
    let match = codeBlockRegex.exec(text);
    while (match !== null) {
        if (match.index > lastIndex) {
            const textPart = text.slice(lastIndex, match.index).trim();
            if (textPart) {
                parts.push({ type: "text", content: textPart });
            }
        }
        parts.push({ type: "code", content: match[0] });
        lastIndex = match.index + match[0].length;
        match = codeBlockRegex.exec(text);
    }
    if (lastIndex < text.length) {
        const remaining = text.slice(lastIndex).trim();
        if (remaining) {
            parts.push({ type: "text", content: remaining });
        }
    }
    return parts;
}
/**
 * Main summarization function
 */
export function summarizeContent(text, config) {
    const detection = detectContentType(text);
    const originalLength = text.length;
    // Determine content type
    const contentType = detection.isPureCode
        ? "code"
        : detection.hasCode
            ? "mixed"
            : "text";
    // No summarization
    if (config.mode === "none") {
        // NONE_MODE_NO_TRUNCATE (1.4.6): "none" promises to keep content
        // as-is, but this branch still truncated at textThreshold * 4 chars
        // (1200 with the default threshold). The live recall path already
        // bypasses summarizeContent for mode "none" (index.js), so this was
        // a latent trap for future callers — honor the contract instead.
        return {
            type: "kept",
            content: text,
            originalLength,
            estimatedTokens: estimateTokens(text, contentType),
        };
    }
    // Pure text
    if (contentType === "text") {
        if (text.length <= config.textThreshold) {
            return {
                type: "kept",
                content: text,
                originalLength,
                estimatedTokens: estimateTokens(text, contentType),
            };
        }
        if (config.mode === "truncate") {
            const truncated = truncateText(text, config.summaryTargetChars);
            return {
                type: "truncated",
                content: truncated,
                originalLength,
                estimatedTokens: estimateTokens(truncated, contentType),
            };
        }
        const extracted = extractKeySentences(text, config.summaryTargetChars);
        return {
            type: "summarized",
            content: extracted,
            originalLength,
            estimatedTokens: estimateTokens(extracted, contentType),
        };
    }
    // Pure code
    if (contentType === "code") {
        if (text.length <= config.codeThreshold) {
            return {
                type: "kept",
                content: text,
                originalLength,
                estimatedTokens: estimateTokens(text, contentType),
            };
        }
        const truncated = smartTruncateCode(text, config.maxCodeLines, {
            preserveComments: config.preserveComments,
            preserveImports: config.preserveImports,
        });
        return {
            type: "truncated",
            content: truncated,
            originalLength,
            estimatedTokens: estimateTokens(truncated, contentType),
        };
    }
    // Mixed content
    if (config.mode === "auto" || config.mode === "extract") {
        const parts = splitCodeAndText(text);
        const summarizedParts = [];
        for (const part of parts) {
            if (part.type === "text") {
                if (part.content.length <= config.textThreshold) {
                    summarizedParts.push(part.content);
                }
                else {
                    summarizedParts.push(extractKeySentences(part.content, config.summaryTargetChars / 2));
                }
            }
            else {
                if (part.content.length <= config.codeThreshold) {
                    summarizedParts.push(part.content);
                }
                else {
                    summarizedParts.push(smartTruncateCode(part.content, config.maxCodeLines));
                }
            }
        }
        return {
            type: "mixed",
            content: summarizedParts.join("\n\n"),
            originalLength,
            estimatedTokens: estimateTokens(summarizedParts.join("\n\n"), contentType),
        };
    }
    // Fallback: truncate
    return {
        type: "truncated",
        content: truncateText(text, config.summaryTargetChars),
        originalLength,
        estimatedTokens: estimateTokens(truncateText(text, config.summaryTargetChars), contentType),
    };
}
/**
 * Calculates injection limit based on mode
 */
export function calculateInjectionLimit(results, config) {
    // Filter by injection floor
    const filteredResults = results.filter((r) => r.score >= config.injectionFloor);
    // Fixed mode: simple limit
    if (config.mode === "fixed") {
        return Math.min(config.maxMemories, filteredResults.length);
    }
    // Budget mode: accumulate until budget exhausted
    if (config.mode === "budget") {
        let accumulatedTokens = 0;
        let count = 0;
        for (const result of filteredResults) {
            const tokens = estimateTokens(result.record.text, detectContentType(result.record.text).isPureCode ? "code" : "text");
            if (accumulatedTokens + tokens > config.budgetTokens && count >= config.minMemories) {
                break;
            }
            accumulatedTokens += tokens;
            count += 1;
            if (count >= config.maxMemories) {
                break;
            }
        }
        return Math.max(config.minMemories, Math.min(count, config.maxMemories));
    }
    // Adaptive mode: stop on score drop
    if (config.mode === "adaptive") {
        let count = 0;
        let prevScore = filteredResults[0]?.score ?? 0;
        for (const result of filteredResults) {
            const scoreDrop = prevScore - result.score;
            // Stop if score drops below tolerance (but respect minimum)
            if (scoreDrop > config.scoreDropTolerance && count >= config.minMemories) {
                break;
            }
            count += 1;
            prevScore = result.score;
            if (count >= config.maxMemories) {
                break;
            }
        }
        return Math.max(config.minMemories, Math.min(count, filteredResults.length));
    }
    // Fallback
    return Math.min(config.maxMemories, filteredResults.length);
}
/**
 * Creates default summarization config from injection config
 */
export function createSummarizationConfig(injection) {
    return {
        mode: injection.summarization,
        textThreshold: 300,
        codeThreshold: injection.codeSummarization.pureCodeThreshold,
        summaryTargetChars: injection.summaryTargetChars,
        maxCodeLines: injection.codeSummarization.maxCodeLines,
        codeTruncationMode: injection.codeSummarization.codeTruncationMode,
        preserveComments: injection.codeSummarization.preserveComments,
        preserveImports: injection.codeSummarization.preserveImports,
    };
}
