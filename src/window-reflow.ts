/** Treat malformed or contradictory helper replies as uncertain, never as success. */
export function classifyWindowReflow(value: unknown): "not_sent" | "returned" | "partial_or_unknown" {
	if (!value || typeof value !== "object") return "partial_or_unknown";
	const row = value as Record<string, unknown>;
	const receipt = row.receipt && typeof row.receipt === "object" ? row.receipt as Record<string, unknown> : {};
	if (row.operation !== "window_reflow" || !Array.isArray(row.steps) || receipt.uiaRecoveryVerified !== false || receipt.originalInputRetryProhibited !== true) return "partial_or_unknown";
	if (row.dispatchCompletion === "not_sent" && receipt.outcome === "rejected_before_mutation" && receipt.mutationAttempts === 0 && row.steps.length === 0) return "not_sent";
	if (row.dispatchCompletion === "returned" && receipt.outcome === "geometry_restored" && receipt.mutationAttempts === 2 && row.steps.length === 2
		&& row.steps.every((step: unknown) => {
			if (!step || typeof step !== "object") return false;
			const value = step as Record<string, any>;
			return !value.error && value.inputDispatch?.recoveryRequired !== true && value.performed?.drag?.leftDownAfter === false;
		})) return "returned";
	return "partial_or_unknown";
}
