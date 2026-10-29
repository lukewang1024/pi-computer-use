import Foundation
import ApplicationServices
import Darwin

enum NativeInputRecoveryFailure: Error {
	case refused(String)
}

func nativeInputBootId() -> String? {
	var bytes = [CChar](repeating: 0, count: 128)
	var size = bytes.count
	guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0, size > 1, size <= bytes.count else { return nil }
	return UUID(uuidString: String(cString: bytes).trimmingCharacters(in: .whitespacesAndNewlines))?.uuidString.lowercased()
}

func nativeInputJournalRoot() -> URL {
	let environment = ProcessInfo.processInfo.environment
	if let value = environment["PI_COMPUTER_USE_INPUT_JOURNAL_DIR"], !value.isEmpty {
		return URL(fileURLWithPath: value, isDirectory: true)
	}
	let state = environment["XDG_STATE_HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
		?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/state", isDirectory: true)
	return state.appendingPathComponent("pi-computer-use/input-recovery", isDirectory: true)
}

func nativeInputEventDescription(_ event: ForegroundInputEvent) -> [String: Any] {
	switch event {
	case let .keyDown(code, modifiers): return ["kind": "keyDown", "code": code, "modifiers": modifiers]
	case let .keyUp(code, modifiers): return ["kind": "keyUp", "code": code, "modifiers": modifiers]
	case let .mouseDown(button): return ["kind": "mouseDown", "button": button]
	case let .mouseUp(button): return ["kind": "mouseUp", "button": button]
	case .other: return ["kind": "other"]
	}
}

/// Write-ahead ownership survives the helper and its caller. A prepared event is
/// explicitly distinguished from an acknowledged down; it never invents proof.
func persistNativeInputJournal(_ dispatch: ForegroundInputDispatchState, helperSha256: String,
	prepared: ForegroundInputEvent? = nil, terminal: [String: Any]? = nil) throws {
	let root = nativeInputJournalRoot()
	try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true,
		attributes: [.posixPermissions: 0o700])
	let attributes = try FileManager.default.attributesOfItem(atPath: root.path)
	guard attributes[.type] as? FileAttributeType == .typeDirectory,
		(attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
		((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o777) & 0o077 == 0 else {
		throw NativeInputRecoveryFailure.refused("Input journal directory is not private")
	}
	guard let boot = nativeInputBootId() else { throw NativeInputRecoveryFailure.refused("Kernel boot identity unavailable") }
	var record: [String: Any] = ["schemaVersion": 1, "scope": "native_transaction",
		"transactionId": dispatch.transactionId, "bootId": boot, "pid": Int(getpid()),
		"helperSha256": helperSha256,
		"executablePath": Bundle.main.executableURL?.path ?? CommandLine.arguments[0],
		"updatedAtMs": Int(Date().timeIntervalSince1970 * 1000),
		"phase": prepared == nil ? "acknowledged" : "prepared",
		"eventsDispatched": dispatch.eventsDispatched,
		"ownedKeys": dispatch.ownedKeys.sorted(), "ownedMouseButtons": dispatch.ownedMouseButtons.sorted(),
		"pendingKeys": dispatch.pressedKeys.sorted(), "pendingMouseButtons": dispatch.pressedMouseButtons.sorted(),
		"pendingReleases": dispatch.pendingReleases.map(nativeInputEventDescription)]
	if let prepared { record["preparedEvent"] = nativeInputEventDescription(prepared) }
	if let terminal { record["terminal"] = terminal; record["phase"] = "terminal" }
	let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
	let file = root.appendingPathComponent(dispatch.transactionId + ".json")
	let temporary = root.appendingPathComponent("." + dispatch.transactionId + "." + UUID().uuidString + ".tmp")
	let descriptor = open(temporary.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
	guard descriptor >= 0 else { throw NativeInputRecoveryFailure.refused("Cannot create private input journal") }
	defer { close(descriptor); try? FileManager.default.removeItem(at: temporary) }
	try data.withUnsafeBytes { buffer in
		var offset = 0
		while offset < buffer.count {
			let count = write(descriptor, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
			guard count > 0 else { throw NativeInputRecoveryFailure.refused("Cannot write input journal") }
			offset += count
		}
	}
	guard fsync(descriptor) == 0, rename(temporary.path, file.path) == 0 else {
		throw NativeInputRecoveryFailure.refused("Cannot commit input journal")
	}
	if terminal?["status"] as? String == "verified" {
		let files = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
		if files.count > 128 {
			let completed = files.filter { candidate in
				guard UUID(uuidString: candidate.deletingPathExtension().lastPathComponent) != nil,
					let data = try? Data(contentsOf: candidate),
					let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
				return (record["terminal"] as? [String: Any])?["status"] as? String == "verified"
			}.sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast)
				< ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
			for old in completed.prefix(max(0, completed.count - 64)) { try? FileManager.default.removeItem(at: old) }
		}
	}
}

struct NativeInputResetPlan: Codable {
	let schemaVersion: Int
	let operationId: String
	let mode: String
	let bootId: String
	let queuePath: String
	let queueEpoch: UInt64
	let maintenanceOwner: String
	let expiresAtMs: UInt64
	let executableSha256: String
	let helperExecutables: [String]
	let keys: [Int]
	let mouseButtons: [Int]
	let reason: String?
}

func nativeInputResetPlanIsValid(_ plan: NativeInputResetPlan, bootId: String?, nowMs: UInt64,
	queue: [String: Any], executableSha256: String) -> Bool {
	let jobs = queue["jobs"] as? [[String: Any]]
	return plan.schemaVersion == 1 && UUID(uuidString: plan.operationId) != nil
		&& ["owned-journal", "scoped-reset"].contains(plan.mode)
		&& (plan.mode != "scoped-reset" || plan.reason.map { $0.count >= 8 && $0.count <= 512 } == true)
		&& !plan.bootId.isEmpty && plan.bootId == bootId
		&& plan.expiresAtMs > nowMs && plan.expiresAtMs - nowMs <= 90_000
		&& plan.executableSha256.count == 64 && plan.executableSha256 == executableSha256
		&& !plan.maintenanceOwner.isEmpty && queue["maintenanceOwner"] as? String == plan.maintenanceOwner
		&& queue["blocked"] as? Bool == true && queue["inFlight"] as? Bool == false
		&& (queue["epoch"] as? NSNumber)?.uint64Value == plan.queueEpoch
		&& queue["bootId"] as? String == plan.bootId
		&& jobs != nil && jobs!.allSatisfy { !["active", "draining"].contains($0["state"] as? String ?? "") }
		&& Set(plan.keys).count == plan.keys.count && plan.keys.count <= 16
		&& plan.keys.allSatisfy { (0...127).contains($0) && $0 != 57 && $0 != 63 }
		&& Set(plan.mouseButtons).count == plan.mouseButtons.count
		&& plan.mouseButtons.allSatisfy { (0...4).contains($0) }
		&& !plan.helperExecutables.isEmpty && plan.helperExecutables.count <= 4
		&& plan.helperExecutables.allSatisfy { $0.hasPrefix("/") && $0.hasSuffix("/Contents/MacOS/bridge") }
}

func nativeSystemInputSamples() -> [[String: Any]] {
	[CGEventSourceStateID.hidSystemState, .combinedSessionState].map { source in
		["source": source.rawValue,
		 "heldKeys": (0...127).filter { CGEventSource.keyState(source, key: CGKeyCode($0)) },
		 "heldMouseButtons": (0...4).filter { CGEventSource.buttonState(source, button: CGMouseButton(rawValue: UInt32($0))!) },
		 "flags": CGEventSource.flagsState(source).rawValue]
	}
}

func nativeInputResetSampleAllowed(_ samples: [[String: Any]], keys: Set<Int>, buttons: Set<Int>) -> Bool {
	guard samples.count == 2, Set(samples.compactMap { ($0["source"] as? NSNumber)?.intValue }) == [0, 1] else { return false }
	return samples.allSatisfy { sample in
		guard let heldKeys = sample["heldKeys"] as? [Int], let heldButtons = sample["heldMouseButtons"] as? [Int] else { return false }
		return Set(heldKeys).isSubset(of: keys) && Set(heldButtons).isSubset(of: buttons)
	}
}

private func stoppedNativeHelperInventory(_ paths: [String]) throws -> [String: Any] {
	let process = Process()
	process.executableURL = URL(fileURLWithPath: "/bin/ps")
	process.arguments = ["-axww", "-o", "pid=,comm="]
	let output = Pipe(); process.standardOutput = output; process.standardError = FileHandle.nullDevice
	try process.run()
	let data = output.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
	guard process.terminationStatus == 0, data.count < 8 * 1024 * 1024,
		let text = String(data: data, encoding: .utf8) else { throw NativeInputRecoveryFailure.refused("Helper inventory incomplete") }
	var remaining: [Int] = []
	for line in text.split(separator: "\n") {
		let parts = line.trimmingCharacters(in: .whitespaces).split(maxSplits: 1, whereSeparator: { $0.isWhitespace })
		guard parts.count == 2, let pid = Int(parts[0]) else { throw NativeInputRecoveryFailure.refused("Helper inventory invalid") }
		if pid != Int(getpid()), paths.contains(String(parts[1]).trimmingCharacters(in: .whitespaces)) { remaining.append(pid) }
	}
	guard remaining.isEmpty else { throw NativeInputRecoveryFailure.refused("Old native helper is still running") }
	return ["inventoryComplete": true, "remainingHelperPids": remaining]
}

/// Administrative up-only recovery. It is admitted under an existing native
/// maintenance fence; it neither creates a desktop lease nor clears quarantine.
func recoverNativeInput(planPath: String, executableSha256: String) throws -> [String: Any] {
	let lockPath = nativeInputJournalRoot().appendingPathComponent("native-recovery.lock").path
	let recoveryLock = open(lockPath, O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
	guard recoveryLock >= 0, flock(recoveryLock, LOCK_EX | LOCK_NB) == 0 else {
		if recoveryLock >= 0 { close(recoveryLock) }
		throw NativeInputRecoveryFailure.refused("Another native recovery is running")
	}
	defer { close(recoveryLock) }
	let file = URL(fileURLWithPath: planPath)
	let attributes = try FileManager.default.attributesOfItem(atPath: file.path)
	guard attributes[.type] as? FileAttributeType == .typeRegular,
		(attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
		(attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600,
		(attributes[.size] as? NSNumber)?.intValue ?? Int.max <= 65_536 else {
		throw NativeInputRecoveryFailure.refused("Recovery plan is not a private regular file")
	}
	let plan = try JSONDecoder().decode(NativeInputResetPlan.self, from: Data(contentsOf: file))
	func validate() throws {
		guard let queue = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: plan.queuePath))) as? [String: Any],
			nativeInputResetPlanIsValid(plan, bootId: nativeInputBootId(), nowMs: UInt64(Date().timeIntervalSince1970 * 1000),
				queue: queue, executableSha256: executableSha256) else { throw NativeInputRecoveryFailure.refused("Recovery admission changed or expired") }
	}
	try validate()
	guard AXIsProcessTrusted(), CGPreflightPostEventAccess() else { throw NativeInputRecoveryFailure.refused("Native event posting permission unavailable") }
	let helpers = try stoppedNativeHelperInventory(plan.helperExecutables)
	let allowedKeys = Set(plan.keys), allowedButtons = Set(plan.mouseButtons)
	let before = nativeSystemInputSamples()
	guard nativeInputResetSampleAllowed(before, keys: allowedKeys, buttons: allowedButtons) else {
		throw NativeInputRecoveryFailure.refused("Unexpected input is held outside this recovery scope")
	}
	let source = CGEventSource(stateID: .hidSystemState)
	guard let source else { throw NativeInputRecoveryFailure.refused("Cannot create recovery event source") }
	let modifierCodes = Set([54, 55, 56, 58, 59, 60, 61, 62])
	var releases: [[String: Any]] = []
	for button in plan.mouseButtons.reversed() {
		try validate(); _ = try stoppedNativeHelperInventory(plan.helperExecutables)
		guard nativeInputResetSampleAllowed(nativeSystemInputSamples(), keys: allowedKeys, buttons: allowedButtons) else { throw NativeInputRecoveryFailure.refused("Input scope changed") }
		let nativeButton = CGMouseButton(rawValue: UInt32(button))!
		guard [CGEventSourceStateID.hidSystemState, .combinedSessionState].contains(where: { CGEventSource.buttonState($0, button: nativeButton) }) else { continue }
		guard let point = CGEvent(source: nil)?.location,
			let event = CGEvent(mouseEventSource: source, mouseType: button == 0 ? .leftMouseUp : button == 1 ? .rightMouseUp : .otherMouseUp,
				mouseCursorPosition: point, mouseButton: nativeButton) else { throw NativeInputRecoveryFailure.refused("Cannot allocate owned button release") }
		event.flags = CGEventSource.flagsState(.combinedSessionState)
		event.post(tap: .cghidEventTap); releases.append(["kind": "mouseUp", "button": button]); usleep(10_000)
	}
	let ordered = Array(plan.keys.filter { !modifierCodes.contains($0) }.reversed()) + Array(plan.keys.filter { modifierCodes.contains($0) }.reversed())
	for code in ordered {
		try validate(); _ = try stoppedNativeHelperInventory(plan.helperExecutables)
		guard nativeInputResetSampleAllowed(nativeSystemInputSamples(), keys: allowedKeys, buttons: allowedButtons) else { throw NativeInputRecoveryFailure.refused("Input scope changed") }
		guard [CGEventSourceStateID.hidSystemState, .combinedSessionState].contains(where: { CGEventSource.keyState($0, key: CGKeyCode(code)) }) else { continue }
		guard let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(code), keyDown: false) else { throw NativeInputRecoveryFailure.refused("Cannot allocate owned key release") }
		var flags = CGEventSource.flagsState(.combinedSessionState)
		if modifierCodes.contains(code) {
			event.type = .flagsChanged
			let groups: [(Set<Int>, CGEventFlags)] = [([54,55], .maskCommand), ([56,60], .maskShift), ([58,61], .maskAlternate), ([59,62], .maskControl)]
			for (group, mask) in groups where group.contains(code) {
				if !group.subtracting([code]).contains(where: { key in [CGEventSourceStateID.hidSystemState, .combinedSessionState].contains { CGEventSource.keyState($0, key: CGKeyCode(key)) } }) { flags.remove(mask) }
			}
		}
		event.flags = flags
		event.post(tap: .cghidEventTap); releases.append(["kind": "keyUp", "code": code]); usleep(10_000)
	}
	var after = nativeSystemInputSamples(), neutral = 0
	for _ in 0..<12 {
		try validate()
		after = nativeSystemInputSamples()
		if nativeInputResetSampleAllowed(after, keys: [], buttons: []) { neutral += 1 } else { neutral = 0 }
		if neutral >= 2 { break }; usleep(10_000)
	}
	let finalHelpers = try stoppedNativeHelperInventory(plan.helperExecutables)
	return ["schemaVersion": 1, "scope": "native_desktop_reset", "operationId": plan.operationId,
		"mode": plan.mode, "status": neutral >= 2 ? "verified" : "blocked",
		"oldHelpersStopped": true, "helperInventory": finalHelpers, "beforeHelperInventory": helpers,
		"inputReplayed": false, "downEventsDispatched": 0, "releaseEvents": releases,
		"before": before, "after": after, "neutralSamples": neutral,
		"quarantinePreserved": true, "completedAtMs": UInt64(Date().timeIntervalSince1970 * 1000)]
}
