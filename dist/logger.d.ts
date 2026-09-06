import type { OpencodeClient } from "@opencode-ai/sdk";
type LogLevel = "debug" | "info" | "warn" | "error";
export declare function initLogger(client: OpencodeClient): void;
export declare function configureLogger(opts: {
    logLevel?: string;
    logFile?: string;
}): void;
export declare function log(level: LogLevel, message: string, extra?: Record<string, unknown>): void;
export declare function logFileOnly(level: LogLevel, message: string, extra?: Record<string, unknown>): void;
export {};
