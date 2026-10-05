import Foundation
import CoreGraphics

struct ControlledError: Error { let code: String; let completed: Bool? }
@main struct Tests {
    static func main() throws {
        let frame = CGRect(x: -500, y: 35, width: 900, height: 600)
        precondition(verifiedCapturedWindowFrame(capturedFrame: frame, capturedPid: 42, currentFrame: frame, currentPid: 42) == frame)
        for changed in [CGRect(x: -499, y: 35, width: 900, height: 600),
                        CGRect(x: -500, y: 35, width: 901, height: 600)] {
            precondition(verifiedCapturedWindowFrame(capturedFrame: frame, capturedPid: 42, currentFrame: changed, currentPid: 42) == nil)
        }
        precondition(verifiedCapturedWindowFrame(capturedFrame: frame, capturedPid: 42, currentFrame: frame, currentPid: 43) == nil)
        precondition(verifiedCapturedWindowFrame(capturedFrame: frame, capturedPid: nil, currentFrame: frame, currentPid: 42) == nil)
        precondition(verifiedCapturedWindowFrame(capturedFrame: frame, capturedPid: 42, currentFrame: nil, currentPid: 42) == nil)
        for invalid in [CGRect.zero, CGRect.infinite, CGRect.null,
                        CGRect(x: Double.nan, y: 0, width: 10, height: 10)] {
            precondition(verifiedCapturedWindowFrame(capturedFrame: invalid, capturedPid: 42, currentFrame: invalid, currentPid: 42) == nil)
        }
        precondition(classifyOptionalImageFailure(code: "capture_geometry_changed", message: "changed", taskCompleted: true) == nil)
        print("PASS captured geometry: same frame/owner only; move, resize, missing owner/window and invalid geometry reject")
        var captures = 0
        func attempt(_ error: ControlledError?, allowed: Bool = true) throws -> (value: Int?, failure: OptionalImageFailure?) {
            try captureOptionalImage(allowed: allowed, operation: {
                captures += 1
                if let error { throw error }
                return 42
            }, classify: { error in
                guard let e = error as? ControlledError else { return nil }
                return classifyOptionalImageFailure(code: e.code, message: String(repeating: "x", count: 3000), taskCompleted: e.completed)
            })
        }
        let success = try attempt(nil)
        precondition(success.value == 42 && success.failure == nil && captures == 1)
        for (code, completed, expectation) in [
            ("capture_failed", true, "completed"), ("capture_failed", false, "unconfirmed"),
            ("capture_timeout", false, "unconfirmed"), ("capture_busy", false, "completed"),
            ("encoding_failed", true, "completed")
        ] {
            let before = captures
            let result = try attempt(ControlledError(code: code, completed: completed))
            precondition(result.value == nil && result.failure?.nativeCompletion == expectation)
            precondition(result.failure?.message.count == 1024 && captures == before + 1)
        }
        // Missing lifetime evidence cannot imply capture completion.
        let unknown = try attempt(ControlledError(code: "capture_timeout", completed: nil))
        precondition(unknown.failure?.nativeCompletion == "unconfirmed")
        for code in ["window_not_found", "element_ref_invalid", "permission_policy", "protocol_error"] {
            let before = captures
            do { _ = try attempt(ControlledError(code: code, completed: true)); preconditionFailure("Identity/policy errors cannot degrade") }
            catch { precondition((error as? ControlledError)?.code == code && captures == before + 1) }
        }
        let before = captures
        do { _ = try attempt(ControlledError(code: "capture_failed", completed: true), allowed: false); preconditionFailure("Strict capture must throw") }
        catch { precondition(captures == before + 1) }
        print("PASS native optional capture: one attempt, bounded failure, lifetime truth and strict identity/policy errors")
    }
}
