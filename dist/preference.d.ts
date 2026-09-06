import type { MemoryRecord, Preference, PreferenceScope, PreferenceSignal, PreferenceProfile } from "./types.js";
export declare function extractPreferenceSignals(memory: MemoryRecord): PreferenceSignal[];
export declare function aggregatePreferences(signals: PreferenceSignal[], scope: PreferenceScope): PreferenceProfile;
export declare function resolveConflicts(projectPrefs: Preference[], globalPrefs: Preference[]): Preference[];
export interface InjectionConfig {
    mode: "budget" | "fixed";
    maxMemories: number;
    tokenBudget?: number;
}
export declare function buildPreferenceInjection(preferences: Preference[], config: InjectionConfig): string;
