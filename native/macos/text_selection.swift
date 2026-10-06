import Foundation

// AX ranges and NSString use UTF-16 offsets. Never derive a caret by counting
// Swift graphemes or silently treating canonically equivalent values as equal.
func exactSelectionValue(_ actual: String, _ expected: String) -> Bool {
    actual.utf16.elementsEqual(expected.utf16)
}

func uniqueLiteralSelectionRange(value: String, expected: String, text: String, mode: String) -> NSRange? {
    guard exactSelectionValue(value, expected), !text.isEmpty,
        expected.utf16.count <= 100_000, text.utf16.count <= 100_000,
        ["range", "start", "end"].contains(mode) else { return nil }
    let source = value as NSString
    let match = source.range(of: text, options: .literal)
    guard match.location != NSNotFound else { return nil }
    // Start one unit later to reject overlapping matches as well.
    let next = source.range(of: text, options: .literal,
        range: NSRange(location: match.location + 1, length: source.length - match.location - 1))
    guard next.location == NSNotFound else { return nil }
    if mode == "start" { return NSRange(location: match.location, length: 0) }
    if mode == "end" { return NSRange(location: NSMaxRange(match), length: 0) }
    return match
}

// Public AX type/state metadata only. Never include editor values or selectors.
func selectionPreflightMetadata(role: String, subrole: String, enabled: Bool?,
    roleStatus: Int, subroleStatus: Int, enabledStatus: Int) -> String {
    let fields: [String: Any] = ["role": String(decoding: role.utf16.prefix(64), as: UTF16.self), "subrole": String(decoding: subrole.utf16.prefix(64), as: UTF16.self),
        "enabled": enabled.map { $0 as Any } ?? "unknown",
        "roleAPIStatus": roleStatus, "subroleAPIStatus": subroleStatus, "enabledAPIStatus": enabledStatus]
    guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
        let text = String(data: data, encoding: .utf8) else { return "AX metadata unavailable" }
    return text
}
