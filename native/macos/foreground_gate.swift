import Foundation

struct ForegroundTargetIdentity: Equatable {
	let pid: Int32
	let windowId: UInt32
}

struct ForegroundActualIdentity: Equatable {
	let pid: Int32?
	let windowId: UInt32?
}

struct FocusedAXNodeSnapshot {
	let token: String
	let frame: CGRect?
	let title: String?
	let isSheet: Bool
}

struct FocusedCGCandidateSnapshot {
	let windowId: UInt32
	let ownerPid: Int32
	let frame: CGRect?
	let title: String?
	let isOnscreen: Bool
}

struct FocusedMappingDecision {
	let stage: String
	let selectedWindowId: UInt32?
	let candidateCount: Int
	let validCandidateIds: [UInt32]
	let ambiguous: Bool

	var diagnostics: [String: Any] {
		[
			"mappingStage": stage,
			"candidateCount": candidateCount,
			"validCandidateIds": validCandidateIds.map { Int($0) },
			"ambiguous": ambiguous,
		]
	}
}

func strictFocusedFrame(origin: CGPoint?, size: CGSize?) -> CGRect? {
	guard let origin, let size,
		origin.x.isFinite, origin.y.isFinite,
		size.width.isFinite, size.height.isFinite,
		size.width > 1, size.height > 1
	else { return nil }
	return CGRect(origin: origin, size: size)
}

// Chromium exposes the app suffix in AXTitle but omits it from CGWindowName.
// Normalize only the exact suffix for the independently identified owner bundle.
func focusedWindowTitlesAgree(_ ax: String, _ cg: String, ownerBundleIdentifier: String?) -> Bool {
	let a = ax.trimmingCharacters(in: .whitespacesAndNewlines)
	let c = cg.trimmingCharacters(in: .whitespacesAndNewlines)
	if a.lowercased() == c.lowercased() { return true }
	let products = ["com.google.Chrome": "Google Chrome", "com.microsoft.edgemac": "Microsoft Edge"]
	guard let bundle = ownerBundleIdentifier, let product = products[bundle] else { return false }
	return a.lowercased() == (c + " - " + product).lowercased()
}

func decideFocusedMapping(
	focusedToken: String?,
	axNodes: [FocusedAXNodeSnapshot],
	candidates: [FocusedCGCandidateSnapshot],
	targetPid: Int32,
	geometryTolerance: CGFloat = 2,
	ownerBundleIdentifier: String? = nil
) -> FocusedMappingDecision {
	guard let focusedToken else {
		return FocusedMappingDecision(stage: "focused_element_missing", selectedWindowId: nil, candidateCount: candidates.count, validCandidateIds: [], ambiguous: false)
	}
	let focusedNodes = axNodes.filter { $0.token == focusedToken }
	guard focusedNodes.count == 1, let focused = focusedNodes.first else {
		return FocusedMappingDecision(stage: "focused_element_ambiguous", selectedWindowId: nil, candidateCount: candidates.count, validCandidateIds: [], ambiguous: true)
	}
	guard let frame = focused.frame, frame.size.width > 1, frame.size.height > 1 else {
		return FocusedMappingDecision(stage: "ax_geometry_missing", selectedWindowId: nil, candidateCount: candidates.count, validCandidateIds: [], ambiguous: false)
	}
	var valid: [FocusedCGCandidateSnapshot] = []
	for candidate in candidates {
		guard candidate.ownerPid == targetPid, candidate.windowId > 0, candidate.isOnscreen,
			let candidateFrame = candidate.frame,
			candidateFrame.size.width > 1, candidateFrame.size.height > 1
		else { continue }
		let geometryExact = abs(frame.origin.x - candidateFrame.origin.x) <= geometryTolerance
			&& abs(frame.origin.y - candidateFrame.origin.y) <= geometryTolerance
			&& abs(frame.size.width - candidateFrame.size.width) <= geometryTolerance
			&& abs(frame.size.height - candidateFrame.size.height) <= geometryTolerance
		guard geometryExact else { continue }
		if let title = focused.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty,
			let candidateTitle = candidate.title?.trimmingCharacters(in: .whitespacesAndNewlines), !candidateTitle.isEmpty
		{
			guard focusedWindowTitlesAgree(title, candidateTitle, ownerBundleIdentifier: ownerBundleIdentifier) else { continue }
		}
		valid.append(candidate)
	}
	if valid.count != 1 {
		return FocusedMappingDecision(
			stage: valid.isEmpty ? "no_valid_cg_candidate" : "ambiguous_cg_candidate",
			selectedWindowId: nil,
			candidateCount: candidates.count,
			validCandidateIds: valid.map { $0.windowId },
			ambiguous: valid.count > 1
		)
	}
	return FocusedMappingDecision(stage: "focused_element_unique_pairing", selectedWindowId: valid[0].windowId, candidateCount: candidates.count, validCandidateIds: [valid[0].windowId], ambiguous: false)
}

/// Resolve eligible visible window IDs without using title ranking or array order.
/// Uniqueness is required in both directions across the supplied full inventory.
func uniqueVisibleWindowPairs(
    axNodes: [FocusedAXNodeSnapshot], candidates: [FocusedCGCandidateSnapshot],
    targetPid: Int32, eligibleIds: Set<UInt32>
) -> [String: UInt32] {
    var proposed: [String: UInt32] = [:]
    for node in axNodes {
        let decision = decideFocusedMapping(focusedToken: node.token, axNodes: axNodes,
            candidates: candidates, targetPid: targetPid)
        if let id = decision.selectedWindowId, eligibleIds.contains(id) {
            proposed[node.token] = id
        }
    }
    var counts: [UInt32: Int] = [:]
    for id in proposed.values { counts[id, default: 0] += 1 }
    return proposed.filter { counts[$0.value] == 1 }
}

struct ForegroundGateReport {
	let target: ForegroundTargetIdentity
	let actual: ForegroundActualIdentity
	let focusedWindowMatches: Bool
	let targetIsMain: Bool
	// Established twice from native AX role, direct ownership and a main parent.
	var targetIsOwnedModalSheet = false
	var frontmostPidStable = true
	var firstActual: ForegroundActualIdentity?
	var firstDiagnostics: [String: Any]?
	var secondDiagnostics: [String: Any]?
	// Only native AX parent checks may establish this identity.
	var ownedSheetWindowId: UInt32?
	var ownedSheetTransitionObserved = false
	// Native producer only: two successful empty AX window inventories and two
	// exact CG metadata probes proved this target closed without a replacement.
	var ownedTargetClosedWithoutReplacement = false
	// Pointer releases additionally require both native AX owner directions.
	var ownedMouseSheetWindowId: UInt32?
	var ownedMouseSheetTransitionObserved = false
	// Only a transaction's own key-ups may return to this previously bound parent.
	var ownedModalParentWindowId: UInt32?
	var ownedModalParentTransitionObserved = false
	// A complete pre-dispatch inventory and two native focus/inventory reads
	// establish a newly created same-app window. Only owned key-ups may use it.
	var createdWindowReleaseId: UInt32?
	var createdWindowTransitionObserved = false

	var verified: Bool {
		target.windowId > 0
			&& actual.pid == target.pid
			&& actual.windowId == target.windowId
			&& focusedWindowMatches
			&& (targetIsMain || targetIsOwnedModalSheet)
			&& frontmostPidStable
	}

	var details: [String: Any] {
		var output: [String: Any] = [
			"verified": verified,
			"target": ["pid": Int(target.pid), "windowId": Int(target.windowId)],
			"actualForeground": [
				"pid": actual.pid.map { Int($0) } as Any? ?? NSNull(),
				"windowId": actual.windowId.map { Int($0) } as Any? ?? NSNull(),
				"focusedWindowMatches": focusedWindowMatches,
				"targetIsMain": targetIsMain,
				"targetIsOwnedModalSheet": targetIsOwnedModalSheet,
				"frontmostPidStable": frontmostPidStable,
			],
		]
		if let firstActual {
			output["firstActual"] = [
				"pid": firstActual.pid.map { Int($0) } as Any? ?? NSNull(),
				"windowId": firstActual.windowId.map { Int($0) } as Any? ?? NSNull(),
			]
		}
		if let ownedSheetWindowId { output["ownedSheetReleaseWindowId"] = Int(ownedSheetWindowId) }
		if let ownedMouseSheetWindowId { output["ownedMouseSheetReleaseWindowId"] = Int(ownedMouseSheetWindowId) }
		if ownedMouseSheetTransitionObserved { output["ownedMouseSheetTransitionObserved"] = true }
		if let ownedModalParentWindowId { output["ownedModalParentReleaseWindowId"] = Int(ownedModalParentWindowId) }
		if ownedModalParentTransitionObserved { output["ownedModalParentTransitionObserved"] = true }
		if let createdWindowReleaseId { output["createdWindowReleaseId"] = Int(createdWindowReleaseId) }
		if createdWindowTransitionObserved { output["createdWindowTransitionObserved"] = true }
		if ownedSheetTransitionObserved { output["ownedSheetTransitionObserved"] = true }
		if ownedTargetClosedWithoutReplacement { output["ownedTargetClosedWithoutReplacement"] = true }
		if let firstDiagnostics { output["firstMapping"] = firstDiagnostics }
		if let secondDiagnostics { output["secondMapping"] = secondDiagnostics }
		return output
	}
}

struct ForegroundClosedTargetSample {
	// nil means a failed/invalid inventory, never an empty desktop.
	let axWindowCount: Int?
	let cgTargetExists: Bool?
}

func provenCreatedForegroundWindow(_ report: ForegroundGateReport,
	baseline: Set<UInt32>?, first: Set<UInt32>?, second: Set<UInt32>?,
	allowTransition: Bool = false) -> UInt32? {
	guard report.target.windowId > 0, report.frontmostPidStable,
		report.actual.pid == report.target.pid,
		let id = report.actual.windowId, id > 0, id != report.target.windowId,
		let baseline, baseline.contains(report.target.windowId), !baseline.contains(id),
		let first, let second,
		first.contains(report.target.windowId), second.contains(report.target.windowId),
		second.contains(id) else { return nil }
	if report.firstActual == report.actual, first.contains(id) { return id }
	if allowTransition,
		report.firstActual == ForegroundActualIdentity(pid: report.target.pid, windowId: report.target.windowId) {
		return id
	}
	return nil
}

func provenClosedForegroundTarget(_ report: ForegroundGateReport,
	first: ForegroundClosedTargetSample, second: ForegroundClosedTargetSample) -> Bool {
	report.target.windowId > 0 && !report.targetIsMain && !report.focusedWindowMatches
		&& report.frontmostPidStable
		&& report.actual == ForegroundActualIdentity(pid: report.target.pid, windowId: nil)
		&& report.firstActual == report.actual
		&& first.axWindowCount == 0 && second.axWindowCount == 0
		&& first.cgTargetExists == false && second.cgTargetExists == false
}

func isOwnedModalSheet(
	targetPid: Int32, sheetPid: Int32?, sheetRole: String?,
	parentPid: Int32?, parentRole: String?, parentIsMain: Bool, directlyOwned: Bool
) -> Bool {
	targetPid > 0 && sheetPid == targetPid && parentPid == targetPid
		&& sheetRole == "AXSheet" && parentRole == "AXWindow"
		&& parentIsMain && directlyOwned
}

func shouldReobserveForegroundRead(
	_ report: ForegroundGateReport, releasingOwnedKey: Bool = false,
	releasingOwnedMouseButton: Bool = false
) -> Bool {
	if releasingOwnedKey && report.ownedTargetClosedWithoutReplacement { return false }
	if releasingOwnedKey, report.createdWindowTransitionObserved,
		report.frontmostPidStable, report.target.windowId > 0,
		report.firstActual == ForegroundActualIdentity(pid: report.target.pid, windowId: report.target.windowId),
		report.actual.pid == report.target.pid,
		let id = report.actual.windowId, id > 0, id != report.target.windowId {
		return true
	}
	// A click can open its direct child sheet on mouse-down. Only an already
	// held button may request a fresh stable ownership read before mouse-up.
	if releasingOwnedMouseButton, report.ownedMouseSheetTransitionObserved,
		report.target.windowId > 0, report.targetIsMain, report.frontmostPidStable,
		report.firstActual == ForegroundActualIdentity(pid: report.target.pid, windowId: report.target.windowId),
		report.actual.pid == report.target.pid,
		let sheetId = report.actual.windowId, sheetId > 0, sheetId != report.target.windowId {
		return true
	}
	// A closing sheet can disappear between the two samples. Another read may
	// prove its bound parent; the mixed sample itself never authorizes input.
	if releasingOwnedKey, report.ownedModalParentTransitionObserved,
		report.target.windowId > 0, report.frontmostPidStable,
		report.firstActual == ForegroundActualIdentity(pid: report.target.pid, windowId: report.target.windowId),
		report.actual.pid == report.target.pid,
		let parentId = report.ownedModalParentWindowId, parentId > 0,
		parentId != report.target.windowId, report.actual.windowId == parentId {
		return true
	}
	// This grants another read, never input. The next sample must prove a
	// stable direct owned sheet before any transaction-owned key is released.
	if releasingOwnedKey, report.ownedSheetTransitionObserved,
		report.target.windowId > 0, report.targetIsMain, report.frontmostPidStable,
		report.firstActual == ForegroundActualIdentity(pid: report.target.pid, windowId: report.target.windowId),
		report.actual.pid == report.target.pid,
		let windowId = report.actual.windowId, windowId > 0, windowId != report.target.windowId {
		return true
	}
	for actual in [report.firstActual, report.actual].compactMap({ $0 }) {
		if let pid = actual.pid, pid != report.target.pid { return false }
		if let windowId = actual.windowId, windowId != report.target.windowId { return false }
	}
	// Leaving fullscreen can change AX/CG geometry between samples without
	// changing the window. Only an owned key-up may request another bounded
	// read after the second sample uniquely rebinds that same main window.
	// This mixed report still fails verification and never authorizes input.
	if releasingOwnedKey, !report.verified,
		report.target.windowId > 0, report.targetIsMain, report.frontmostPidStable,
		report.firstActual == ForegroundActualIdentity(pid: report.target.pid, windowId: nil),
		report.actual == ForegroundActualIdentity(pid: report.target.pid, windowId: report.target.windowId),
		report.firstDiagnostics?["mappingStage"] as? String == "no_valid_cg_candidate",
		report.firstDiagnostics?["ambiguous"] as? Bool == false,
		(report.firstDiagnostics?["validCandidateIds"] as? [Int])?.isEmpty == true,
		report.secondDiagnostics?["mappingStage"] as? String == "focused_element_unique_pairing",
		report.secondDiagnostics?["ambiguous"] as? Bool == false,
		report.secondDiagnostics?["validCandidateIds"] as? [Int] == [Int(report.target.windowId)] {
		return true
	}
	let transientRead = [report.firstDiagnostics, report.secondDiagnostics].contains { $0?["mappingStage"] as? String == "ax_read_failed" }
	return !report.verified && report.frontmostPidStable && report.actual.pid == report.target.pid && transientRead
}

func decideBoundFocusedMapping(
	focusMatchesTarget: Bool, focusedRole: String, target: ForegroundTargetIdentity,
	frame: CGRect?, title: String?, candidates: [FocusedCGCandidateSnapshot], ownerBundleIdentifier: String? = nil
) -> FocusedMappingDecision? {
	guard focusMatchesTarget, ["AXWindow", "AXSheet"].contains(focusedRole) else { return nil }
	let decision = decideFocusedMapping(focusedToken: "bound-target",
		axNodes: [FocusedAXNodeSnapshot(token: "bound-target", frame: frame, title: title, isSheet: focusedRole == "AXSheet")],
		candidates: candidates, targetPid: target.pid, ownerBundleIdentifier: ownerBundleIdentifier)
	guard decision.selectedWindowId == nil || decision.selectedWindowId == target.windowId else {
		return FocusedMappingDecision(stage: "bound_target_cg_mismatch", selectedWindowId: nil, candidateCount: candidates.count, validCandidateIds: decision.validCandidateIds, ambiguous: false)
	}
	return decision
}

enum ForegroundInputEvent: Equatable {
	case keyDown(Int, modifiers: [Int])
	case keyUp(Int, modifiers: [Int])
	case mouseDown(Int)
	case mouseUp(Int)
	case other
}

let foregroundModifierKeyCodes: Set<Int> = [55, 56, 58, 59]

/// A chord owns only the modifiers it presses, and releases them in reverse
/// order after releasing the base key. Each event still passes the HID gate.
func foregroundKeyChordEvents(code: Int, modifiers: [Int]) -> [ForegroundInputEvent]? {
	guard (0...127).contains(code), !foregroundModifierKeyCodes.contains(code),
		Set(modifiers).count == modifiers.count,
		modifiers.allSatisfy({ foregroundModifierKeyCodes.contains($0) }) else { return nil }
	var active: [Int] = []
	var events: [ForegroundInputEvent] = []
	for modifier in modifiers {
		active.append(modifier)
		events.append(.keyDown(modifier, modifiers: active))
	}
	events.append(.keyDown(code, modifiers: active))
	events.append(.keyUp(code, modifiers: active))
	for modifier in modifiers.reversed() {
		active.removeAll { $0 == modifier }
		events.append(.keyUp(modifier, modifiers: active))
	}
	return events
}

final class ForegroundInputDispatchState {
	private(set) var eventsDispatched = 0
	private var pressedKeyCodes = Set<Int>()
	private var modifierKeys = Set<Int>()
	var pressedKeys: Set<Int> { pressedKeyCodes.union(modifierKeys) }
	private(set) var pressedMouseButtons = Set<Int>()
	private(set) var ownedKeys = Set<Int>()
	private(set) var ownedMouseButtons = Set<Int>()
	private var pressOrder: [ForegroundInputEvent] = []
	private var recovery: [String: Any]?
	var hasHeldInput: Bool { !pressedKeys.isEmpty || !pressedMouseButtons.isEmpty }

	func record(_ event: ForegroundInputEvent) {
		eventsDispatched += 1
		switch event {
		case let .keyDown(code, modifiers):
			if !pressedKeys.contains(code) { pressOrder.append(.keyDown(code, modifiers: [])) }
			pressedKeyCodes.insert(code)
			modifierKeys = Set(modifiers)
			ownedKeys.formUnion(modifiers)
			ownedKeys.insert(code)
		case let .keyUp(code, modifiers):
			pressedKeyCodes.remove(code)
			pressOrder.removeAll { if case let .keyDown(key, _) = $0 { return key == code }; return false }
			// Flags describe modifier state on this event. Releasing the base
			// key while Control remains in its flags does not release Control.
			modifierKeys = Set(modifiers)
		case let .mouseDown(button):
			if !pressedMouseButtons.contains(button) { pressOrder.append(.mouseDown(button)) }
			pressedMouseButtons.insert(button)
			ownedMouseButtons.insert(button)
		case let .mouseUp(button):
			pressedMouseButtons.remove(button)
			pressOrder.removeAll { $0 == .mouseDown(button) }
		case .other: break
		}
	}

	/// Only releases, in reverse acquisition order. A failed release stops cleanup;
	/// it must not release modifiers underneath a still-held base key/button.
	var pendingReleases: [ForegroundInputEvent] {
		var keys = pressedKeys
		var buttons = pressedMouseButtons
		var output: [ForegroundInputEvent] = []
		for event in pressOrder.reversed() {
			switch event {
			case let .keyDown(code, _) where keys.remove(code) != nil:
				output.append(.keyUp(code, modifiers: keys.intersection(foregroundModifierKeyCodes).sorted()))
			case let .mouseDown(button) where buttons.remove(button) != nil:
				output.append(.mouseUp(button))
			default: break
			}
		}
		return output
	}

	func settle(release: (ForegroundInputEvent) -> Bool, verify: () -> ForegroundInputReleaseVerification) {
		let before = eventsDispatched
		for event in pendingReleases {
			guard release(event) else { break }
		}
		let verification = verify()
		let heldKeys = pressedKeys.union(verification.heldKeys)
		let heldButtons = pressedMouseButtons.union(verification.heldMouseButtons)
		let verified = verification.complete && heldKeys.isEmpty && heldButtons.isEmpty
		recovery = [
			"schemaVersion": 1, "scope": "native_transaction",
			"status": verified ? "verified" : "blocked",
			"nativeOperationStopped": true, "inputReplayed": false,
			"verification": "system_input_state",
			"operationEventsDispatched": before,
			"releaseEventsDispatched": eventsDispatched - before,
			"verifiedKeys": ownedKeys.sorted(), "verifiedMouseButtons": ownedMouseButtons.sorted(),
			"unreleasedKeys": heldKeys.sorted(), "unreleasedMouseButtons": heldButtons.sorted(),
		]
	}

	var details: [String: Any] {
		var output: [String: Any] = [
			"eventsDispatched": eventsDispatched,
			"unreleasedKeys": pressedKeys.sorted(),
			"unreleasedMouseButtons": pressedMouseButtons.sorted(),
			"recoveryRequired": eventsDispatched > 0 && (recovery?["status"] as? String) != "verified",
			"retrySafe": eventsDispatched == 0,
		]
		if let recovery {
			output["inputRecovery"] = recovery
			output["unreleasedKeys"] = recovery["unreleasedKeys"]
			output["unreleasedMouseButtons"] = recovery["unreleasedMouseButtons"]
		}
		return output
	}
}

struct ForegroundInputReleaseVerification {
	let complete: Bool
	var heldKeys = Set<Int>()
	var heldMouseButtons = Set<Int>()
}

func unownedForegroundModifiers(observed: Set<Int>, dispatch: ForegroundInputDispatchState) -> Set<Int> {
	observed.subtracting(dispatch.pressedKeys.intersection(foregroundModifierKeyCodes))
}

func foregroundFailureDetails(report: ForegroundGateReport, dispatch: ForegroundInputDispatchState) -> [String: Any] {
	var details = report.details
	details["inputDispatch"] = dispatch.details
	return details
}

func isOwnedForegroundKeyRelease(_ event: ForegroundInputEvent, dispatch: ForegroundInputDispatchState) -> Bool {
	guard case let .keyUp(code, modifiers) = event else { return false }
	return dispatch.pressedKeys.contains(code)
		&& Set(modifiers).count == modifiers.count
		&& Set(modifiers) == dispatch.pressedKeys.intersection(foregroundModifierKeyCodes).subtracting([code])
}

func isOwnedForegroundMouseRelease(_ event: ForegroundInputEvent, dispatch: ForegroundInputDispatchState) -> Bool {
	guard case let .mouseUp(button) = event else { return false }
	return dispatch.pressedMouseButtons.contains(button)
}

@discardableResult
func dispatchForegroundEventIfVerified(
	_ report: ForegroundGateReport,
	event: ForegroundInputEvent,
	dispatch: ForegroundInputDispatchState,
	emit: () -> Void
) -> Bool {
	let ownedRelease: Bool
	if isOwnedForegroundKeyRelease(event, dispatch: dispatch),
		let id = report.createdWindowReleaseId,
		id > 0, id != report.target.windowId, report.target.windowId > 0,
		report.frontmostPidStable,
		report.actual == ForegroundActualIdentity(pid: report.target.pid, windowId: id),
		report.firstActual == report.actual {
		ownedRelease = true
	} else if isOwnedForegroundKeyRelease(event, dispatch: dispatch),
		let sheetId = report.ownedSheetWindowId,
		sheetId > 0, sheetId != report.target.windowId,
		report.target.windowId > 0, report.targetIsMain, report.frontmostPidStable,
		report.actual == ForegroundActualIdentity(pid: report.target.pid, windowId: sheetId),
		report.firstActual == report.actual {
		ownedRelease = true
	} else if isOwnedForegroundKeyRelease(event, dispatch: dispatch),
		report.ownedTargetClosedWithoutReplacement,
		report.target.windowId > 0, !report.targetIsMain, !report.focusedWindowMatches,
		report.frontmostPidStable,
		report.actual == ForegroundActualIdentity(pid: report.target.pid, windowId: nil),
		report.firstActual == report.actual {
		// Balance only this transaction's already emitted chord. This does not
		// authorize a new key, pointer event, another window or another app.
		ownedRelease = true
	} else if isOwnedForegroundKeyRelease(event, dispatch: dispatch),
		let parentId = report.ownedModalParentWindowId,
		parentId > 0, parentId != report.target.windowId,
		report.target.windowId > 0, report.frontmostPidStable,
		report.actual == ForegroundActualIdentity(pid: report.target.pid, windowId: parentId),
		report.firstActual == report.actual {
		ownedRelease = true
	} else if isOwnedForegroundMouseRelease(event, dispatch: dispatch),
		let sheetId = report.ownedMouseSheetWindowId,
		sheetId > 0, sheetId != report.target.windowId,
		report.target.windowId > 0, report.targetIsMain, report.frontmostPidStable,
		report.actual == ForegroundActualIdentity(pid: report.target.pid, windowId: sheetId),
		report.firstActual == report.actual {
		ownedRelease = true
	} else {
		ownedRelease = false
	}
	let keyboardEvent: Bool
	switch event {
	case .keyDown, .keyUp: keyboardEvent = true
	default: keyboardEvent = false
	}
	// Starting pointer input retains its main-window requirement. A sheet can
	// receive only a button-up already owned by this exact transaction.
	guard (report.verified && (report.targetIsMain || keyboardEvent)) || ownedRelease else { return false }
	emit()
	dispatch.record(event)
	return true
}

func foregroundRejectedActResult(details: [String: Any]) -> [String: Any] {
	let inputDispatch = details["inputDispatch"] as? [String: Any] ?? [:]
	let eventsDispatched = inputDispatch["eventsDispatched"] as? Int ?? 0
	let partial = eventsDispatched > 0
	let recovered = inputDispatch["recoveryRequired"] as? Bool == false
	let error: [String: Any] = partial
		? [
			"code": "foreground_interrupted_after_partial_hid",
			"message": recovered
				? "Foreground verification interrupted input; owned input was verified released. Reobserve the desktop; do not replay the action"
				: "Foreground verification failed after HID events were dispatched; do not retry, and recover the desktop explicitly",
		]
		: [
			"code": "foreground_target_unverified",
			"message": "The exact target window is not verified as the foreground window; no HID event was sent",
		]
	var result: [String: Any] = [
		"outcome": partial ? "unknown" : "didnt",
		"performed": ["delivery": "hid"],
		"evidence": ["foregroundVerification": details],
		"error": error,
	]
	if partial { result["inputDispatch"] = inputDispatch }
	return result
}

func modifierRejectedActResult(details: [String: Any]) -> [String: Any] {
	let dispatch = details["inputDispatch"] as? [String: Any] ?? [:]
	let partial = (dispatch["eventsDispatched"] as? Int ?? 0) > 0
	var result: [String: Any] = [
		"outcome": partial ? "unknown" : "didnt",
		"performed": ["delivery": "hid"],
		"evidence": ["modifierVerification": details],
		"error": [
			"code": partial ? "modifier_interrupted_after_partial_hid" : "modifier_state_unverified",
			"message": partial
				? "Unowned modifier state appeared after HID dispatch; do not replay input"
				: "A modifier is already held outside this action; no HID event was sent",
		],
	]
	if partial { result["inputDispatch"] = dispatch }
	return result
}

struct ForegroundInputStateSample {
	let sourceState: Int
	let pressedKeys: [Int]
	let pressedMouseButtons: [Int]

	var released: Bool { pressedKeys.isEmpty && pressedMouseButtons.isEmpty }
	var details: [String: Any] {
		["sourceState": sourceState, "pressedKeys": pressedKeys, "pressedMouseButtons": pressedMouseButtons]
	}
}

// Poll only state, never resend an event. A posted key-up/button-up is not an
// acknowledgement that Quartz has actually released the requested input.
func waitForForegroundInputRelease(
	attempts: Int = 4,
	sample: () -> [ForegroundInputStateSample],
	pause: () -> Void
) -> [ForegroundInputStateSample]? {
	precondition(attempts > 0)
	var latest: [ForegroundInputStateSample] = []
	for attempt in 0..<attempts {
		latest = sample()
		if latest.count == 2, Set(latest.map(\.sourceState)) == Set([0, 1]), latest.allSatisfy(\.released) { return nil }
		if attempt + 1 < attempts { pause() }
	}
	return latest
}

func inputStateFailureDetails(
	phase: String, samples: [ForegroundInputStateSample], dispatch: ForegroundInputDispatchState
) -> [String: Any] {
	var inputDispatch = dispatch.details
	if phase == "after_release" {
		// These are possibly held inputs, not new ownership. They must never
		// authorize a key-up/button-up to an unrelated foreground application.
		inputDispatch["unreleasedKeys"] = dispatch.pressedKeys.union(samples.flatMap(\.pressedKeys)).sorted()
		inputDispatch["unreleasedMouseButtons"] = dispatch.pressedMouseButtons.union(samples.flatMap(\.pressedMouseButtons)).sorted()
	}
	return ["phase": phase, "samples": samples.map(\.details), "inputDispatch": inputDispatch]
}

func inputStateRejectedActResult(details: [String: Any]) -> [String: Any] {
	let dispatch = details["inputDispatch"] as? [String: Any] ?? [:]
	let partial = (dispatch["eventsDispatched"] as? Int ?? 0) > 0
	var error: [String: Any] = [
		"code": partial ? "input_interrupted_after_partial_hid" : "input_state_unverified",
		"message": partial
			? "Native input failed or its release could not be verified after HID dispatch; do not replay input"
			: "A requested key or mouse button is already held; no HID event was sent",
	]
	if let causeCode = details["causeCode"] { error["causeCode"] = causeCode }
	var result: [String: Any] = [
		"outcome": partial ? "unknown" : "didnt",
		"performed": ["delivery": "hid"],
		"evidence": ["inputStateVerification": details],
		"error": error,
	]
	if partial { result["inputDispatch"] = dispatch }
	return result
}


// AX cannot-complete may arrive after modal processing has already taken effect.
// One attempted native action never authorizes a retry or physical fallback.
func performNativeActionOnce(invoke: () -> Int) -> [String: Any] {
    let status = invoke()
    return [
        "outcome": status == 0 ? "worked" : "unknown",
        "evidence": ["nativeActionAttempted": true, "axStatus": status, "inputRetryProhibited": true],
    ]
}

// Evidence of a pointer click's effect, never permission to deliver input.
// Direct AX refs retain their availability guards. The physical gate must
// independently verify the exact window before every keyboard/mouse event.
struct PointerTextFocusEvidence {
    var beforeScopeVerified: Bool
    var afterScopeVerified: Bool
    var sameFocusedElement: Bool
    var afterRole: String
    var afterSecure: Bool
    var afterFrame: CGRect?
    var point: CGPoint
    var beforeSelection: NSRange?
    var afterSelection: NSRange?
}

func pointerTextFocusChanged(_ evidence: PointerTextFocusEvidence) -> Bool {
    guard evidence.beforeScopeVerified, evidence.afterScopeVerified,
          evidence.afterRole == "AXTextArea", !evidence.afterSecure,
          let frame = evidence.afterFrame,
          [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height,
           evidence.point.x, evidence.point.y].allSatisfy({ $0.isFinite }),
          frame.size.width > 0, frame.size.height > 0, evidence.point.x >= frame.origin.x, evidence.point.x < frame.origin.x + frame.size.width,
          evidence.point.y >= frame.origin.y, evidence.point.y < frame.origin.y + frame.size.height else { return false }
    if !evidence.sameFocusedElement { return true }
    guard let before = evidence.beforeSelection, let after = evidence.afterSelection,
          before.location != NSNotFound, after.location != NSNotFound,
          before.location >= 0, after.location >= 0,
          before.length >= 0, after.length >= 0,
          before.length <= 100_000, after.length <= 100_000,
          before.location <= 100_000 - before.length,
          after.location <= 100_000 - after.length else { return false }
    return before != after
}
