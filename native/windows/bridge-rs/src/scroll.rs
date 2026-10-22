//! Bounded Windows scroll intent shared by semantic and wheel delivery.

use serde_json::Value;

pub const MAX_STEPS: i32 = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScrollPlan {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Dispatch<E> {
    pub attempted: usize,
    pub completed: usize,
    pub error: Option<E>,
}

impl ScrollPlan {
    pub fn new(x: f64, y: f64) -> Result<Self, String> {
        let valid = |n: f64| n.is_finite() && n.fract() == 0.0 && n.abs() <= f64::from(MAX_STEPS);
        if !valid(x) || !valid(y) {
            return Err(
                "Windows scroll requires integer small steps in [-20,20], not pixels".into(),
            );
        }
        Ok(Self {
            x: x as i32,
            y: y as i32,
        })
    }

    pub fn from_params(params: &Value) -> Result<Self, String> {
        let axis = |name| match params.get(name) {
            None => Ok(0.0),
            Some(value) => value
                .as_f64()
                .ok_or_else(|| "Scroll amount must be numeric".to_owned()),
        };
        Self::new(axis("scrollX")?, axis("scrollY")?)
    }

    pub fn len(self) -> usize {
        self.x.abs().max(self.y.abs()) as usize
    }

    pub fn is_empty(self) -> bool {
        self.len() == 0
    }

    /// These are the requested increments, not retries of an uncertain action.
    /// Stop at the first provider error, retaining the exact attempted prefix.
    pub fn dispatch<E>(self, mut send: impl FnMut(i32, i32) -> Result<(), E>) -> Dispatch<E> {
        for i in 0..self.len() {
            let x = if i < self.x.abs() as usize {
                self.x.signum()
            } else {
                0
            };
            let y = if i < self.y.abs() as usize {
                self.y.signum()
            } else {
                0
            };
            if let Err(error) = send(x, y) {
                return Dispatch {
                    attempted: i + 1,
                    completed: i,
                    error: Some(error),
                };
            }
        }
        Dispatch {
            attempted: self.len(),
            completed: self.len(),
            error: None,
        }
    }

    pub fn wheel_deltas(self) -> (i32, i32) {
        (self.x * 120, -self.y * 120)
    }

    pub fn verifies_progress(
        self,
        before: (Option<f64>, Option<f64>),
        after: (Option<f64>, Option<f64>),
    ) -> bool {
        let axis = |steps: i32, a: Option<f64>, b: Option<f64>| {
            steps == 0
                || matches!((a, b), (Some(a), Some(b))
                if a.is_finite() && b.is_finite() && (b - a) * f64::from(steps.signum()) > f64::EPSILON)
        };
        !self.is_empty() && axis(self.x, before.0, after.0) && axis(self.y, before.1, after.1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn magnitude_is_preserved_on_both_paths() {
        for amount in [-20_i32, -6, -3, 0, 1, 3, 6, 20] {
            let plan = ScrollPlan::new(0.0, f64::from(amount)).unwrap();
            let mut calls = Vec::new();
            let report = plan.dispatch(|x, y| {
                calls.push((x, y));
                Ok::<_, ()>(())
            });
            assert_eq!(calls.len(), amount.unsigned_abs() as usize);
            assert_eq!(calls.iter().map(|(_, y)| y).sum::<i32>(), amount);
            assert_eq!(plan.wheel_deltas().1, -amount * 120);
            assert_eq!(report.completed, calls.len());
        }
    }

    #[test]
    fn mixed_axes_finish_without_extra_input_on_the_shorter_axis() {
        let mut calls = Vec::new();
        ScrollPlan::new(-2.0, 4.0).unwrap().dispatch(|x, y| {
            calls.push((x, y));
            Ok::<_, ()>(())
        });
        assert_eq!(calls, [(-1, 1), (-1, 1), (0, 1), (0, 1)]);
    }

    #[test]
    fn error_preserves_the_prefix_and_never_replays_or_continues() {
        let mut calls = 0;
        let report = ScrollPlan::new(0.0, 6.0).unwrap().dispatch(|_, _| {
            calls += 1;
            if calls == 2 {
                Err("provider returned after an uncertain effect")
            } else {
                Ok(())
            }
        });
        assert_eq!(calls, 2);
        assert_eq!(report.attempted, 2);
        assert_eq!(report.completed, 1);
        assert!(report.error.is_some());
    }

    #[test]
    fn invalid_units_and_large_deltas_are_rejected_before_dispatch() {
        for value in [21.0, -21.0, 6000.0, 0.5, f64::NAN, f64::INFINITY] {
            assert!(ScrollPlan::new(value, 0.0).is_err());
            assert!(ScrollPlan::new(0.0, value).is_err());
        }
        assert!(ScrollPlan::from_params(&json!({"scrollY":"3"})).is_err());
        assert!(ScrollPlan::from_params(&json!({"scrollY":null})).is_err());
        assert!(ScrollPlan::from_params(&json!({})).unwrap().is_empty());
    }

    #[test]
    fn progress_requires_readback_in_each_requested_direction() {
        let down = ScrollPlan::new(0.0, 3.0).unwrap();
        assert!(down.verifies_progress((None, Some(10.0)), (None, Some(20.0))));
        assert!(!down.verifies_progress((None, Some(10.0)), (None, Some(10.0))));
        assert!(!down.verifies_progress((None, Some(10.0)), (None, Some(0.0))));
        assert!(!down.verifies_progress((None, None), (None, Some(20.0))));
        assert!(!ScrollPlan::new(3.0, 3.0)
            .unwrap()
            .verifies_progress((Some(10.0), Some(10.0)), (Some(10.0), Some(20.0))));
    }
}
