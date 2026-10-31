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

pub struct PreparedTarget {
    pub rect: (f64, f64, f64, f64),
    pub runtime_id: Vec<i32>,
}

#[derive(Debug, PartialEq)]
pub enum PointSelection {
    Clear((f64, f64)),
    Occluded,
    StaleIdentity,
}

/// Preparation may change focus/layout, but cannot authorize a covered pixel.
/// The caller still dispatches input only after Clear and its final HWND guard.
pub fn select_clear_point_with_preparation<E>(
    rect: (f64, f64, f64, f64),
    runtime_id: &[i32],
    mut accepts: impl FnMut(f64, f64) -> Result<bool, E>,
    prepare: impl FnOnce() -> Result<Option<PreparedTarget>, E>,
) -> Result<PointSelection, E> {
    if let Some(point) = select_clear_point(rect, &mut accepts)? {
        return Ok(PointSelection::Clear(point));
    }
    if interior_points(rect).is_empty() {
        return Ok(PointSelection::Occluded);
    }
    if runtime_id.is_empty() {
        return Ok(PointSelection::StaleIdentity);
    }
    let Some(prepared) = prepare()? else {
        return Ok(PointSelection::Occluded);
    };
    if prepared.runtime_id != runtime_id {
        return Ok(PointSelection::StaleIdentity);
    }
    Ok(match select_clear_point(prepared.rect, accepts)? {
        Some(point) => PointSelection::Clear(point),
        None => PointSelection::Occluded,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn a_clear_target_does_not_prepare_focus() {
        assert_eq!(
            select_clear_point_with_preparation((0.0, 0.0, 20.0, 24.0), &[1],
                |_, _| Ok::<_, ()>(true), || panic!("unnecessary focus")),
            Ok(PointSelection::Clear((10.0, 12.0)))
        );
    }

    #[test]
    fn focus_uses_fresh_geometry_and_the_same_identity() {
        let focused = Cell::new(false);
        let calls = Cell::new(0);
        let selected = select_clear_point_with_preparation((0.0, 0.0, 20.0, 24.0), &[1],
            |x, y| {
                calls.set(calls.get() + 1);
                // The original geometry is no longer a valid target location.
                Ok::<_, ()>(focused.get() && x == 110.0 && y == 212.0)
            }, || {
                focused.set(true);
                Ok(Some(PreparedTarget {rect: (100.0, 200.0, 20.0, 24.0), runtime_id: vec![1]}))
            }).unwrap();
        assert_eq!(selected, PointSelection::Clear((110.0, 212.0)));
        assert_eq!(calls.get(), 10);
    }

    #[test]
    fn actual_occlusion_remains_rejected_after_focus() {
        let focus_calls = Cell::new(0);
        let probes = Cell::new(0);
        assert_eq!(select_clear_point_with_preparation((0.0, 0.0, 20.0, 24.0), &[1],
            |_, _| {probes.set(probes.get() + 1); Ok::<_, ()>(false)}, || {
                focus_calls.set(focus_calls.get() + 1);
                Ok(Some(PreparedTarget {rect: (0.0, 0.0, 20.0, 24.0), runtime_id: vec![1]}))
            }), Ok(PointSelection::Occluded));
        assert_eq!(focus_calls.get(), 1);
        assert_eq!(probes.get(), 18);
    }

    #[test]
    fn a_replaced_target_is_not_probed_after_focus() {
        let probes = Cell::new(0);
        assert_eq!(select_clear_point_with_preparation((0.0, 0.0, 20.0, 24.0), &[1],
            |_, _| {probes.set(probes.get() + 1); Ok::<_, ()>(false)}, || {
                Ok(Some(PreparedTarget {rect: (100.0, 200.0, 20.0, 24.0), runtime_id: vec![2]}))
            }), Ok(PointSelection::StaleIdentity));
        assert_eq!(probes.get(), 9);
    }

    #[test]
    fn declined_or_uncertain_focus_never_continues_probing() {
        let probes = Cell::new(0);
        assert_eq!(select_clear_point_with_preparation((0.0, 0.0, 20.0, 24.0), &[1],
            |_, _| {probes.set(probes.get() + 1); Ok::<_, &str>(false)}, || Ok(None)),
            Ok(PointSelection::Occluded));
        assert_eq!(probes.get(), 9);
        probes.set(0);
        assert_eq!(select_clear_point_with_preparation((0.0, 0.0, 20.0, 24.0), &[1],
            |_, _| {probes.set(probes.get() + 1); Ok(false)}, || Err("focus completion uncertain")),
            Err("focus completion uncertain"));
        assert_eq!(probes.get(), 9);
    }

    #[test]
    fn failed_resolution_does_not_prepare_or_continue() {
        let probes = Cell::new(0);
        assert_eq!(select_clear_point_with_preparation((0.0, 0.0, 20.0, 24.0), &[1],
            |_, _| {probes.set(probes.get() + 1); Err("resolution failed")},
            || panic!("focus after failed resolution")), Err("resolution failed"));
        assert_eq!(probes.get(), 1);
    }

    #[test]
    fn invalid_geometry_and_missing_identity_do_not_prepare() {
        assert_eq!(select_clear_point_with_preparation((0.0, 0.0, 0.0, 24.0), &[1],
            |_, _| -> Result<bool, ()> {panic!("unsafe geometry probe")},
            || panic!("focus with invalid geometry")), Ok(PointSelection::Occluded));
        assert_eq!(select_clear_point_with_preparation((0.0, 0.0, 20.0, 24.0), &[],
            |_, _| Ok::<_, ()>(false), || panic!("focus without exact identity")),
            Ok(PointSelection::StaleIdentity));
    }

    #[test]
    fn an_error_in_the_fresh_point_search_stops_immediately() {
        let prepared = Cell::new(false);
        let probes = Cell::new(0);
        assert_eq!(select_clear_point_with_preparation((0.0, 0.0, 20.0, 24.0), &[1],
            |_, _| {probes.set(probes.get() + 1); if prepared.get() {Err("fresh resolution failed")} else {Ok(false)}},
            || {prepared.set(true); Ok(Some(PreparedTarget {rect: (100.0, 200.0, 20.0, 24.0), runtime_id: vec![1]}))}),
            Err("fresh resolution failed"));
        assert_eq!(probes.get(), 10);
    }

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
