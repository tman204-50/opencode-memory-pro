import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

const SERVICE_NAME = "opencode-memory-pro";
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let _client = null;
let _minLevel = LOG_LEVELS.info;
let _logFile = null;

function expandHomePath(path) {
    if (typeof path !== "string" || path.length === 0)
        return path;
    if (path === "~")
        return homedir();
    if (path.startsWith("~/"))
        return join(homedir(), path.slice(2));
    if (!isAbsolute(path))
        return join(process.cwd(), path);
    return path;
}

function formatLine(level, message, extra) {
    const timestamp = new Date().toISOString();
    let line = `[${timestamp}] [${level.toUpperCase().padEnd(5)}] [${SERVICE_NAME}] ${message}`;
    if (extra !== undefined) {
        try {
            line += ` ${JSON.stringify(extra)}`;
        }
        catch {
            line += ` ${String(extra)}`;
        }
    }
    return line;
}

function writeFileLog(level, message, extra) {
    if (!_logFile)
        return;
    try {
        appendFileSync(_logFile, formatLine(level, message, extra) + "\n", "utf8");
    }
    catch {
        // File sink must never throw into the plugin flow — if the file is
        // unwritable we degrade silently; the bus/console fallback still runs.
    }
}

export function initLogger(client) {
    _client = client;
    if (process.env.OPENCODE_MEMORY_PRO_LOG_FILE) {
        configureLogger({
            logLevel: process.env.OPENCODE_MEMORY_PRO_LOG_LEVEL,
            logFile: process.env.OPENCODE_MEMORY_PRO_LOG_FILE,
        });
    }
}

// Applies logger settings. Called from the plugin config hook once sidecar
// config has been resolved (see resolveMemoryConfig -> logging section).
// Idempotent: safe to call on every config re-resolution.
export function configureLogger(opts = {}) {
    if (opts && typeof opts === "object") {
        // Accept both spellings: env path passes logLevel/logFile (initLogger),
        // config path passes level/file (resolveMemoryConfig -> logging).
        const file = opts.logFile ?? opts.file;
        if (file) {
            const expanded = expandHomePath(file);
            try {
                mkdirSync(dirname(expanded), { recursive: true });
                _logFile = expanded;
            }
            catch (error) {
                const err = error instanceof Error ? error.message : String(error);
                console.warn(`[${SERVICE_NAME}] failed to open log file ${expanded}: ${err}`);
                _logFile = null;
            }
        }
        const level = opts.logLevel ?? opts.level;
        if (level && LOG_LEVELS[level] !== undefined) {
            _minLevel = LOG_LEVELS[level];
        }
    }
}

// Routes to client.app.log() when SDK client is bound, otherwise falls back to
// console. Also appends to the configured log file when one is set.
export function log(level, message, extra) {
    const lvl = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    if (lvl < _minLevel)
        return;
    writeFileLog(level, message, extra);
    if (_client?.app?.log) {
        _client.app
            .log({
            body: {
                service: SERVICE_NAME,
                level,
                message,
                ...(extra !== undefined ? { extra } : {}),
            },
        })
            .catch(() => consoleFallback(level, message));
        return;
    }
    consoleFallback(level, message);
}

function consoleFallback(level, message) {
    const formatted = `[${SERVICE_NAME}] ${message}`;
    switch (level) {
        case "error":
            console.error(formatted);
            break;
        case "warn":
            console.warn(formatted);
            break;
        case "info":
            console.info(formatted);
            break;
        default:
            console.log(formatted);
            break;
    }
}

// File-sink-only logging: writes to the configured log file but never to the
// opencode /log bus or the console. Used for known-benign noise (e.g. LanceDB
// optimize commit-conflict warnings) that should stay out of the TUI while
// remaining debuggable in the plugin log.
export function logFileOnly(level, message, extra) {
    const lvl = LOG_LEVELS[level] ?? LOG_LEVELS.info;
    if (lvl < _minLevel)
        return;
    writeFileLog(level, message, extra);
}