import Foundation

@main
private struct InputRecoveryTests {
	static func main() throws {
		let state = ForegroundInputDispatchState()
		state.record(.keyDown(55, modifiers: [55]))
		state.record(.keyDown(31, modifiers: [55]))
		state.record(.mouseDown(0))
		var sink: [ForegroundInputEvent] = []
		for event in [ForegroundInputEvent.keyDown(1, modifiers: [55]), .keyUp(1, modifiers: [55]), .mouseUp(1), .other] {
			precondition(!dispatchOwnedInputCleanup(event, dispatch: state) { sink.append(event) })
		}
		precondition(sink.isEmpty)
		state.settle(release: { event in dispatchOwnedInputCleanup(event, dispatch: state) { sink.append(event) } },
			verify: { ForegroundInputReleaseVerification(complete: true) })
		precondition(sink == [.mouseUp(0), .keyUp(31, modifiers: [55]), .keyUp(55, modifiers: [])])
		precondition(state.pressedKeys.isEmpty && state.pressedMouseButtons.isEmpty)
		let receipt = state.details["inputRecovery"] as! [String: Any]
		precondition(receipt["status"] as? String == "verified")
		precondition(receipt["releaseEventsDispatched"] as? Int == 3)
		precondition(receipt["inputReplayed"] as? Bool == false)
		precondition(ownedCleanupModifierCodes(observed: [54,55,56], owned: [55,31], remaining: []) == [54,56])
		precondition(ownedCleanupModifierCodes(observed: [55,60], owned: [55,31], remaining: [55]) == [55,60])

		let complete: [[String: Any]] = [["source": 0, "heldKeys": [31,53], "heldMouseButtons": []],
			["source": 1, "heldKeys": [31,53], "heldMouseButtons": []]]
		precondition(nativeInputResetSampleAllowed(complete, keys: [31,53], buttons: []))
		precondition(!nativeInputResetSampleAllowed(complete, keys: [31], buttons: []))
		precondition(!nativeInputResetSampleAllowed([complete[0]], keys: [31,53], buttons: []))
		precondition(!nativeInputResetSampleAllowed([complete[0],complete[0]], keys: [31,53], buttons: []))
		precondition(!nativeInputResetSampleAllowed([["source": 0], complete[1]], keys: [31,53], buttons: []))
		let sha = String(repeating: "a", count: 64)
		let plan = NativeInputResetPlan(schemaVersion: 1, operationId: UUID().uuidString, mode: "scoped-reset",
			bootId: "boot", queuePath: "/state/desktop-queue.json", queueEpoch: 3, maintenanceOwner: "operator",
			expiresAtMs: 100_001, executableSha256: sha, helperExecutables: ["/data/helper.app/Contents/MacOS/bridge"],
			keys: [31,53], mouseButtons: [], reason: "Repair the observed legacy input residue")
		let queue: [String: Any] = ["blocked": true, "inFlight": false, "maintenanceOwner": "operator", "bootId": "boot", "epoch": 3, "jobs": [["state": "queued"]]]
		func valid(_ sample: [String: Any], boot: String? = "boot", now: UInt64 = 50_001, digest: String = String(repeating: "a", count: 64)) -> Bool {
			nativeInputResetPlanIsValid(plan, bootId: boot, nowMs: now, queue: sample, executableSha256: digest)
		}
		precondition(valid(queue))
		for (key, value): (String, Any) in [("blocked", false), ("inFlight", true), ("maintenanceOwner", "another"),
			("bootId", "other"), ("epoch", 4), ("jobs", [["state": "active"]]), ("jobs", [["state": "draining"]])] {
			var changed = queue; changed[key] = value; precondition(!valid(changed))
		}
		precondition(!valid(queue, boot: nil)); precondition(!valid(queue, boot: "other"))
		precondition(!valid(queue, now: 100_001)); precondition(!valid(queue, now: 1))
		precondition(!valid(queue, digest: String(repeating: "b", count: 64)))
		let directory = FileManager.default.temporaryDirectory.appendingPathComponent("cu-input-journal-" + UUID().uuidString)
		setenv("PI_COMPUTER_USE_INPUT_JOURNAL_DIR", directory.path, 1)
		defer { unsetenv("PI_COMPUTER_USE_INPUT_JOURNAL_DIR"); try? FileManager.default.removeItem(at: directory) }
		let journaled = ForegroundInputDispatchState()
		try persistNativeInputJournal(journaled, helperSha256: sha, prepared: .keyDown(31, modifiers: []))
		let file = directory.appendingPathComponent(journaled.transactionId + ".json")
		var record = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
		precondition(record["ownedKeys"] as? [Int] == [] && record["pendingKeys"] as? [Int] == [])
		precondition((record["preparedEvent"] as? [String: Any])?["kind"] as? String == "keyDown")
		journaled.record(.keyDown(31, modifiers: [])); try persistNativeInputJournal(journaled, helperSha256: sha)
		record = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [String: Any]
		precondition(record["ownedKeys"] as? [Int] == [31] && record["pendingKeys"] as? [Int] == [31])
		precondition(record["preparedEvent"] == nil && record["phase"] as? String == "acknowledged")
		let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
		precondition((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
		try FileManager.default.setAttributes([.posixPermissions: 0o777], ofItemAtPath: directory.path)
		do { try persistNativeInputJournal(journaled, helperSha256: sha); preconditionFailure("untrusted journal root must refuse a write") }
		catch NativeInputRecoveryFailure.refused(_) { }
		var cleanup: [ForegroundInputEvent] = []
		precondition(dispatchOwnedInputCleanup(.keyUp(31, modifiers: []), dispatch: journaled) { cleanup.append(.keyUp(31, modifiers: [])) })
		precondition(cleanup == [.keyUp(31, modifiers: [])], "journal I/O failure cannot strand transaction-owned input")
		print("owned input cleanup, foreign modifiers, native reset scope and admission guards passed without OS input")
	}
}
