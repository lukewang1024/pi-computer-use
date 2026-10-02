import Foundation

@main struct Tests {
	static func main() throws {
		for text in ["", "abc", "中🙂e\u{301}", String(repeating: "中🙂👨‍👩‍👧‍👦", count: 20)] {
			let chunks = exactTextEventChunks(text)
			precondition(chunks.joined() == text)
			precondition(Array(chunks.joined().unicodeScalars) == Array(text.unicodeScalars))
			precondition(chunks.allSatisfy { !$0.isEmpty && $0.utf16.count <= 16 })
		}
		precondition(exactWordTextEvents("a\r\nb\nc\td") == [.unicode("a"), .key("enter"), .unicode("b"), .key("enter"), .unicode("c"), .key("tab"), .unicode("d")])
		precondition(exactWordTextEvents("\r\r") == [.key("enter"), .key("enter")])
		var current = "ime"
		var calls: [String] = []
		let lease = try TextInputSourceLease(original: "ime", selected: "abc", current: { current }, select: { calls.append($0); current = $0; return true })
		try lease.assertOwned()
		precondition(current == "abc")
		precondition(lease.restoreIfOwned())
		precondition(current == "ime" && calls == ["abc", "ime"])
		calls = []
		let raced = try TextInputSourceLease(original: "ime", selected: "abc", current: { current }, select: { calls.append($0); current = $0; return true })
		current = "human-choice"
		do { try raced.assertOwned(); fatalError("changed input source was accepted") } catch TextInputSourceFailure.changed {}
		precondition(!raced.restoreIfOwned() && current == "human-choice" && calls == ["abc"])
		current = "abc"
		precondition(!raced.restoreIfOwned() && current == "abc", "observed loss must stay retired even if the source returns")
		current = "abc"; calls = []
		let unchanged = try TextInputSourceLease(original: "abc", selected: "abc", current: { current }, select: { calls.append($0); return true })
		try unchanged.assertOwned()
		precondition(!unchanged.restoreIfOwned() && calls.isEmpty)
		current = "ime"; calls = []
		do {
			_ = try TextInputSourceLease(original: "ime", selected: "abc", current: { current }, select: { calls.append($0); current = $0; return $0 != "abc" })
			fatalError("failed selection was accepted")
		} catch TextInputSourceFailure.selectionFailed {}
		precondition(current == "ime" && calls == ["abc", "ime"])
		calls = []
		do { _ = try TextInputSourceLease(original: "old", selected: "abc", current: { current }, select: { calls.append($0); return true }); fatalError("initial race accepted") } catch TextInputSourceFailure.changed {}
		precondition(calls.isEmpty)
		let empty = textInputSourceRejectedActResult(["eventsDispatched": 0])
		precondition(empty["outcome"] as? String == "didnt")
		let partial = textInputSourceRejectedActResult(["eventsDispatched": 3, "retrySafe": false, "recoveryRequired": true, "unreleasedKeys": [0]])
		precondition(partial["outcome"] as? String == "unknown")
		precondition((partial["inputDispatch"] as? [String: Any])?["retrySafe"] as? Bool == false)
		precondition((partial["inputDispatch"] as? [String: Any])?["eventsDispatched"] as? Int == 3)
		print("PASS input-source acquisition, restoration, external-change preservation, partial selection, and initial race")
	}
}
