use serde::Serialize;
use std::fmt;

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
    #[serde(rename = "semantic_dispatch_unknown")]
    SemanticDispatchUnknown,
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
    #[serde(rename = "secure_text_unreadable")]
    SecureTextUnreadable,
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let text = serde_json::to_value(self)
            .ok()
            .and_then(|value| value.as_str().map(str::to_owned))
            .unwrap_or_else(|| "internal_error".to_owned());
        f.write_str(&text)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ProtocolError {
    pub message: String,
    pub code: ErrorCode,
    #[serde(skip_serializing_if = "Option::is_none")]
    preflight: Option<ActionPreflight>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActionPreflight {
    version: u8,
    phase: &'static str,
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

    pub fn before_input(mut self) -> Self {
        self.preflight = Some(ActionPreflight {
            version: 1,
            phase: "before_input",
            input_dispatched: false,
            recoverable: true,
            recovery: "observe_ui",
        });
        self
    }

    pub fn rejected_before_input(&self) -> bool {
        self.preflight.is_some()
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for ProtocolError {}
