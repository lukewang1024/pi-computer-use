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

func decideFocusedMapping(
	focusedToken: String?,
	axNodes: [FocusedAXNodeSnapshot],
	candidates: [FocusedCGCandidateSnapshot],
	targetPid: Int32,
	geometryTolerance: CGFloat = 2
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
			guard title.lowercased() == candidateTitle.lowercased() else { continue }
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

struct ForegroundGateReport {
	let target: ForegroundTargetIdentity
	let actual: ForegroundActualIdentity
	let focusedWindowMatches: Bool
	let targetIsMain: Bool
	var frontmostPidStable = true
	var firstActual: ForegroundActualIdentity?
	var firstDiagnostics: [String: Any]?
	var secondDiagnostics: [String: Any]?

	var verified: Bool {
		target.windowId > 0
			&& actual.pid == target.pid
			&& actual.windowId == target.windowId
			&& focusedWindowMatches
			&& targetIsMain
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
				"frontmostPidStable": frontmostPidStable,
			],
		]
		if let firstActual {
			output["firstActual"] = [
				"pid": firstActual.pid.map { Int($0) } as Any? ?? NSNull(),
				"windowId": firstActual.windowId.map { Int($0) } as Any? ?? NSNull(),
			]
		}
		if let firstDiagnostics { output["firstMapping"] = firstDiagnostics }
		if let secondDiagnostics { output["secondMapping"] = secondDiagnostics }
		return output
	}
}

enum ForegroundInputEvent: Equatable {
	case keyDown(Int, modifiers: [Int])
	case keyUp(Int, modifiers: [Int])
	case mouseDown(Int)
	case mouseUp(Int)
	case other
}

final class ForegroundInputDispatchState {
	private(set) var eventsDispatched = 0
	private(set) var pressedKeys = Set<Int>()
	private(set) var pressedMouseButtons = Set<Int>()

	func record(_ event: ForegroundInputEvent) {
		eventsDispatched += 1
		switch event {
		case let .keyDown(code, modifiers):
			pressedKeys.insert(code)
			pressedKeys.formUnion(modifiers)
		case let .keyUp(code, modifiers):
			pressedKeys.remove(code)
			pressedKeys.subtract(modifiers)
		case let .mouseDown(button): pressedMouseButtons.insert(button)
		case let .mouseUp(button): pressedMouseButtons.remove(button)
		case .other: break
		}
	}

	var details: [String: Any] {
		[
			"eventsDispatched": eventsDispatched,
			"unreleasedKeys": pressedKeys.sorted(),
			"unreleasedMouseButtons": pressedMouseButtons.sorted(),
			"recoveryRequired": eventsDispatched > 0,
			"retrySafe": eventsDispatched == 0,
		]
	}
}

func foregroundFailureDetails(report: ForegroundGateReport, dispatch: ForegroundInputDispatchState) -> [String: Any] {
	var details = report.details
	details["inputDispatch"] = dispatch.details
	return details
}

@discardableResult
func dispatchForegroundEventIfVerified(
	_ report: ForegroundGateReport,
	event: ForegroundInputEvent,
	dispatch: ForegroundInputDispatchState,
	emit: () -> Void
) -> Bool {
	guard report.verified else { return false }
	emit()
	dispatch.record(event)
	return true
}

func foregroundRejectedActResult(details: [String: Any]) -> [String: Any] {
	let inputDispatch = details["inputDispatch"] as? [String: Any] ?? [:]
	let eventsDispatched = inputDispatch["eventsDispatched"] as? Int ?? 0
	let partial = eventsDispatched > 0
	let error: [String: Any] = partial
		? [
			"code": "foreground_interrupted_after_partial_hid",
			"message": "Foreground verification failed after HID events were dispatched; do not retry, and recover the desktop explicitly",
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
