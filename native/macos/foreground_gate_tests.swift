import Foundation

private let target = ForegroundTargetIdentity(pid: 22560, windowId: 33129)

private func gateReport(_ actual: ForegroundActualIdentity, focused: Bool = true, main: Bool = true, pidStable: Bool = true) -> ForegroundGateReport {
	ForegroundGateReport(
		target: target,
		actual: actual,
		focusedWindowMatches: focused,
		targetIsMain: main,
		frontmostPidStable: pidStable
	)
}

private func dispatches(_ report: ForegroundGateReport) -> Bool {
	let state = ForegroundInputDispatchState()
	var sink: [ForegroundInputEvent] = []
	let dispatched = dispatchForegroundEventIfVerified(report, event: .other, dispatch: state) {
		sink.append(.other)
	}
	precondition(dispatched == (sink.count == 1), "gate result must match whether the fake HID sink emitted")
	if !report.verified {
		precondition(sink.isEmpty, "unverified target must emit zero keyboard/mouse events")
		precondition(report.details["verified"] as? Bool == false)
		precondition(report.details["target"] != nil)
		precondition(report.details["actualForeground"] != nil)
		let result = foregroundRejectedActResult(details: foregroundFailureDetails(report: report, dispatch: state))
		precondition(result["outcome"] as? String == "didnt")
		precondition((result["error"] as? [String: Any])?["code"] as? String == "foreground_target_unverified")
		precondition(((result["evidence"] as? [String: Any])?["foregroundVerification"] as? [String: Any])?["target"] != nil)
	}
	return dispatched
}

private func sendSequence(_ events: [ForegroundInputEvent], reports: [ForegroundGateReport]) -> (sink: [ForegroundInputEvent], result: [String: Any]?) {
	precondition(events.count == reports.count)
	let state = ForegroundInputDispatchState()
	var sink: [ForegroundInputEvent] = []
	for (event, report) in zip(events, reports) {
		guard dispatchForegroundEventIfVerified(report, event: event, dispatch: state, emit: { sink.append(event) }) else {
			return (sink, foregroundRejectedActResult(details: foregroundFailureDetails(report: report, dispatch: state)))
		}
	}
	return (sink, nil)
}

private func assertPartial(_ result: [String: Any]?, count: Int, keys: [Int], buttons: [Int] = []) {
	guard let result else { preconditionFailure("expected foreground loss to stop the fake event sequence") }
	precondition(result["outcome"] as? String == "unknown", "partial HID dispatch must be unknown")
	precondition((result["error"] as? [String: Any])?["code"] as? String == "foreground_interrupted_after_partial_hid")
	guard let verification = (result["evidence"] as? [String: Any])?["foregroundVerification"] as? [String: Any],
		let dispatch = verification["inputDispatch"] as? [String: Any]
	else { preconditionFailure("partial result must include structured dispatch state") }
	precondition(dispatch["eventsDispatched"] as? Int == count)
	precondition(dispatch["unreleasedKeys"] as? [Int] == keys)
	precondition(dispatch["unreleasedMouseButtons"] as? [Int] == buttons)
	precondition(dispatch["recoveryRequired"] as? Bool == true)
	precondition(dispatch["retrySafe"] as? Bool == false)
}

@main
private struct ForegroundGateTests {
	static func main() {
		let correct = ForegroundActualIdentity(pid: target.pid, windowId: target.windowId)
		precondition(dispatches(gateReport(correct)))

		// A different window in the same process is not the requested target.
		precondition(!dispatches(gateReport(ForegroundActualIdentity(pid: target.pid, windowId: target.windowId + 1), focused: false)))

		// A raise request can return without producing focused/main state; attempt booleans do not authorize input.
		precondition(!dispatches(gateReport(correct, focused: false, main: false)))

		// A foreground steal, missing identity, or visible PID race rejects before the fake sink sees it.
		precondition(!dispatches(gateReport(ForegroundActualIdentity(pid: 888, windowId: 44), focused: false, main: false)))
		precondition(!dispatches(gateReport(ForegroundActualIdentity(pid: target.pid, windowId: nil))))
		precondition(!dispatches(gateReport(correct, pidStable: false)))

		// Preserve both mapping samples when the first AX/CG resolution succeeds
		// and the second loses its window identity. This is diagnostic metadata,
		// not permission to emit input or a reason to fall back to a cached ID.
		var mappingRace = gateReport(ForegroundActualIdentity(pid: target.pid, windowId: nil))
		mappingRace.firstActual = correct
		mappingRace.firstDiagnostics = ["mappingStage": "focused_element_unique_pairing", "cgCandidateCount": 2]
		mappingRace.secondDiagnostics = ["mappingStage": "no_valid_CG_pairing", "ambiguous": true]
		let mappingDetails = mappingRace.details
		precondition((mappingDetails["firstActual"] as? [String: Any])?["windowId"] as? Int == Int(target.windowId))
		precondition((mappingDetails["firstMapping"] as? [String: Any])?["mappingStage"] as? String == "focused_element_unique_pairing")
		precondition((mappingDetails["secondMapping"] as? [String: Any])?["ambiguous"] as? Bool == true)

		let frame = CGRect(origin: CGPoint(x: 10, y: 20), size: CGSize(width: 800, height: 600))
		let validOrigin = CGPoint(x: 0, y: 0)
		let validSize = CGSize(width: 800, height: 600)
		precondition(strictFocusedFrame(origin: nil, size: validSize) == nil)
		precondition(strictFocusedFrame(origin: validOrigin, size: nil) == nil)
		precondition(strictFocusedFrame(origin: CGPoint(x: CGFloat.nan, y: 0), size: validSize) == nil)
		precondition(strictFocusedFrame(origin: validOrigin, size: CGSize(width: CGFloat.infinity, height: 600)) == nil)
		if let strict = strictFocusedFrame(origin: validOrigin, size: validSize) {
			precondition(strict.origin.x == 0 && strict.origin.y == 0 && strict.size.width == 800 && strict.size.height == 600)
		} else {
			preconditionFailure("valid origin and size must produce a frame")
		}
		let axWindow = [FocusedAXNodeSnapshot(token: "window-0", frame: frame, title: "Doc", isSheet: false)]
		let exactCandidate = [FocusedCGCandidateSnapshot(windowId: 700, ownerPid: target.pid, frame: frame, title: "Doc", isOnscreen: true)]
		precondition(decideFocusedMapping(focusedToken: "window-0", axNodes: axWindow, candidates: exactCandidate, targetPid: target.pid).selectedWindowId == 700)
		// A same-title candidate with wrong geometry is not identity proof.
		let wrongGeometry = [FocusedCGCandidateSnapshot(windowId: 701, ownerPid: target.pid, frame: CGRect(origin: CGPoint(x: 20, y: 20), size: CGSize(width: 800, height: 600)), title: "Doc", isOnscreen: true)]
		precondition(decideFocusedMapping(focusedToken: "window-0", axNodes: axWindow, candidates: wrongGeometry, targetPid: target.pid).selectedWindowId == nil)
		// Missing geometry and a duplicate geometry both fail closed.
		let noGeometry = [FocusedCGCandidateSnapshot(windowId: 702, ownerPid: target.pid, frame: nil, title: "Doc", isOnscreen: true)]
		precondition(decideFocusedMapping(focusedToken: "window-0", axNodes: axWindow, candidates: noGeometry, targetPid: target.pid).stage == "no_valid_cg_candidate")
		let duplicate = exactCandidate + [FocusedCGCandidateSnapshot(windowId: 703, ownerPid: target.pid, frame: frame, title: "Doc", isOnscreen: true)]
		let duplicateDecision = decideFocusedMapping(focusedToken: "window-0", axNodes: axWindow, candidates: duplicate, targetPid: target.pid)
		precondition(duplicateDecision.stage == "ambiguous_cg_candidate" && duplicateDecision.selectedWindowId == nil)
		// Sheets are first-class AX nodes; they do not inherit a parent token.
		let sheet = [FocusedAXNodeSnapshot(token: "window-0-sheet-0", frame: frame, title: "Doc", isSheet: true)]
		precondition(decideFocusedMapping(focusedToken: "window-0-sheet-0", axNodes: sheet, candidates: exactCandidate, targetPid: target.pid).selectedWindowId == 700)
		// A requested PID must not be confused with a different actual owner.
		precondition(decideFocusedMapping(focusedToken: "window-0", axNodes: axWindow, candidates: [FocusedCGCandidateSnapshot(windowId: 704, ownerPid: target.pid + 1, frame: frame, title: "Doc", isOnscreen: true)], targetPid: target.pid).selectedWindowId == nil)

		// Losing focus before the first event is a definite no-effect rejection.
		let beforeFirst = sendSequence([.keyDown(36, modifiers: [])], reports: [gateReport(correct, focused: false)])
		precondition(beforeFirst.sink.isEmpty)
		precondition(beforeFirst.result?["outcome"] as? String == "didnt")
		precondition((beforeFirst.result?["error"] as? [String: Any])?["code"] as? String == "foreground_target_unverified")

		// Losing focus between key-down and key-up is unknown. The fake sink sees
		// only down; no blind key-up is emitted after focus has moved.
		let keyPair = sendSequence([.keyDown(36, modifiers: []), .keyUp(36, modifiers: [])], reports: [gateReport(correct), gateReport(ForegroundActualIdentity(pid: 888, windowId: 44), focused: false, main: false)])
		precondition(keyPair.sink == [.keyDown(36, modifiers: [])])
		assertPartial(keyPair.result, count: 1, keys: [36])

		// A multi-character text sequence interrupted on event N reports the
		// three emitted events and the second key still down, without text content.
		let textEvents: [ForegroundInputEvent] = [.keyDown(0, modifiers: []), .keyUp(0, modifiers: []), .keyDown(1, modifiers: []), .keyUp(1, modifiers: []), .keyDown(2, modifiers: []), .keyUp(2, modifiers: [])]
		let textReports = [gateReport(correct), gateReport(correct), gateReport(correct), gateReport(correct, focused: false), gateReport(correct), gateReport(correct)]
		let text = sendSequence(textEvents, reports: textReports)
		precondition(text.sink == [.keyDown(0, modifiers: []), .keyUp(0, modifiers: []), .keyDown(1, modifiers: [])])
		assertPartial(text.result, count: 3, keys: [1])

		// A drag interrupted before button-up records the outstanding mouse state.
		let drag = sendSequence([.mouseDown(0), .other, .mouseUp(0)], reports: [gateReport(correct), gateReport(correct), gateReport(correct, focused: false)])
		precondition(drag.sink == [.mouseDown(0), .other])
		assertPartial(drag.result, count: 2, keys: [], buttons: [0])

		// A modifier chord carries modifier state in the dispatched key-down flags;
		// retain both identities if focus is lost before key-up.
		let chord = sendSequence([.keyDown(0, modifiers: [55]), .keyUp(0, modifiers: [55])], reports: [gateReport(correct), gateReport(correct, focused: false)])
		precondition(chord.sink == [.keyDown(0, modifiers: [55])])
		assertPartial(chord.result, count: 1, keys: [0, 55])

		print("native foreground gate tests passed")
	}
}
