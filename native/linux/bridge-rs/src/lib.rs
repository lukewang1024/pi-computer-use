//! Linux native bridge shared protocol and AT-SPI backend.

pub mod atspi;
pub mod error;
pub mod pointer_motion;
pub mod protocol;
pub mod state;
pub mod wayland;
pub mod x11;

pub use error::{ErrorCode, ProtocolError};
pub use protocol::{Request, Response};

pub mod agent_cursor;
