//! Bounded diagnostic progress only; never an input-delivery acknowledgment.
use serde_json::{json, Value};
use std::cell::RefCell;
use std::io::Write;
use std::time::Instant;

struct Trace {
    id: String,
    started: Instant,
    emitted: usize,
}
thread_local! { static CURRENT: RefCell<Option<Trace>> = const { RefCell::new(None) }; }
pub struct Guard;

pub fn begin(id: &str) -> Guard {
    let valid = !id.is_empty()
        && id.len() <= 128
        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    CURRENT.with(|slot| {
        *slot.borrow_mut() = valid.then(|| Trace {
            id: id.to_owned(),
            started: Instant::now(),
            emitted: 0,
        })
    });
    phase("request_started");
    Guard
}

fn event(id: &str, stage: &str, elapsed_ms: u128) -> Value {
    json!({"event":"cu_action_phase", "requestId":id, "stage":stage,
        "elapsedMs":elapsed_ms.min(86_400_000)})
}

pub fn phase(stage: &'static str) {
    CURRENT.with(|slot| {
        if let Some(trace) = slot.borrow_mut().as_mut() {
            if trace.emitted < 32 {
                let _ = writeln!(
                    std::io::stderr().lock(),
                    "{}",
                    event(&trace.id, stage, trace.started.elapsed().as_millis())
                );
                trace.emitted += 1;
            }
        }
    });
}
impl Drop for Guard {
    fn drop(&mut self) {
        phase("request_finished");
        CURRENT.with(|slot| *slot.borrow_mut() = None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_event_has_no_action_arguments() {
        let row = event("request-1", "request_started", 42);
        assert_eq!(row.as_object().unwrap().len(), 4);
        assert_eq!(row["elapsedMs"], 42);
        assert_eq!(
            event("request-1", "request_started", u128::MAX)["elapsedMs"],
            86_400_000
        );
    }
    #[test]
    fn trace_is_bounded_and_scoped_to_request() {
        {
            let _guard = begin("request-1");
            for _ in 0..100 {
                phase("reference_resolution_started");
            }
            CURRENT.with(|s| assert_eq!(s.borrow().as_ref().unwrap().emitted, 32));
        }
        CURRENT.with(|s| assert!(s.borrow().is_none()));
        let _guard = begin("sensitive text / invalid id");
        CURRENT.with(|s| assert!(s.borrow().is_none()));
    }
}
