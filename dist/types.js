// === Episodic Record Runtime Validation (BL-046) ===
import { z } from "zod";
const ValidationOutcomeSchema = z.object({
    type: z.enum(["type-check", "build", "test"]),
    status: z.enum(["pass", "fail", "skipped"]),
    timestamp: z.number(),
    errorCount: z.number().optional(),
    errorTypes: z.array(z.string()).optional(),
    passedCount: z.number().optional(),
    failedCount: z.number().optional(),
    output: z.string().optional(),
});
const SuccessPatternSchema = z.object({
    commands: z.array(z.string()),
    tools: z.array(z.string()),
    confidence: z.number(),
    extractedAt: z.number(),
});
const RetryAttemptSchema = z.object({
    attemptNumber: z.number(),
    timestamp: z.number(),
    outcome: z.enum(["success", "failed", "abandoned"]),
    errorMessage: z.string().nullish(),
    failureType: z.enum(["syntax", "runtime", "logic", "resource", "unknown"]).nullish(),
});
const RecoveryStrategySchema = z.object({
    name: z.string(),
    attemptedAt: z.number(),
    succeeded: z.boolean(),
});
const EpisodicTaskRecordBaseSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    scope: z.string(),
    taskId: z.string(),
    state: z.enum(["pending", "running", "success", "failed", "timeout"]),
    startTime: z.number(),
    endTime: z.number().nullish(),
    failureType: z.enum(["syntax", "runtime", "logic", "resource", "unknown"]).nullish(),
    errorMessage: z.string().nullish(),
    commandsJson: z.string(),
    validationOutcomesJson: z.string(),
    successPatternsJson: z.string(),
    retryAttemptsJson: z.string(),
    recoveryStrategiesJson: z.string(),
    metadataJson: z.string(),
    taskDescriptionVector: z.array(z.number()).nullish(),
});
export function validateEpisodicRecord(raw) {
    return EpisodicTaskRecordBaseSchema.parse(raw);
}
export function validateEpisodicRecordArray(raw) {
    return z.array(EpisodicTaskRecordBaseSchema).parse(raw);
}
