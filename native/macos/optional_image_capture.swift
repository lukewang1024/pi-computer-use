struct OptionalImageFailure {
    let code: String
    let message: String
    let nativeCompletion: String
}

func classifyOptionalImageFailure(code: String, message: String, taskCompleted: Bool?) -> OptionalImageFailure? {
    // Identity, permission policy, protocol and programming errors remain errors.
    guard ["capture_failed", "capture_timeout", "capture_busy", "encoding_failed"].contains(code) else { return nil }
    let completed = code == "capture_busy" || code == "encoding_failed" || taskCompleted == true
    return OptionalImageFailure(code: String(code.prefix(256)), message: String(message.prefix(1024)),
        nativeCompletion: completed ? "completed" : "unconfirmed")
}

func captureOptionalImage<Value>(allowed: Bool, operation: () throws -> Value,
    classify: (Error) -> OptionalImageFailure?) throws -> (value: Value?, failure: OptionalImageFailure?) {
    do { return (try operation(), nil) }
    catch {
        guard allowed, let failure = classify(error) else { throw error }
        // Returning semantic evidence never retries capture or claims cancellation completed.
        return (nil, failure)
    }
}
