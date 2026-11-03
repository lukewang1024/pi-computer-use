use serde::Serialize;
use std::fmt;

/// Error code strings sent in JSON error responses.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ErrorCode {
    #[serde(rename = "capability_deferred")]
    CapabilityDeferred,
    #[serde(rename = "unsupported_command")]
    UnsupportedCommand,
    #[serde(rename = "invalid_request")]
    InvalidRequest,
    #[serde(rename = "target_not_found")]
    TargetNotFound,
    #[serde(rename = "internal_error")]
    InternalError,
    #[serde(rename = "unsupported_platform")]
    UnsupportedPlatform,
    #[serde(rename = "capture_failed")]
    CaptureFailed,
    #[serde(rename = "stale_look")]
    StaleLook,
    #[serde(rename = "stale_ref")]
    StaleRef,
    #[serde(rename = "coordinate_unavailable_for_root")]
    CoordinateUnavailableForRoot,
    #[serde(rename = "coordinate_blocked")]
    CoordinateBlocked,
    #[serde(rename = "foreground_required")]
    ForegroundRequired,
    #[serde(rename = "occluded_target")]
    OccludedTarget,
    #[serde(rename = "secure_text_unreadable")]
    SecureTextUnreadable,
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            ErrorCode::CapabilityDeferred => "capability_deferred",
            ErrorCode::UnsupportedCommand => "unsupported_command",
            ErrorCode::InvalidRequest => "invalid_request",
            ErrorCode::TargetNotFound => "target_not_found",
            ErrorCode::InternalError => "internal_error",
            ErrorCode::UnsupportedPlatform => "unsupported_platform",
            ErrorCode::CaptureFailed => "capture_failed",
            ErrorCode::StaleLook => "stale_look",
            ErrorCode::StaleRef => "stale_ref",
            ErrorCode::CoordinateUnavailableForRoot => "coordinate_unavailable_for_root",
            ErrorCode::CoordinateBlocked => "coordinate_blocked",
            ErrorCode::ForegroundRequired => "foreground_required",
            ErrorCode::OccludedTarget => "occluded_target",
            ErrorCode::SecureTextUnreadable => "secure_text_unreadable",
        };
        write!(f, "{s}")
    }
}

/// A typed protocol error with a human-readable message and a machine-readable code.
#[derive(Debug, Clone, Serialize)]
pub struct ProtocolError {
    pub message: String,
    pub code: ErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    preflight: Option<InputPreflight>,
}

/// Proof from the point-selection boundary, before invoking the input action.
/// Keep construction private so ordinary native errors never acquire it.
#[derive(Debug, Clone, Serialize)]
struct InputPreflight {
    version: u8,
    phase: &'static str,
    #[serde(rename = "inputDispatched")]
    input_dispatched: bool,
    recoverable: bool,
    recovery: &'static str,
}

impl ProtocolError {
    pub fn new(message: impl Into<String>, code: ErrorCode) -> Self {
        Self {
            message: message.into(),
            code,
            preflight: None,
        }
    }

    /// Only use before input::act. An occlusion error after a cursor move,
    /// emitted click prefix or UIA mutation must retain the ordinary error.
    pub fn occluded_before_input() -> Self {
        Self::before_input("Target is occluded", ErrorCode::OccludedTarget)
    }

    /// Rejects in the raw-input policy guard, before dispatching the action.
    pub fn foreground_before_input() -> Self {
        Self::before_input(
            "Background policy blocks global Windows coordinate/raw input grounding",
            ErrorCode::ForegroundRequired,
        )
    }

    fn before_input(message: &str, code: ErrorCode) -> Self {
        Self {
            message: message.into(),
            code,
            preflight: Some(InputPreflight {
                version: 1,
                phase: "before_input",
                input_dispatched: false,
                recoverable: true,
                recovery: "observe_ui",
            }),
        }
    }
}

impl std::error::Error for ProtocolError {}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Response;
    use serde_json::json;

    #[test]
    fn before_input_occlusion_proof_survives_the_protocol_envelope() {
        let response = Response::err("fixture", ProtocolError::occluded_before_input());
        let wire = serde_json::to_value(response).unwrap();
        assert_eq!(wire["ok"], false);
        assert_eq!(wire["id"], "fixture");
        assert_eq!(wire["error"]["code"], "occluded_target");
        assert_eq!(
            wire["error"]["preflight"],
            json!({"version":1,"phase":"before_input","inputDispatched":false,
                "recoverable":true,"recovery":"observe_ui"})
        );
        let foreground = serde_json::to_value(Response::err(
            "foreground",
            ProtocolError::foreground_before_input(),
        ))
        .unwrap();
        assert_eq!(foreground["error"]["code"], "foreground_required");
        assert_eq!(foreground["error"]["preflight"], wire["error"]["preflight"]);
    }

    #[test]
    fn ordinary_native_errors_do_not_claim_non_delivery() {
        for code in [
            ErrorCode::OccludedTarget,
            ErrorCode::StaleRef,
            ErrorCode::ForegroundRequired,
            ErrorCode::InternalError,
        ] {
            let error = ProtocolError::new("Input was not sent", code);
            let wire = serde_json::to_value(Response::err("fixture", error)).unwrap();
            assert!(wire["error"].get("preflight").is_none());
        }
    }
}
