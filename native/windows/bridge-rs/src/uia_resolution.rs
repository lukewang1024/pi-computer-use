//! Read-only resolution must complete and restore provider settings before input.

const EXPIRED: &str = "UIA reference resolution budget exceeded; input was not sent";

pub(crate) fn timeouts(elapsed_ms: u128, budget_ms: u64) -> Result<(u32, u32), String> {
    let remaining = (budget_ms as u128).saturating_sub(elapsed_ms);
    if remaining == 0 {
        return Err(EXPIRED.to_owned());
    }
    Ok((remaining.min(2_000) as u32, remaining.min(3_000) as u32))
}

pub(crate) fn finish<T>(
    resolved: Result<T, String>,
    restore: impl FnOnce() -> Result<(), String>,
    budget_available: impl FnOnce() -> Result<(), String>,
) -> Result<T, String> {
    // Restore even after failed lookup. Never expose an element if restoration
    // fails, or if lookup/restoration consumed the remaining pre-input budget.
    restore()?;
    let element = resolved?;
    budget_available()?;
    Ok(element)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    #[test]
    fn shrinking_timeouts_and_expired_boundary() {
        assert_eq!(timeouts(0, 8_000).unwrap(), (2_000, 3_000));
        assert_eq!(timeouts(7_999, 8_000).unwrap(), (1, 1));
        for elapsed in [8_000, 8_001, u128::MAX] {
            assert!(timeouts(elapsed, 8_000).is_err());
        }
        assert!(timeouts(0, 0).is_err());
    }

    #[test]
    fn successful_resolution_restores_before_dispatch() {
        let trace = RefCell::new(Vec::new());
        let result = finish(
            Ok(42),
            || {
                trace.borrow_mut().push("restore");
                Ok(())
            },
            || {
                trace.borrow_mut().push("budget");
                Ok(())
            },
        );
        result.map(|_| trace.borrow_mut().push("dispatch")).unwrap();
        assert_eq!(*trace.borrow(), ["restore", "budget", "dispatch"]);
    }

    #[test]
    fn lookup_restore_or_deadline_failure_never_exposes_dispatch_target() {
        for failure in ["lookup", "restore", "deadline"] {
            let restored = Cell::new(false);
            let dispatched = Cell::new(false);
            let result = finish(
                if failure == "lookup" {
                    Err("provider timed out".into())
                } else {
                    Ok(42)
                },
                || {
                    restored.set(true);
                    if failure == "restore" {
                        Err("restore failed".into())
                    } else {
                        Ok(())
                    }
                },
                || {
                    if failure == "deadline" {
                        Err(EXPIRED.into())
                    } else {
                        Ok(())
                    }
                },
            );
            let result = result.map(|_| dispatched.set(true));
            assert!(result.is_err(), "{failure}");
            assert!(restored.get(), "{failure}");
            assert!(!dispatched.get(), "{failure}");
        }
    }
}
