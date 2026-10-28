/** A receipt is meaningful only inside its correlated terminal native reply. */
export interface NativeInputRecovery {
	schemaVersion: 1;
	scope: "native_transaction";
	status: "verified";
	nativeOperationStopped: true;
	inputReplayed: false;
	verification: "system_input_state";
	operationEventsDispatched: number;
	releaseEventsDispatched: number;
	verifiedKeys: number[];
	verifiedMouseButtons: number[];
	unreleasedKeys: [];
	unreleasedMouseButtons: [];
}

export function verifiedNativeInputRecovery(dispatch: Record<string, unknown>): NativeInputRecovery | undefined {
	const raw = dispatch.inputRecovery;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const receipt = raw as Record<string, unknown>;
	const codes = (value: unknown): value is number[] => Array.isArray(value)
		&& value.every(code => Number.isSafeInteger(code) && code >= 0)
		&& new Set(value).size === value.length;
	const empty = (value: unknown) => Array.isArray(value) && value.length === 0;
	if (dispatch.recoveryRequired !== false || dispatch.retrySafe !== false
		|| !empty(dispatch.unreleasedKeys) || !empty(dispatch.unreleasedMouseButtons)
		|| receipt.schemaVersion !== 1 || receipt.scope !== "native_transaction" || receipt.status !== "verified"
		|| receipt.nativeOperationStopped !== true || receipt.inputReplayed !== false
		|| receipt.verification !== "system_input_state"
		|| !empty(receipt.unreleasedKeys) || !empty(receipt.unreleasedMouseButtons)
		|| !codes(receipt.verifiedKeys) || !codes(receipt.verifiedMouseButtons)
		|| !Number.isSafeInteger(receipt.operationEventsDispatched) || (receipt.operationEventsDispatched as number) <= 0
		|| !Number.isSafeInteger(receipt.releaseEventsDispatched) || (receipt.releaseEventsDispatched as number) < 0
		|| (receipt.operationEventsDispatched as number) + (receipt.releaseEventsDispatched as number) !== dispatch.eventsDispatched
	) return undefined;
	return receipt as unknown as NativeInputRecovery;
}
