/** Versioned evidence from validation that runs before native input dispatch. */
export interface ActionPreflightReceipt {
	version: 1;
	phase: "before_input";
	inputDispatched: false;
	recoverable: true;
	recovery: "correct_call" | "observe_ui" | "observe_visual";
}

export class ActionPreflightError extends Error {
	readonly code = "cu_preflight_rejected";
	readonly preflight: ActionPreflightReceipt;

	constructor(message: string, recovery: ActionPreflightReceipt["recovery"] = "correct_call") {
		super(`${message}\nInput was not sent. Correct the call or refresh its observation and continue.`);
		this.name = "ActionPreflightError";
		this.preflight = { version: 1, phase: "before_input", inputDispatched: false, recoverable: true, recovery };
	}
}

export function validateBeforeInput<T>(work: () => T): T {
	try { return work(); }
	catch (error) {
		if (error instanceof ActionPreflightError) throw error;
		throw new ActionPreflightError(error instanceof Error ? error.message : String(error));
	}
}
