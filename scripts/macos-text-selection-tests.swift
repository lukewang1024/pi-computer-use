import Foundation
@main struct Tests {
    static func main() {
        let value = "🙂第一条\n 2 第二条 中文🙂\n"
        let needle = "第二条 中文🙂"
        let expected = (value as NSString).range(of: needle, options: .literal)
        precondition(uniqueLiteralSelectionRange(value: value, expected: value, text: needle, mode: "range") == expected)
        precondition(uniqueLiteralSelectionRange(value: value, expected: value, text: needle, mode: "start") == NSRange(location: expected.location, length: 0))
        precondition(uniqueLiteralSelectionRange(value: value, expected: value, text: needle, mode: "end") == NSRange(location: NSMaxRange(expected), length: 0))
        for (actual, old, text, mode) in [("aaa", "aaa", "aa", "range"), ("aa aa", "aa aa", "aa", "range"), ("new", "old", "old", "range"), (value, value, "missing", "range"), (value, value, "", "range"), (value, value, needle, "bad"), ("é", "e\u{301}", "é", "range")] {
            precondition(uniqueLiteralSelectionRange(value: actual, expected: old, text: text, mode: mode) == nil)
        }
        precondition(uniqueLiteralSelectionRange(value: "e\u{301}", expected: "e\u{301}", text: "é", mode: "range") == nil)
        let huge = String(repeating: "x", count: 100001)
        precondition(uniqueLiteralSelectionRange(value: huge, expected: huge, text: "x", mode: "range") == nil)
        let metadata = selectionPreflightMetadata(role: String(repeating: "x", count: 1000),
            subrole: "AXSecureTextField", enabled: false, roleStatus: 0, subroleStatus: 0, enabledStatus: 0)
        let fields = try! JSONSerialization.jsonObject(with: Data(metadata.utf8)) as! [String: Any]
        precondition((fields["role"] as! String).count == 64)
        let combining = selectionPreflightMetadata(role: "x" + String(repeating: "\u{301}", count: 10000),
            subrole: "", enabled: nil, roleStatus: 0, subroleStatus: 0, enabledStatus: -25205)
        let bounded = try! JSONSerialization.jsonObject(with: Data(combining.utf8)) as! [String: Any]
        precondition((bounded["role"] as! String).utf16.count <= 64)

        precondition(fields["enabled"] as? Bool == false)
        let unknown = selectionPreflightMetadata(role: "", subrole: "", enabled: nil,
            roleStatus: -25202, subroleStatus: -25205, enabledStatus: -25205)
        let missing = try! JSONSerialization.jsonObject(with: Data(unknown.utf8)) as! [String: Any]
        precondition(missing["enabled"] as? String == "unknown")
        precondition(missing["roleAPIStatus"] as? Int == -25202)
        precondition(Set(fields.keys) == Set(["role", "subrole", "enabled", "roleAPIStatus", "subroleAPIStatus", "enabledAPIStatus"]))
        print("PASS exact Unicode value, unique literal selection, overlap rejection and UTF-16 caret ranges")
    }
}
