//! Choose a physical pixel without weakening the caller's UIA identity check.
//! A decorative sibling can cover an editor/checkbox center while other pixels
//! still belong to the exact target. No input occurs during this bounded search.

pub fn interior_points(rect: (f64, f64, f64, f64)) -> Vec<(f64, f64)> {
    let (x, y, w, h) = rect;
    let (right, bottom) = (x + w, y + h);
    if ![x, y, w, h, right, bottom].iter().all(|n| n.is_finite()) || w <= 0.0 || h <= 0.0 {
        return Vec::new();
    }
    // ElementFromPoint rounds to signed physical screen pixels. Select those
    // pixels first so rounding cannot move an edge candidate outside the target.
    let (min_x, max_x) = (x.ceil(), right.ceil() - 1.0);
    let (min_y, max_y) = (y.ceil(), bottom.ceil() - 1.0);
    if min_x > max_x
        || min_y > max_y
        || min_x < i32::MIN as f64
        || max_x > i32::MAX as f64
        || min_y < i32::MIN as f64
        || max_y > i32::MAX as f64
    {
        return Vec::new();
    }
    let xs = [
        (x + w / 2.0).round().clamp(min_x, max_x),
        (x + 1.0).ceil().clamp(min_x, max_x),
        (right - 1.0).floor().clamp(min_x, max_x),
    ];
    let ys = [
        (y + h / 2.0).round().clamp(min_y, max_y),
        (y + 1.0).ceil().clamp(min_y, max_y),
        (bottom - 1.0).floor().clamp(min_y, max_y),
    ];
    let mut points = Vec::with_capacity(9);
    for px in xs {
        for py in ys {
            if !points.contains(&(px, py)) {
                points.push((px, py));
            }
        }
    }
    points
}

pub fn select_clear_point<E>(
    rect: (f64, f64, f64, f64),
    mut accepts: impl FnMut(f64, f64) -> Result<bool, E>,
) -> Result<Option<(f64, f64)>, E> {
    for (x, y) in interior_points(rect) {
        // Stale/ambiguous resolution is terminal, not a reason to try a different
        // identity. A covered point alone permits the next read-only probe.
        if accepts(x, y)? {
            return Ok(Some((x, y)));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decorative_center_does_not_hide_an_exact_target_pixel() {
        let rect = (100.0, 200.0, 20.0, 24.0);
        let mut probes = Vec::new();
        let selected = select_clear_point(rect, |x, y| {
            probes.push((x, y));
            // The predicate still rejects the sibling image; only pixels that
            // resolve to the checkbox itself are accepted.
            Ok::<_, ()>(!(101.0..119.0).contains(&x) || !(203.0..221.0).contains(&y))
        })
        .unwrap()
        .unwrap();
        assert_eq!(probes[0], (110.0, 212.0));
        assert_ne!(selected, probes[0]);
        assert!(!(203.0..221.0).contains(&selected.1));
    }

    #[test]
    fn clear_center_stops_after_one_probe() {
        let mut calls = 0;
        assert_eq!(
            select_clear_point((0.0, 0.0, 20.0, 24.0), |_, _| {
                calls += 1;
                Ok::<_, ()>(true)
            })
            .unwrap(),
            Some((10.0, 12.0))
        );
        assert_eq!(calls, 1);
    }

    #[test]
    fn complete_occlusion_stays_rejected_and_bounded() {
        let mut probes = Vec::new();
        assert_eq!(
            select_clear_point((0.0, 0.0, 20.0, 24.0), |x, y| {
                probes.push((x, y));
                Ok::<_, ()>(false)
            })
            .unwrap(),
            None
        );
        assert_eq!(probes.len(), 9);
    }

    #[test]
    fn resolver_error_stops_without_further_probes() {
        let mut calls = 0;
        let error = select_clear_point((0.0, 0.0, 20.0, 24.0), |_, _| {
            calls += 1;
            Err::<bool, _>("stale exact target")
        });
        assert_eq!(error, Err("stale exact target"));
        assert_eq!(calls, 1);
    }

    #[test]
    fn every_point_round_trips_inside_fractional_and_negative_rectangles() {
        for rect in [
            (-12.8, -40.1, 16.4, 20.7),
            (1.7, 2.8, 0.4, 0.4),
            (0.0, 0.0, 1.0, 1.0),
            (100.2, 200.4, 19.1, 23.8),
        ] {
            let points = interior_points(rect);
            assert!(!points.is_empty());
            assert!(points.len() <= 9);
            for (x, y) in &points {
                assert_eq!(*x, x.round());
                assert_eq!(*y, y.round());
                assert!(*x >= rect.0 && *x < rect.0 + rect.2);
                assert!(*y >= rect.1 && *y < rect.1 + rect.3);
                assert_eq!(points.iter().filter(|p| *p == &(*x, *y)).count(), 1);
            }
        }
        assert_eq!(interior_points((0.0, 0.0, 1.0, 1.0)), vec![(0.0, 0.0)]);
    }

    #[test]
    fn unsafe_or_empty_geometry_never_calls_the_provider() {
        for rect in [
            (0.0, 0.0, 0.0, 20.0),
            (0.0, 0.0, 20.0, -1.0),
            (f64::NAN, 0.0, 20.0, 20.0),
            (0.0, 0.0, f64::INFINITY, 20.0),
            (f64::MAX, 0.0, f64::MAX, 20.0),
            (i32::MAX as f64, 0.0, 10.0, 20.0),
            (0.1, 0.1, 0.1, 0.1),
        ] {
            assert_eq!(
                select_clear_point::<()>(rect, |_, _| panic!("unsafe probe")),
                Ok(None)
            );
        }
    }
}
