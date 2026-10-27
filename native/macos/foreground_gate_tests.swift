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
		do {
		let up = [0, 1].map { ForegroundInputStateSample(sourceState: $0, pressedKeys: [], pressedMouseButtons: []) }
		let held = [ForegroundInputStateSample(sourceState: 0, pressedKeys: [], pressedMouseButtons: []),
			ForegroundInputStateSample(sourceState: 1, pressedKeys: [13], pressedMouseButtons: [])]
		let idle = ForegroundInputDispatchState()
		let preflight = inputStateRejectedActResult(details: inputStateFailureDetails(phase: "before_dispatch", samples: held, dispatch: idle))
		precondition(preflight["outcome"] as? String == "didnt")
		precondition(preflight["inputDispatch"] == nil && idle.pressedKeys.isEmpty, "a pre-held user key is not owned by the action")
		// Simulate a complete posted chord whose W key-up was dropped by the
		// event system. An empty emitted-event ledger is not release proof.
		let completed = ForegroundInputDispatchState()
		for event in foregroundKeyChordEvents(code: 13, modifiers: [55])! { completed.record(event) }
		precondition(completed.pressedKeys.isEmpty)
		var reads = 0, pauses = 0
		let failure = waitForForegroundInputRelease(sample: { reads += 1; return held }, pause: { pauses += 1 })!
		precondition(reads == 4 && pauses == 3, "release verification must be bounded and read-only")
		let unknown = inputStateRejectedActResult(details: inputStateFailureDetails(phase: "after_release", samples: failure, dispatch: completed))
		precondition(unknown["outcome"] as? String == "unknown")
		let report = unknown["inputDispatch"] as! [String: Any]
		precondition(report["unreleasedKeys"] as? [Int] == [13])
		precondition(report["recoveryRequired"] as? Bool == true && report["retrySafe"] as? Bool == false)
		precondition(!isOwnedForegroundKeyRelease(.keyUp(13, modifiers: []), dispatch: completed), "uncertain observed input never creates release authority")
		reads = 0
		precondition(waitForForegroundInputRelease(sample: { reads += 1; return reads < 3 ? held : up }, pause: {}) == nil)
		precondition(reads == 3, "a delayed release may be confirmed without replay")
		precondition(waitForForegroundInputRelease(sample: { [up[0]] }, pause: {}) != nil, "one source table cannot prove release")
		let mouse = [0, 1].map { ForegroundInputStateSample(sourceState: $0, pressedKeys: [], pressedMouseButtons: [0]) }
		let click = ForegroundInputDispatchState(); click.record(.mouseDown(0)); click.record(.mouseUp(0))
		let mouseFailure = inputStateRejectedActResult(details: inputStateFailureDetails(phase: "after_release", samples: mouse, dispatch: click))
		precondition((mouseFailure["inputDispatch"] as? [String: Any])?["unreleasedMouseButtons"] as? [Int] == [0])
		}

		do {
		// Cmd+W can close the last document on key-down. Independently proven
		// closure permits only the releases already owned by that transaction.
		let chord = foregroundKeyChordEvents(code: 13, modifiers: [55])!
		let original = gateReport(ForegroundActualIdentity(pid: target.pid, windowId: target.windowId))
		var closed = gateReport(ForegroundActualIdentity(pid: target.pid, windowId: nil), focused: false, main: false)
		closed.firstActual = closed.actual
		let proof = ForegroundClosedTargetSample(axWindowCount: 0, cgTargetExists: false)
		precondition(provenClosedForegroundTarget(closed, first: proof, second: proof))
		for sample in [ForegroundClosedTargetSample(axWindowCount: nil, cgTargetExists: false),
			ForegroundClosedTargetSample(axWindowCount: 1, cgTargetExists: false),
			ForegroundClosedTargetSample(axWindowCount: 0, cgTargetExists: nil),
			ForegroundClosedTargetSample(axWindowCount: 0, cgTargetExists: true)] {
			precondition(!provenClosedForegroundTarget(closed, first: sample, second: proof))
			precondition(!provenClosedForegroundTarget(closed, first: proof, second: sample))
		}
		closed.ownedTargetClosedWithoutReplacement = true
		let completed = sendSequence(chord, reports: [original, original, closed, closed])
		precondition(completed.sink == chord && completed.result == nil)
		precondition(!shouldReobserveForegroundRead(closed, releasingOwnedKey: true))
		let empty = ForegroundInputDispatchState()
		precondition(!dispatchForegroundEventIfVerified(closed, event: .keyUp(13, modifiers: []), dispatch: empty, emit: { preconditionFailure() }))
		let held = ForegroundInputDispatchState()
		for event in chord.prefix(2) { held.record(event) }
		for event in [ForegroundInputEvent.keyDown(1, modifiers: [55]), .mouseDown(0), .mouseUp(0), .other, .keyUp(1, modifiers: [55]), .keyUp(13, modifiers: [])] {
			precondition(!dispatchForegroundEventIfVerified(closed, event: event, dispatch: held, emit: { preconditionFailure() }))
		}
		var unproved = closed; unproved.ownedTargetClosedWithoutReplacement = false
		var racing = closed; racing.frontmostPidStable = false
		var changed = closed; changed.firstActual = original.actual
		var foreign = gateReport(ForegroundActualIdentity(pid: 99, windowId: nil), focused: false, main: false)
		foreign.firstActual = foreign.actual; foreign.ownedTargetClosedWithoutReplacement = true
		var replaced = gateReport(ForegroundActualIdentity(pid: target.pid, windowId: target.windowId + 1), focused: false, main: false)
		replaced.firstActual = replaced.actual; replaced.ownedTargetClosedWithoutReplacement = true
		var stillMain = gateReport(closed.actual, focused: false, main: true)
		stillMain.firstActual = stillMain.actual; stillMain.ownedTargetClosedWithoutReplacement = true
		for invalid in [unproved, racing, changed, foreign, replaced, stillMain] {
			precondition(!dispatchForegroundEventIfVerified(invalid, event: .keyUp(13, modifiers: [55]), dispatch: held, emit: { preconditionFailure() }))
		}
		for invalid in [racing, changed, foreign, replaced, stillMain] {
			precondition(!provenClosedForegroundTarget(invalid, first: proof, second: proof))
		}
		var chordCases = 0, interruptionCases = 0
		for mask in 0..<16 {
			let modifiers = [55, 56, 58, 59].enumerated().filter { mask & (1 << $0.offset) != 0 }.map(\.element)
			for code in 0...127 where !foregroundModifierKeyCodes.contains(code) {
				let events = foregroundKeyChordEvents(code: code, modifiers: modifiers)!
				let pressedCount = modifiers.count + 1
				let reports = Array(repeating: original, count: pressedCount) + Array(repeating: closed, count: events.count - pressedCount)
				let balanced = sendSequence(events, reports: reports)
				precondition(balanced.result == nil && balanced.sink == events, "closed-window release must work for every supported chord shape")
				chordCases += 1
				for cut in 0..<events.count {
					let stopped = sendSequence(events, reports: Array(repeating: original, count: cut) + Array(repeating: foreign, count: events.count - cut))
					precondition(stopped.sink == Array(events.prefix(cut)), "foreground loss must stop without replaying or sending new input")
					precondition(stopped.result?["outcome"] as? String == (cut == 0 ? "didnt" : "unknown"))
					interruptionCases += 1
				}
			}
		}
		print("verified \(chordCases) closed-window chord shapes and \(interruptionCases) interrupted dispatch boundaries without OS input")
		}
		do {
		let owned: (Int32?, String?, Int32?, String?, Bool, Bool) -> Bool = { sheetPid, sheetRole, parentPid, parentRole, main, direct in
			isOwnedModalSheet(targetPid: target.pid, sheetPid: sheetPid, sheetRole: sheetRole,
				parentPid: parentPid, parentRole: parentRole, parentIsMain: main, directlyOwned: direct)
		}
		precondition(owned(target.pid, "AXSheet", target.pid, "AXWindow", true, true))
		precondition(!owned(nil, "AXSheet", target.pid, "AXWindow", true, true))
		precondition(!owned(target.pid + 1, "AXSheet", target.pid, "AXWindow", true, true))
		precondition(!owned(target.pid, "AXSheet", target.pid + 1, "AXWindow", true, true))
		precondition(!owned(target.pid, "AXWindow", target.pid, "AXWindow", true, true))
		precondition(!owned(target.pid, "AXSheet", target.pid, "AXSheet", true, true))
		precondition(!owned(target.pid, "AXSheet", target.pid, "AXWindow", false, true))
		precondition(!owned(target.pid, "AXSheet", target.pid, "AXWindow", true, false))
		let correct = ForegroundActualIdentity(pid: target.pid, windowId: target.windowId)
		var sheet = gateReport(correct, main: false)
		precondition(!sheet.verified, "an arbitrary non-main window remains ineligible")
		sheet.targetIsOwnedModalSheet = true
		precondition(sheet.verified)
		let escape: [ForegroundInputEvent] = [.keyDown(53, modifiers: []), .keyUp(53, modifiers: [])]
		precondition(sendSequence(escape, reports: [sheet, sheet]).sink == escape)
		for event in [ForegroundInputEvent.mouseDown(0), .mouseUp(0), .other] {
			precondition(!dispatchForegroundEventIfVerified(sheet, event: event, dispatch: ForegroundInputDispatchState(), emit: { preconditionFailure() }))
		}
		var wrongWindow = gateReport(ForegroundActualIdentity(pid: target.pid, windowId: target.windowId + 1), main: false)
		wrongWindow.targetIsOwnedModalSheet = true
		var noFocus = gateReport(correct, focused: false, main: false)
		noFocus.targetIsOwnedModalSheet = true
		var racing = gateReport(correct, main: false, pidStable: false)
		racing.targetIsOwnedModalSheet = true
		for invalid in [wrongWindow, noFocus, racing] {
			precondition(!dispatchForegroundEventIfVerified(invalid, event: escape[0], dispatch: ForegroundInputDispatchState(), emit: { preconditionFailure() }))
		}
		// Escape may dismiss the sheet on key-down. Only balance keys already
		// owned by this transaction back to its independently proven main parent.
		let parent = ForegroundActualIdentity(pid: target.pid, windowId: target.windowId + 10)
		var returned = gateReport(parent, focused: false, main: false)
		returned.firstActual = parent
		returned.ownedModalParentWindowId = parent.windowId
		let completed = sendSequence(escape, reports: [sheet, returned])
		precondition(completed.sink == escape && completed.result == nil)
		let held = ForegroundInputDispatchState()
		held.record(escape[0])
		for event in [ForegroundInputEvent.keyDown(4, modifiers: []), .keyUp(4, modifiers: []), .mouseUp(0), .other] {
			precondition(!dispatchForegroundEventIfVerified(returned, event: event, dispatch: held, emit: { preconditionFailure() }))
		}
		precondition(!dispatchForegroundEventIfVerified(returned, event: escape[1], dispatch: ForegroundInputDispatchState(), emit: { preconditionFailure() }))
		var missingParent = returned
		missingParent.ownedModalParentWindowId = nil
		var changedParent = gateReport(ForegroundActualIdentity(pid: target.pid, windowId: target.windowId + 11), focused: false, main: false)
		changedParent.firstActual = parent
		changedParent.ownedModalParentWindowId = parent.windowId
		var changedPid = gateReport(ForegroundActualIdentity(pid: target.pid + 1, windowId: target.windowId + 10), focused: false, main: false)
		changedPid.firstActual = parent
		changedPid.ownedModalParentWindowId = parent.windowId
		var unstable = returned
		unstable.frontmostPidStable = false
		var changedSample = returned
		changedSample.firstActual = correct
		precondition(!shouldReobserveForegroundRead(changedSample, releasingOwnedKey: true))
		var closingTransition = changedSample
		closingTransition.ownedModalParentTransitionObserved = true
		precondition(!shouldReobserveForegroundRead(closingTransition))
		precondition(shouldReobserveForegroundRead(closingTransition, releasingOwnedKey: true))
		precondition(!dispatchForegroundEventIfVerified(closingTransition, event: escape[1], dispatch: held, emit: { preconditionFailure() }))
		var foreignTransition = closingTransition
		foreignTransition.frontmostPidStable = false
		precondition(!shouldReobserveForegroundRead(foreignTransition, releasingOwnedKey: true))
		foreignTransition = closingTransition
		foreignTransition.ownedModalParentWindowId = target.windowId + 11
		precondition(!shouldReobserveForegroundRead(foreignTransition, releasingOwnedKey: true))
		for invalid in [missingParent, changedParent, changedPid, unstable, changedSample] {
			precondition(!dispatchForegroundEventIfVerified(invalid, event: escape[1], dispatch: held, emit: { preconditionFailure() }))
		}
		let chord = foregroundKeyChordEvents(code: 53, modifiers: [55, 56])!
		let chordDone = sendSequence(chord, reports: Array(repeating: sheet, count: 3) + Array(repeating: returned, count: 3))
		precondition(chordDone.sink == chord && chordDone.result == nil)
		}

		do {
		// A proven direct child sheet may receive only the remaining releases
		// of this transaction. Same PID alone still grants nothing.
		let chord = foregroundKeyChordEvents(code: 1, modifiers: [55, 56])!
		var sheet = gateReport(ForegroundActualIdentity(pid: target.pid, windowId: target.windowId + 1), focused: false)
		sheet.firstActual = sheet.actual
		sheet.ownedSheetWindowId = target.windowId + 1
		let original = gateReport(ForegroundActualIdentity(pid: target.pid, windowId: target.windowId))
		let completed = sendSequence(chord, reports: [original, original, original, sheet, sheet, sheet])
		precondition(completed.sink == chord && completed.result == nil)
		let empty = ForegroundInputDispatchState()
		precondition(!dispatchForegroundEventIfVerified(sheet, event: .keyUp(1, modifiers: []), dispatch: empty, emit: { preconditionFailure() }))
		let held = ForegroundInputDispatchState()
		for event in chord.prefix(3) { held.record(event) }
		for event in [ForegroundInputEvent.keyDown(2, modifiers: [55,56]), .mouseUp(0), .other, .keyUp(2, modifiers: [55,56]), .keyUp(1, modifiers: [55])] {
			precondition(!dispatchForegroundEventIfVerified(sheet, event: event, dispatch: held, emit: { preconditionFailure() }))
		}
		var transition = sheet
		transition.ownedSheetWindowId = nil
		transition.firstActual = original.actual
		transition.ownedSheetTransitionObserved = true
		precondition(!shouldReobserveForegroundRead(transition))
		precondition(shouldReobserveForegroundRead(transition, releasingOwnedKey: true))
		precondition(isOwnedForegroundKeyRelease(.keyUp(1, modifiers: [55,56]), dispatch: held))
		precondition(!isOwnedForegroundKeyRelease(.keyDown(1, modifiers: [55,56]), dispatch: held))
		precondition(!dispatchForegroundEventIfVerified(transition, event: .keyUp(1, modifiers: [55,56]), dispatch: held, emit: { preconditionFailure() }))
		var foreignTransition = transition
		foreignTransition.firstActual = ForegroundActualIdentity(pid: 99, windowId: target.windowId)
		precondition(!shouldReobserveForegroundRead(foreignTransition, releasingOwnedKey: true))
		var racingTransition = transition
		racingTransition.frontmostPidStable = false
		precondition(!shouldReobserveForegroundRead(racingTransition, releasingOwnedKey: true))
		var missingProof = sheet
		missingProof.ownedSheetWindowId = nil
		var racing = sheet
		racing.frontmostPidStable = false
		var changed = sheet
		changed.firstActual = original.actual
		var notMain = gateReport(sheet.actual, focused: false, main: false)
		notMain.firstActual = sheet.firstActual
		notMain.ownedSheetWindowId = sheet.ownedSheetWindowId
		for invalid in [missingProof, racing, changed, notMain] {
			precondition(!dispatchForegroundEventIfVerified(invalid, event: .keyUp(1, modifiers: [55,56]), dispatch: held, emit: { preconditionFailure() }))
		}
		}
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
		// Chromium title normalization is owner-specific and retains geometry/PID/uniqueness guards.
		precondition(focusedWindowTitlesAgree("Demo - Google Chrome", "Demo", ownerBundleIdentifier: "com.google.Chrome"))
		precondition(focusedWindowTitlesAgree("Demo - Microsoft Edge", "Demo", ownerBundleIdentifier: "com.microsoft.edgemac"))
		precondition(!focusedWindowTitlesAgree("Demo - Google Chrome", "Demo", ownerBundleIdentifier: nil))
		precondition(!focusedWindowTitlesAgree("Different - Google Chrome", "Demo", ownerBundleIdentifier: "com.google.Chrome"))
		precondition(!focusedWindowTitlesAgree("Demo - Google Chrome", "Demo", ownerBundleIdentifier: "com.microsoft.edgemac"))
		let chromiumAX = [FocusedAXNodeSnapshot(token: "chromium", frame: frame, title: "Demo - Google Chrome", isSheet: false)]
		let chromiumCG = [FocusedCGCandidateSnapshot(windowId: 710, ownerPid: target.pid, frame: frame, title: "Demo", isOnscreen: true)]
		precondition(decideFocusedMapping(focusedToken: "chromium", axNodes: chromiumAX, candidates: chromiumCG, targetPid: target.pid, ownerBundleIdentifier: "com.google.Chrome").selectedWindowId == 710)
		precondition(decideFocusedMapping(focusedToken: "chromium", axNodes: chromiumAX, candidates: chromiumCG + chromiumCG, targetPid: target.pid, ownerBundleIdentifier: "com.google.Chrome").selectedWindowId == nil)
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

		// A completed base-key pair can still leave modifiers asserted. A
		// foreground loss on the next event must report that remaining state.
		let heldControl = sendSequence([
			.keyDown(4, modifiers: [59]), .keyUp(4, modifiers: [59]), .mouseDown(0),
		], reports: [gateReport(correct), gateReport(correct), gateReport(correct, focused: false)])
		assertPartial(heldControl.result, count: 2, keys: [59])
		let modifierState = ForegroundInputDispatchState()
		modifierState.record(.keyDown(4, modifiers: [55, 59]))
		modifierState.record(.keyUp(4, modifiers: [55, 59]))
		precondition(modifierState.pressedKeys == Set([55, 59]))
		modifierState.record(.keyUp(59, modifiers: [55]))
		precondition(modifierState.pressedKeys == Set([55]))
		modifierState.record(.keyUp(55, modifiers: []))
		precondition(modifierState.pressedKeys.isEmpty)
		let baseStillDown = ForegroundInputDispatchState()
		baseStillDown.record(.keyDown(4, modifiers: [59]))
		baseStillDown.record(.keyUp(59, modifiers: []))
		precondition(baseStillDown.pressedKeys == Set([4]), "modifier release cannot erase an outstanding base key")

		let controlH: [ForegroundInputEvent] = [
			.keyDown(59, modifiers: [59]), .keyDown(4, modifiers: [59]),
			.keyUp(4, modifiers: [59]), .keyUp(59, modifiers: []),
		]
		precondition(foregroundKeyChordEvents(code: 4, modifiers: [59]) == controlH)
		precondition(foregroundKeyChordEvents(code: 4, modifiers: []) == [.keyDown(4, modifiers: []), .keyUp(4, modifiers: [])])
		precondition(foregroundKeyChordEvents(code: 4, modifiers: [55, 56]) == [
			.keyDown(55, modifiers: [55]), .keyDown(56, modifiers: [55, 56]),
			.keyDown(4, modifiers: [55, 56]), .keyUp(4, modifiers: [55, 56]),
			.keyUp(56, modifiers: [55]), .keyUp(55, modifiers: []),
		])
		for modifiers in [[59, 59], [62], [4]] {
			precondition(foregroundKeyChordEvents(code: 4, modifiers: modifiers) == nil)
		}
		precondition(foregroundKeyChordEvents(code: 59, modifiers: []) == nil)
		precondition(foregroundKeyChordEvents(code: -1, modifiers: []) == nil)
		// Interrupt at every event, including before the owned modifier release.
		// The emitted prefix and outstanding state must be retained without cleanup.
		for stop in controlH.indices {
			var reports = Array(repeating: gateReport(correct), count: controlH.count)
			reports[stop] = gateReport(correct, focused: false)
			let interrupted = sendSequence(controlH, reports: reports)
			precondition(interrupted.sink == Array(controlH.prefix(stop)))
			if stop == 0 {
				precondition(interrupted.result?["outcome"] as? String == "didnt")
			} else {
				assertPartial(interrupted.result, count: stop, keys: stop == 2 ? [4, 59] : [59])
			}
		}
		let completeChord = ForegroundInputDispatchState()
		precondition(unownedForegroundModifiers(observed: [59], dispatch: completeChord) == Set([59]))
		for event in controlH { completeChord.record(event) }
		precondition(completeChord.pressedKeys.isEmpty)
		precondition(unownedForegroundModifiers(observed: [59], dispatch: completeChord) == Set([59]), "previous chords do not own later modifiers")
		let activeChord = ForegroundInputDispatchState()
		activeChord.record(controlH[0])
		precondition(unownedForegroundModifiers(observed: [59], dispatch: activeChord).isEmpty)
		precondition(unownedForegroundModifiers(observed: [59, 62], dispatch: activeChord) == Set([62]), "right Control is never owned by a left Control chord")
		let deniedInitial = modifierRejectedActResult(details: ["inputDispatch": ForegroundInputDispatchState().details])
		precondition(deniedInitial["outcome"] as? String == "didnt")
		precondition(deniedInitial["inputDispatch"] == nil)
		let deniedPartial = modifierRejectedActResult(details: ["inputDispatch": activeChord.details])
		precondition(deniedPartial["outcome"] as? String == "unknown")
		precondition((deniedPartial["inputDispatch"] as? [String: Any])?["recoveryRequired"] as? Bool == true)

		var transient = gateReport(ForegroundActualIdentity(pid: correct.pid, windowId: nil), focused: false)
		transient.secondDiagnostics = ["mappingStage": "ax_read_failed"]
		precondition(shouldReobserveForegroundRead(transient))
		transient.frontmostPidStable = false
		precondition(!shouldReobserveForegroundRead(transient), "foreground PID races must stop")
		transient = gateReport(ForegroundActualIdentity(pid: 888, windowId: nil), focused: false)
		transient.secondDiagnostics = ["mappingStage": "ax_read_failed"]
		precondition(!shouldReobserveForegroundRead(transient), "another application must stop")
		precondition(!shouldReobserveForegroundRead(gateReport(ForegroundActualIdentity(pid: correct.pid, windowId: 999), focused: false)), "resolved same-PID wrong window must stop")
		precondition(!shouldReobserveForegroundRead(gateReport(correct)))
		transient = gateReport(ForegroundActualIdentity(pid: correct.pid, windowId: nil), focused: false)
		transient.firstActual = ForegroundActualIdentity(pid: correct.pid, windowId: 999)
		transient.secondDiagnostics = ["mappingStage": "ax_read_failed"]
		precondition(!shouldReobserveForegroundRead(transient), "a resolved wrong first window cannot be hidden by a later transient read")
		let boundFrame = CGRect(origin: CGPoint(x: 100, y: 100), size: CGSize(width: 800, height: 600))
		let candidate = FocusedCGCandidateSnapshot(windowId: target.windowId, ownerPid: target.pid, frame: boundFrame, title: "Owned", isOnscreen: true)
		func bound(_ matches: Bool = true, role: String = "AXWindow", frame: CGRect? = CGRect(origin: CGPoint(x: 100, y: 100), size: CGSize(width: 800, height: 600)), candidates: [FocusedCGCandidateSnapshot]? = nil) -> FocusedMappingDecision? {
			decideBoundFocusedMapping(focusMatchesTarget: matches, focusedRole: role, target: target, frame: frame, title: "Owned", candidates: candidates ?? [candidate])
		}
		precondition(bound()?.selectedWindowId == target.windowId)
		precondition(bound(false) == nil, "same PID does not establish exact focused AX identity")
		precondition(bound(role: "AXGroup") == nil)
		precondition(bound(frame: nil)?.selectedWindowId == nil)
		precondition(bound(candidates: [candidate, candidate])?.selectedWindowId == nil)
		precondition(bound(candidates: [FocusedCGCandidateSnapshot(windowId: target.windowId + 1, ownerPid: target.pid, frame: boundFrame, title: "Owned", isOnscreen: true)])?.selectedWindowId == nil)
		precondition(bound(candidates: [FocusedCGCandidateSnapshot(windowId: target.windowId, ownerPid: 888, frame: boundFrame, title: "Owned", isOnscreen: true)])?.selectedWindowId == nil)
		precondition(bound(candidates: [FocusedCGCandidateSnapshot(windowId: target.windowId, ownerPid: target.pid, frame: boundFrame, title: "Owned", isOnscreen: false)])?.selectedWindowId == nil)
        let ax = FocusedAXNodeSnapshot(token: "floating", frame: boundFrame, title: "Find and Replace", isSheet: false)
        let cg = FocusedCGCandidateSnapshot(windowId: 20390, ownerPid: target.pid,
            frame: boundFrame, title: nil, isOnscreen: true)
        func pairs(_ nodes: [FocusedAXNodeSnapshot] = [ax], _ candidates: [FocusedCGCandidateSnapshot] = [cg],
                   ids: Set<UInt32> = [20390]) -> [String: UInt32] {
            uniqueVisibleWindowPairs(axNodes: nodes, candidates: candidates, targetPid: target.pid, eligibleIds: ids)
        }
        precondition(pairs() == ["floating": 20390], "missing CG title requires unique geometry, not a nearby title-ranked window")
        precondition(pairs(ids: []).isEmpty)
        precondition(pairs([ax, FocusedAXNodeSnapshot(token: "duplicate", frame: boundFrame, title: ax.title, isSheet: false)]).isEmpty)
        precondition(pairs([ax, ax]).isEmpty)
        precondition(pairs([ax], [cg, cg]).isEmpty)
        precondition(pairs([ax], [cg, FocusedCGCandidateSnapshot(windowId: 19152, ownerPid: target.pid, frame: boundFrame, title: nil, isOnscreen: true)]).isEmpty,
            "a noneligible neighbor still makes the geometry ambiguous")
        for other in [
            FocusedCGCandidateSnapshot(windowId: 20390, ownerPid: 888, frame: boundFrame, title: nil, isOnscreen: true),
            FocusedCGCandidateSnapshot(windowId: 20390, ownerPid: target.pid, frame: boundFrame, title: nil, isOnscreen: false),
            FocusedCGCandidateSnapshot(windowId: 20390, ownerPid: target.pid, frame: boundFrame, title: "Other", isOnscreen: true),
            FocusedCGCandidateSnapshot(windowId: 20390, ownerPid: target.pid, frame: nil, title: nil, isOnscreen: true),
            FocusedCGCandidateSnapshot(windowId: 20390, ownerPid: target.pid, frame: CGRect(origin: CGPoint(x: 103, y: 100), size: CGSize(width: 800, height: 600)), title: nil, isOnscreen: true)
        ] { precondition(pairs([ax], [other]).isEmpty) }

        // Model a modal action that takes effect and then returns cannotComplete.
        // Native status cannot authorize a second invocation or a pointer action.
        for status in [0, -25204, -25202, -25206] {
            var invocations = 0
            var modalOpen = false
            let result = performNativeActionOnce {
                invocations += 1
                modalOpen.toggle()
                return status
            }
            precondition(invocations == 1 && modalOpen)
            precondition(result["outcome"] as? String == (status == 0 ? "worked" : "unknown"))
            let evidence = result["evidence"] as! [String: Any]
            precondition(evidence["axStatus"] as? Int == status)
            precondition(evidence["nativeActionAttempted"] as? Bool == true)
            precondition(evidence["inputRetryProhibited"] as? Bool == true)
        }
        let pointerFocus = PointerTextFocusEvidence(beforeScopeVerified: true,
            afterScopeVerified: true, sameFocusedElement: false, afterRole: "AXTextArea",
            afterSecure: false, afterFrame: CGRect(origin: CGPoint(x: 100, y: 100), size: CGSize(width: 800, height: 600)),
            point: CGPoint(x: 150, y: 200), beforeSelection: nil, afterSelection: nil)
        precondition(pointerTextFocusChanged(pointerFocus))
        var preexisting = pointerFocus; preexisting.sameFocusedElement = true
        precondition(!pointerTextFocusChanged(preexisting), "preexisting focus is not click evidence")
        preexisting.beforeSelection = NSRange(location: 3, length: 0)
        preexisting.afterSelection = NSRange(location: 3, length: 0)
        precondition(!pointerTextFocusChanged(preexisting))
        preexisting.afterSelection = NSRange(location: 4, length: 0)
        precondition(pointerTextFocusChanged(preexisting))
        preexisting.afterSelection = NSRange(location: NSNotFound, length: 0)
        precondition(!pointerTextFocusChanged(preexisting))
        preexisting.afterSelection = NSRange(location: 100_001, length: 0)
        precondition(!pointerTextFocusChanged(preexisting))
        for invalid in 0..<9 {
            var e = pointerFocus
            switch invalid {
            case 0: e.beforeScopeVerified = false
            case 1: e.afterScopeVerified = false
            case 2: e.afterRole = "AXButton"
            case 3: e.afterRole = "AXSecureTextField"
            case 4: e.afterSecure = true
            case 5: e.afterFrame = nil
            case 6: e.afterFrame = CGRect(origin: CGPoint(x: 100, y: 100), size: CGSize(width: 0, height: 600))
            case 7: e.point = CGPoint(x: 99, y: 200)
            default: e.point = CGPoint(x: CGFloat.nan, y: 200)
            }
            precondition(!pointerTextFocusChanged(e), "invalid focus/geometry cannot establish effect")
        }
		print("native foreground gate tests passed")
	}
}
