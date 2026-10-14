use std::time::{Duration, Instant};
pub struct PointerMotion {
    points: Vec<(i32, i32)>,
    pub duration_ms: u64,
}
#[derive(Debug)]
pub struct MotionFailure<E> {
    pub error: E,
    pub samples: usize,
}
pub struct MotionReport {
    pub samples: usize,
    pub elapsed_ms: u64,
}
impl PointerMotion {
    pub fn new(points: Vec<(i32, i32)>, duration_ms: u64) -> Result<Self, &'static str> {
        if points.len() < 2 || points.len() > 601 {
            return Err("pointer trajectory requires 2 to 601 resolved points");
        }
        if duration_ms > 30_000 {
            return Err("durationMs must be an integer between 0 and 30000");
        }
        Ok(Self {
            points,
            duration_ms,
        })
    }
    pub fn use_visual_origin(&mut self, origin: Option<(i32, i32)>) {
        if self.points.len() == 2 && self.points[0] == self.points[1] {
            if let Some(origin) = origin {
                self.points[0] = origin;
            }
        }
    }
    pub fn sample(&self, elapsed_ms: u64) -> (i32, i32) {
        if self.duration_ms == 0 || elapsed_ms >= self.duration_ms {
            return *self.points.last().unwrap();
        }
        let position = elapsed_ms as f64 / self.duration_ms as f64 * (self.points.len() - 1) as f64;
        let index = (position.floor() as usize).min(self.points.len() - 2);
        let fraction = position - index as f64;
        let a = self.points[index];
        let b = self.points[index + 1];
        (
            (a.0 as f64 + (b.0 as f64 - a.0 as f64) * fraction).round() as i32,
            (a.1 as f64 + (b.1 as f64 - a.1 as f64) * fraction).round() as i32,
        )
    }
    pub fn run<E>(
        &self,
        mut emit: impl FnMut(i32, i32) -> Result<(), E>,
    ) -> Result<MotionReport, MotionFailure<E>> {
        let start = Instant::now();
        let mut samples = 0;
        loop {
            let elapsed = start.elapsed().as_millis() as u64;
            let (x, y) = self.sample(elapsed);
            if let Err(error) = emit(x, y) {
                return Err(MotionFailure { error, samples });
            }
            samples += 1;
            if elapsed >= self.duration_ms {
                return Ok(MotionReport {
                    samples,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                });
            }
            std::thread::sleep(Duration::from_millis(16.min(self.duration_ms - elapsed)));
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn interpolation_preserves_turns_and_endpoint() {
        let p = PointerMotion::new(vec![(0, 0), (100, 50), (-100, -50)], 1000).unwrap();
        assert_eq!(p.sample(250), (50, 25));
        assert_eq!(p.sample(500), (100, 50));
        assert_eq!(p.sample(750), (0, 0));
        assert_eq!(p.sample(1100), (-100, -50));
        let p = PointerMotion::new(vec![(i32::MIN, i32::MIN), (i32::MAX, i32::MAX)], 1000).unwrap();
        assert_eq!(p.sample(1000), (i32::MAX, i32::MAX));
    }
    #[test]
    fn rejects_unbounded_motion() {
        assert!(PointerMotion::new(vec![(0, 0)], 1).is_err());
        assert!(PointerMotion::new(vec![(0, 0); 602], 1).is_err());
        assert!(PointerMotion::new(vec![(0, 0); 2], 30001).is_err());
    }
    #[test]
    fn failed_guard_stops_without_another_event() {
        let p = PointerMotion::new(vec![(0, 0), (100, 50)], 100).unwrap();
        let mut attempts = 0;
        let e = p
            .run(|_, _| {
                attempts += 1;
                if attempts == 2 {
                    Err("target changed")
                } else {
                    Ok(())
                }
            })
            .err()
            .unwrap();
        assert_eq!(attempts, 2);
        assert_eq!(e.samples, 1);
    }
    #[test]
    fn zero_duration_emits_endpoint_once() {
        let p = PointerMotion::new(vec![(0, 0), (100, 50)], 0).unwrap();
        let mut sent = vec![];
        let r = p
            .run(|x, y| {
                sent.push((x, y));
                Ok::<_, ()>(())
            })
            .unwrap();
        assert_eq!(sent, vec![(100, 50)]);
        assert_eq!(r.samples, 1);
    }
}
