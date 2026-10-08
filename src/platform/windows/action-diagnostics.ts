/** Diagnostic progress only: never proof of dispatch, completion or safe retry. */
export interface WindowsActionStage { stage: string; elapsedMs: number }
const stages = new Set([
    "request_started", "request_finished", "target_action_started",
    "reference_resolution_started", "reference_resolution_ready",
    "enabled_check_started", "pattern_lookup_started",
    "native_mutation_started", "native_mutation_returned", "post_action_observation_started",
]);
export function sanitizeActionStages(value: unknown): WindowsActionStage[] {
    if (!Array.isArray(value)) return [];
    return value.slice(-32).filter((row): row is WindowsActionStage =>
        !!row && typeof row === "object" && stages.has(row.stage)
        && Number.isSafeInteger(row.elapsedMs) && row.elapsedMs >= 0 && row.elapsedMs <= 86_400_000)
        .map(({ stage, elapsedMs }) => ({ stage, elapsedMs }));
}
export class WindowsActionDiagnostics {
    private buffer = "";
    private dropping = false;
    push(chunk: string, receive: (id: string, stage: WindowsActionStage) => void): void {
        // Discard oversized complete or partial lines without buffering them.
        let start = 0;
        for (;;) {
            const end = chunk.indexOf("\n", start);
            const part = chunk.slice(start, end < 0 ? chunk.length : end);
            if (!this.dropping) {
                if (this.buffer.length + part.length > 1024) { this.buffer = ""; this.dropping = true; }
                else this.buffer += part;
            }
            if (end < 0) break;
            if (!this.dropping) {
                try {
                    const row = JSON.parse(this.buffer);
                    const clean = sanitizeActionStages([row])[0];
                    if (row.event === "cu_action_phase" && typeof row.requestId === "string"
                        && /^[a-zA-Z0-9-]{1,128}$/.test(row.requestId) && clean) receive(row.requestId, clean);
                } catch { /* Non-protocol stderr remains discarded. */ }
            }
            this.buffer = ""; this.dropping = false; start = end + 1;
        }
    }
}
