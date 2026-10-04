import Foundation
@main struct Tests {
    static func main() {
        precondition(accessibilityValueText("中文🙂") == "中文🙂")
        precondition(accessibilityValueText(NSString(string: "native")) == "native")
        for (input, expected) in [(NSNumber(value: false), "0"), (NSNumber(value: true), "1"), (NSNumber(value: -2), "-2"), (NSNumber(value: 0.75), "0.75"), (NSNumber(value: Int64.max), "9223372036854775807")] {
            precondition(accessibilityValueText(input) == expected)
            precondition(accessibilityValueText(input, secure: true) == nil)
        }
        let unsupported: [Any?] = [nil, NSArray(array: ["private"]), NSDictionary(dictionary: ["private": "value"]), NSNumber(value: Double.nan), NSNumber(value: Double.infinity)]
        for input in unsupported {
            precondition(accessibilityValueText(input) == nil)
        }
        precondition(accessibilityValueText("secret", secure: true) == nil)
        precondition(accessibilityWriteOutcome(observed: nil, expected: "") == "unknown")
        precondition(accessibilityWriteOutcome(observed: "", expected: "") == "worked")
        precondition(accessibilityWriteOutcome(observed: "1", expected: "1") == "worked")
        precondition(accessibilityWriteOutcome(observed: "0", expected: "1") == "didnt")
        print("PASS native AX primitive values, secure redaction and unavailable write evidence")
    }
}
