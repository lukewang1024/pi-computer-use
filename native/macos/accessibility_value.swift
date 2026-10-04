import Foundation

// AXValue is commonly a CFNumber/CFBoolean for native controls. Never serialize
// arbitrary object descriptions, nonfinite values, or secure-field contents.
func accessibilityValueText(_ value: Any?, secure: Bool = false) -> String? {
    guard !secure, let value else { return nil }
    if let text = value as? String { return text }
    guard let number = value as? NSNumber, number.doubleValue.isFinite else { return nil }
    return number.stringValue
}

func accessibilityWriteOutcome(observed: String?, expected: String) -> String {
    guard let observed else { return "unknown" }
    return observed == expected ? "worked" : "didnt"
}
