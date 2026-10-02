import Foundation

/// Bounded Unicode payloads retain surrogate pairs across event boundaries.
func exactTextEventChunks(_ text: String, maximumUTF16Units: Int = 16) -> [String] {
	precondition(maximumUTF16Units >= 2)
	var output: [String] = []
	var chunk = ""
	var units = 0
	for scalar in text.unicodeScalars {
		let width = scalar.value > 0xffff ? 2 : 1
		if units + width > maximumUTF16Units { output.append(chunk); chunk = ""; units = 0 }
		chunk.unicodeScalars.append(scalar)
		units += width
	}
	if !chunk.isEmpty { output.append(chunk) }
	return output
}

enum WordTextInputEvent: Equatable {
	case unicode(String)
	case key(String)
}

func exactWordTextEvents(_ text: String) -> [WordTextInputEvent] {
	var output: [WordTextInputEvent] = []
	var buffer = ""
	var previousCR = false
	func flush() {
		output += exactTextEventChunks(buffer).map { .unicode($0) }
		buffer = ""
	}
	for scalar in text.unicodeScalars {
		if scalar.value == 10 && previousCR { previousCR = false; continue }
		previousCR = scalar.value == 13
		if [9, 10, 13].contains(scalar.value) {
			flush()
			output.append(.key(scalar.value == 9 ? "tab" : "enter"))
		} else { buffer.unicodeScalars.append(scalar) }
	}
	flush()
	return output
}

enum TextInputSourceFailure: Error {
	case changed
	case selectionFailed
}

struct TextInputSourceDispatchFailure: Error {
	let inputDispatch: [String: Any]
}

func textInputSourceRejectedActResult(_ inputDispatch: [String: Any]) -> [String: Any] {
	let partial = (inputDispatch["eventsDispatched"] as? Int ?? 0) > 0
	var result: [String: Any] = [
		"outcome": partial ? "unknown" : "didnt",
		"performed": ["delivery": "hid"],
		"error": ["code": "input_source_changed", "message": "The input source changed; remaining text was not sent. Do not replay dispatched text."],
	]
	if partial { result["inputDispatch"] = inputDispatch }
	return result
}

/// Ownership is conditional: an external input-source change must never be
/// overwritten during cleanup, and must stop the remaining synthetic text.
final class TextInputSourceLease {
	private let original: String
	private let selected: String
	private let current: () -> String?
	private let select: (String) -> Bool
	private var ownershipLost = false

	init(original: String, selected: String, current: @escaping () -> String?, select: @escaping (String) -> Bool) throws {
		self.original = original
		self.selected = selected
		self.current = current
		self.select = select
		guard current() == original else { throw TextInputSourceFailure.changed }
		if original != selected {
			guard select(selected), current() == selected else {
				// Selection may have taken effect despite an unsuccessful return.
				if current() == selected { _ = select(original) }
				throw TextInputSourceFailure.selectionFailed
			}
		}
	}

	func assertOwned() throws {
		guard !ownershipLost, current() == selected else {
			ownershipLost = true
			throw TextInputSourceFailure.changed
		}
	}

	@discardableResult func restoreIfOwned() -> Bool {
		guard !ownershipLost, original != selected, current() == selected else { return false }
		return select(original)
	}
}
