//! Explicit window reflow transaction planning.
//!
//! This module never dispatches the original UI operation. A caller must hold
//! the physical-input lock, validate the real HWND/PID, and expose a separate
//! explicit recovery request. Restoring geometry does not verify UIA recovery.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragPlan {
    pub expand_start: Point,
    pub expand_end: Point,
    pub restore_start: Point,
    pub restore_end: Point,
}

/// Both gestures remain within their pre-gesture window rectangles. Native
/// execution must additionally verify HTRIGHT and exact HWND at every point.
pub fn drag_plan(rect: Rect) -> Option<DragPlan> {
    if rect.width < 16 || rect.height < 16 {
        return None;
    }
    let right = rect.x.checked_add(rect.width)?;
    let y = rect.y.checked_add(rect.height / 2)?;
    let inside = right.checked_sub(7)?;
    let outside = right.checked_sub(3)?;
    Some(DragPlan {
        expand_start: Point { x: inside, y },
        expand_end: Point { x: outside, y },
        restore_start: Point { x: outside, y },
        restore_end: Point { x: inside, y },
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub flags: u32,
    pub show_command: u32,
    pub normal_rect: Rect,
    pub min_position: Point,
    pub max_position: Point,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Snapshot {
    pub hwnd: isize,
    pub pid: u64,
    pub rect: Rect,
    /// Native placement, when available, must be restored as well as bounds.
    pub placement: Option<Placement>,
    pub foreground: bool,
    pub normal: bool,
}

/// A rejected reflow has no window mutation. Every later outcome is potentially
/// partial, and no outcome authorizes replaying a previous input operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    RejectedBeforeMutation,
    FirstMutationUncertain,
    IntermediateChanged,
    RestoreUncertain,
    FinalStateChanged,
    GeometryRestored,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub outcome: Outcome,
    pub original: Snapshot,
    pub requested: Option<Rect>,
    pub drag_plan: Option<DragPlan>,
    pub last_observed: Option<Snapshot>,
    pub mutation_attempts: u8,
    /// A geometry result is not a fresh UIA hit test or input authorization.
    pub uia_recovery_verified: bool,
    pub original_input_retry_prohibited: bool,
}

fn same_identity_and_active(a: Snapshot, b: Snapshot) -> bool {
    a.hwnd == b.hwnd && a.pid == b.pid && b.foreground && b.normal
}

fn intermediate_placement_matches(original: Snapshot, current: Snapshot) -> bool {
    match (original.placement, current.placement) {
        (None, None) => true,
        (Some(before), Some(after)) => {
            let Some(width) = before.normal_rect.width.checked_add(4) else {
                return false;
            };
            after
                == Placement {
                    normal_rect: Rect {
                        width,
                        ..before.normal_rect
                    },
                    ..before
                }
        }
        _ => false,
    }
}

/// Enlarge the window by four physical pixels and restore it once. The caller
/// supplies a work-area bound already associated with the captured monitor.
/// Independently observed concurrent geometry/focus changes prevent restoration
/// from overwriting those changes, but do not make the OS calls atomic with user
/// activity. Errors are uncertain and never trigger another mutation.
pub fn reflow<E>(
    expected: Snapshot,
    work_area: Rect,
    mut observe: impl FnMut() -> Result<Snapshot, E>,
    mut set_rect: impl FnMut(Rect) -> Result<(), E>,
) -> Receipt {
    let mut receipt = Receipt {
        outcome: Outcome::RejectedBeforeMutation,
        original: expected,
        requested: None,
        drag_plan: None,
        last_observed: None,
        mutation_attempts: 0,
        uia_recovery_verified: false,
        original_input_retry_prohibited: true,
    };
    if expected.hwnd == 0
        || expected.pid == 0
        || !expected.foreground
        || !expected.normal
        || expected.rect.width <= 0
        || expected.rect.height <= 0
    {
        return receipt;
    }
    let Some(width) = expected.rect.width.checked_add(4) else {
        return receipt;
    };
    let right = i64::from(expected.rect.x) + i64::from(width);
    let bottom = i64::from(expected.rect.y) + i64::from(expected.rect.height);
    if work_area.width <= 0
        || work_area.height <= 0
        // Avoid edge-snapped and off-work-area windows; changing their size
        // could alter window-manager state even if the rectangle is restored.
        || i64::from(expected.rect.x) < i64::from(work_area.x) + 16
        || i64::from(expected.rect.y) < i64::from(work_area.y) + 16
        || right > i64::from(work_area.x) + i64::from(work_area.width) - 16
        || bottom > i64::from(work_area.y) + i64::from(work_area.height) - 16
    {
        return receipt;
    }
    let Ok(initial) = observe() else {
        return receipt;
    };
    receipt.last_observed = Some(initial);
    if initial != expected {
        return receipt;
    }
    let Some(plan) = drag_plan(expected.rect) else {
        return receipt;
    };
    let expanded = Rect {
        width,
        ..expected.rect
    };
    receipt.requested = Some(expanded);
    receipt.drag_plan = Some(plan);
    receipt.mutation_attempts = 1;
    if set_rect(expanded).is_err() {
        receipt.outcome = Outcome::FirstMutationUncertain;
        receipt.last_observed = observe().ok();
        return receipt;
    }
    let Ok(intermediate) = observe() else {
        receipt.outcome = Outcome::IntermediateChanged;
        receipt.last_observed = None;
        return receipt;
    };
    receipt.last_observed = Some(intermediate);
    if !same_identity_and_active(expected, intermediate)
        || intermediate.rect != expanded
        || !intermediate_placement_matches(expected, intermediate)
    {
        receipt.outcome = Outcome::IntermediateChanged;
        return receipt;
    }
    receipt.mutation_attempts = 2;
    if set_rect(expected.rect).is_err() {
        receipt.outcome = Outcome::RestoreUncertain;
        receipt.last_observed = observe().ok();
        return receipt;
    }
    let Ok(final_state) = observe() else {
        receipt.outcome = Outcome::FinalStateChanged;
        receipt.last_observed = None;
        return receipt;
    };
    receipt.last_observed = Some(final_state);
    receipt.outcome = if same_identity_and_active(expected, final_state)
        && final_state.rect == expected.rect
        && final_state.placement == expected.placement
    {
        Outcome::GeometryRestored
    } else {
        Outcome::FinalStateChanged
    };
    receipt
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    fn initial() -> Snapshot {
        Snapshot {
            hwnd: 1,
            pid: 2,
            rect: Rect {
                x: 100,
                y: 100,
                width: 424,
                height: 602,
            },
            placement: None,
            foreground: true,
            normal: true,
        }
    }
    fn area() -> Rect {
        Rect {
            x: 0,
            y: 0,
            width: 2000,
            height: 1200,
        }
    }

    #[test]
    fn drag_points_are_bounded_and_restore_the_exact_four_pixel_delta() {
        let plan = drag_plan(initial().rect).unwrap();
        assert_eq!(plan.expand_start, Point { x: 517, y: 401 });
        assert_eq!(plan.expand_end, Point { x: 521, y: 401 });
        assert_eq!(plan.restore_start, plan.expand_end);
        assert_eq!(plan.restore_end, plan.expand_start);
        assert_eq!(
            drag_plan(Rect {
                x: i32::MAX,
                ..initial().rect
            }),
            None
        );
        assert_eq!(
            drag_plan(Rect {
                width: 7,
                ..initial().rect
            }),
            None
        );
    }

    #[test]
    fn performs_one_bounded_resize_and_exactly_one_restore() {
        let current = RefCell::new(initial());
        let writes = RefCell::new(Vec::new());
        let result = reflow(
            initial(),
            area(),
            || Ok::<_, ()>(*current.borrow()),
            |r| {
                writes.borrow_mut().push(r);
                current.borrow_mut().rect = r;
                Ok(())
            },
        );
        assert_eq!(result.outcome, Outcome::GeometryRestored);
        assert_eq!(
            *writes.borrow(),
            vec![
                Rect {
                    width: 428,
                    ..initial().rect
                },
                initial().rect
            ]
        );
    }

    #[test]
    fn rejects_stale_identity_geometry_focus_and_out_of_work_area_before_writing() {
        for observed in [
            Snapshot {
                pid: 3,
                ..initial()
            },
            Snapshot {
                rect: Rect {
                    x: 101,
                    ..initial().rect
                },
                ..initial()
            },
            Snapshot {
                foreground: false,
                ..initial()
            },
        ] {
            let mut writes = 0;
            assert_eq!(
                reflow(
                    initial(),
                    area(),
                    || Ok::<_, ()>(observed),
                    |_| {
                        writes += 1;
                        Ok(())
                    }
                )
                .outcome,
                Outcome::RejectedBeforeMutation
            );
            assert_eq!(writes, 0);
        }
        let mut writes = 0;
        assert_eq!(
            reflow(
                initial(),
                Rect {
                    width: 526,
                    ..area()
                },
                || Ok::<_, ()>(initial()),
                |_| {
                    writes += 1;
                    Ok(())
                }
            )
            .outcome,
            Outcome::RejectedBeforeMutation
        );
        assert_eq!(writes, 0);
    }

    #[test]
    fn failure_or_concurrent_change_never_replays_or_overwrites_a_new_state() {
        let mut writes = 0;
        assert_eq!(
            reflow(
                initial(),
                area(),
                || Ok::<_, ()>(initial()),
                |_| {
                    writes += 1;
                    Err(())
                }
            )
            .outcome,
            Outcome::FirstMutationUncertain
        );
        assert_eq!(writes, 1);
        let mut observations = 0;
        let mut writes = 0;
        let result = reflow(
            initial(),
            area(),
            || {
                observations += 1;
                Ok::<_, ()>(if observations == 1 {
                    initial()
                } else {
                    Snapshot {
                        rect: Rect {
                            x: 200,
                            width: 428,
                            ..initial().rect
                        },
                        ..initial()
                    }
                })
            },
            |_| {
                writes += 1;
                Ok(())
            },
        );
        assert_eq!(result.outcome, Outcome::IntermediateChanged);
        assert_eq!(writes, 1);
    }

    #[test]
    fn partial_receipt_retains_last_observation_and_never_authorizes_replay() {
        let changed = Snapshot {
            rect: Rect {
                width: 428,
                ..initial().rect
            },
            ..initial()
        };
        let mut observations = 0;
        let receipt = reflow(
            initial(),
            area(),
            || {
                observations += 1;
                Ok::<_, ()>(if observations == 1 {
                    initial()
                } else {
                    changed
                })
            },
            |_| Err(()),
        );
        assert_eq!(receipt.outcome, Outcome::FirstMutationUncertain);
        assert_eq!(receipt.last_observed, Some(changed));
        assert_eq!(receipt.mutation_attempts, 1);
        let wire = serde_json::to_value(receipt).unwrap();
        assert_eq!(wire["outcome"], "first_mutation_uncertain");
        assert_eq!(wire["original"]["rect"]["width"], 424);
        assert_eq!(wire["lastObserved"]["rect"]["width"], 428);
        assert_eq!(wire["uiaRecoveryVerified"], false);
        assert_eq!(wire["originalInputRetryProhibited"], true);
    }

    #[test]
    fn unsafe_identity_overflow_or_missing_snapshot_never_mutates() {
        let cases = [
            Snapshot {
                hwnd: 0,
                ..initial()
            },
            Snapshot {
                pid: 0,
                ..initial()
            },
            Snapshot {
                rect: Rect {
                    width: i32::MAX,
                    ..initial().rect
                },
                ..initial()
            },
        ];
        for expected in cases {
            let mut writes = 0;
            assert_eq!(
                reflow(
                    expected,
                    area(),
                    || Ok::<_, ()>(expected),
                    |_| {
                        writes += 1;
                        Ok(())
                    }
                )
                .outcome,
                Outcome::RejectedBeforeMutation
            );
            assert_eq!(writes, 0);
        }
        let mut writes = 0;
        assert_eq!(
            reflow(
                initial(),
                area(),
                || Err::<Snapshot, ()>(()),
                |_| {
                    writes += 1;
                    Ok(())
                }
            )
            .outcome,
            Outcome::RejectedBeforeMutation
        );
        assert_eq!(writes, 0);
    }

    #[test]
    fn lost_observation_after_first_write_never_blindly_restores() {
        let mut observations = 0;
        let mut writes = 0;
        let result = reflow(
            initial(),
            area(),
            || {
                observations += 1;
                if observations == 1 {
                    Ok(initial())
                } else {
                    Err(())
                }
            },
            |_| {
                writes += 1;
                Ok(())
            },
        );
        assert_eq!(result.outcome, Outcome::IntermediateChanged);
        assert_eq!(writes, 1);
    }

    #[test]
    fn success_requires_independent_final_geometry_verification() {
        let current = RefCell::new(initial());
        let mut writes = 0;
        let result = reflow(
            initial(),
            area(),
            || Ok::<_, ()>(*current.borrow()),
            |r| {
                writes += 1;
                if writes == 1 {
                    current.borrow_mut().rect = r;
                }
                Ok(())
            },
        );
        assert_eq!(result.outcome, Outcome::FinalStateChanged);
        assert_eq!(writes, 2);
    }

    #[test]
    fn changed_window_placement_is_not_reported_as_restored() {
        let placement = Placement {
            flags: 0,
            show_command: 1,
            normal_rect: initial().rect,
            min_position: Point { x: -1, y: -1 },
            max_position: Point { x: -1, y: -1 },
        };
        let expected = Snapshot {
            placement: Some(placement),
            ..initial()
        };
        let current = RefCell::new(expected);
        let mut writes = 0;
        let receipt = reflow(
            expected,
            area(),
            || Ok::<_, ()>(*current.borrow()),
            |r| {
                writes += 1;
                let mut snapshot = current.borrow_mut();
                snapshot.rect = r;
                snapshot.placement = Some(Placement {
                    flags: if writes == 2 { 1 } else { 0 },
                    normal_rect: r,
                    ..placement
                });
                Ok(())
            },
        );
        assert_eq!(receipt.outcome, Outcome::FinalStateChanged);
        assert_eq!(receipt.mutation_attempts, 2);
        assert_eq!(receipt.last_observed.unwrap().placement.unwrap().flags, 1);
    }

    #[test]
    fn failed_restore_is_reported_without_a_third_write() {
        let current = RefCell::new(initial());
        let mut writes = 0;
        let result = reflow(
            initial(),
            area(),
            || Ok::<_, ()>(*current.borrow()),
            |r| {
                writes += 1;
                if writes == 2 {
                    return Err(());
                }
                current.borrow_mut().rect = r;
                Ok(())
            },
        );
        assert_eq!(result.outcome, Outcome::RestoreUncertain);
        assert_eq!(writes, 2);
    }
}

/// Windows adapter for an explicitly requested recovery. The caller must hold
/// the helper's physical-input mutex for this whole call; this function does not
/// activate a window, invoke a UI element, or replay a preceding operation.
#[cfg(windows)]
pub mod native {
    use super::{drag_plan, reflow, Placement, Point, Rect, Snapshot};
    use crate::error::{ErrorCode, ProtocolError};
    use serde_json::{json, Value};
    use std::{cell::RefCell, mem::size_of};
    use windows::Win32::Foundation::{HWND, LPARAM, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONULL,
    };
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, IsWindowEnabled};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetForegroundWindow, GetGUIThreadInfo, GetWindow, GetWindowLongPtrW,
        GetWindowPlacement, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow,
        IsWindowVisible, IsZoomed, SendMessageTimeoutW, GA_ROOT, GUITHREADINFO, GUI_INMENUMODE,
        GUI_INMOVESIZE, GWL_EXSTYLE, GWL_STYLE, GW_OWNER, HTRIGHT, SMTO_ABORTIFHUNG, SW_SHOWNORMAL,
        WINDOWPLACEMENT, WM_NCHITTEST, WS_EX_DLGMODALFRAME, WS_THICKFRAME,
    };

    fn denied(reason: &'static str) -> ProtocolError {
        ProtocolError::new(reason, ErrorCode::CoordinateBlocked)
    }

    fn rect(r: RECT) -> Option<Rect> {
        Some(Rect {
            x: r.left,
            y: r.top,
            width: r.right.checked_sub(r.left)?,
            height: r.bottom.checked_sub(r.top)?,
        })
    }

    unsafe fn monitor_work_area(hwnd: HWND) -> Result<Rect, ProtocolError> {
        let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL);
        if monitor.is_invalid() {
            return Err(denied("Recovery window has no current monitor"));
        }
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err(denied("Recovery monitor bounds unavailable"));
        }
        rect(info.rcWork).ok_or_else(|| denied("Recovery monitor bounds invalid"))
    }

    unsafe fn observe(
        hwnd: HWND,
        expected_pid: u64,
        area: Rect,
    ) -> Result<Snapshot, ProtocolError> {
        let mut pid = 0u32;
        let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if tid == 0
            || u64::from(pid) != expected_pid
            || !IsWindow(hwnd).as_bool()
            || GetAncestor(hwnd, GA_ROOT) != hwnd
            || !IsWindowVisible(hwnd).as_bool()
            || !IsWindowEnabled(hwnd).as_bool()
            || IsIconic(hwnd).as_bool()
            || IsZoomed(hwnd).as_bool()
            || GetForegroundWindow() != hwnd
        {
            return Err(denied(
                "Recovery requires the exact visible, enabled, normal foreground window",
            ));
        }
        if GetWindow(hwnd, GW_OWNER).is_ok_and(|owner| !owner.0.is_null())
            || (GetWindowLongPtrW(hwnd, GWL_EXSTYLE) as u32 & WS_EX_DLGMODALFRAME.0) != 0
            || (GetWindowLongPtrW(hwnd, GWL_STYLE) as u32 & WS_THICKFRAME.0) == 0
        {
            return Err(denied(
                "Recovery requires an unowned resizable non-dialog window",
            ));
        }
        let mut gui = GUITHREADINFO {
            cbSize: size_of::<GUITHREADINFO>() as u32,
            ..Default::default()
        };
        if GetGUIThreadInfo(tid, &mut gui).is_err()
            || !gui.hwndCapture.0.is_null()
            || !gui.hwndMenuOwner.0.is_null()
            || !gui.hwndMoveSize.0.is_null()
            || (gui.flags.0 & (GUI_INMOVESIZE.0 | GUI_INMENUMODE.0)) != 0
            || (1..=6).any(|key| GetAsyncKeyState(key) < 0)
        {
            return Err(denied(
                "Recovery requires no active pointer, capture, menu or move/size",
            ));
        }
        if monitor_work_area(hwnd)? != area {
            return Err(denied("Recovery monitor changed"));
        }
        let mut bounds = RECT::default();
        GetWindowRect(hwnd, &mut bounds)
            .map_err(|_| denied("Recovery window bounds unavailable"))?;
        let mut wp = WINDOWPLACEMENT {
            length: size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        GetWindowPlacement(hwnd, &mut wp)
            .map_err(|_| denied("Recovery window placement unavailable"))?;
        if wp.showCmd != SW_SHOWNORMAL.0 as u32 {
            return Err(denied("Recovery window is not in normal state"));
        }
        Ok(Snapshot {
            hwnd: hwnd.0 as isize,
            pid: expected_pid,
            rect: rect(bounds).ok_or_else(|| denied("Recovery window bounds invalid"))?,
            placement: Some(Placement {
                flags: wp.flags.0,
                show_command: wp.showCmd,
                normal_rect: rect(wp.rcNormalPosition)
                    .ok_or_else(|| denied("Recovery placement invalid"))?,
                min_position: Point {
                    x: wp.ptMinPosition.x,
                    y: wp.ptMinPosition.y,
                },
                max_position: Point {
                    x: wp.ptMaxPosition.x,
                    y: wp.ptMaxPosition.y,
                },
            }),
            foreground: true,
            normal: true,
        })
    }

    unsafe fn require_right_edge(hwnd: HWND, pid: u64, p: Point) -> Result<(), ProtocolError> {
        let x =
            i16::try_from(p.x).map_err(|_| denied("Recovery point cannot be encoded safely"))?;
        let y =
            i16::try_from(p.y).map_err(|_| denied("Recovery point cannot be encoded safely"))?;
        crate::window::require_pointer_target(hwnd.0 as isize, pid, p.x, p.y)?;
        let packed = (u32::from(x as u16) | (u32::from(y as u16) << 16)) as i32 as isize;
        let mut hit = 0usize;
        let sent = SendMessageTimeoutW(
            hwnd,
            WM_NCHITTEST,
            WPARAM(0),
            LPARAM(packed),
            SMTO_ABORTIFHUNG,
            500,
            Some(&mut hit),
        );
        if sent.0 == 0 || hit != HTRIGHT as usize {
            return Err(denied(
                "Recovery point is not the exact right resize border",
            ));
        }
        Ok(())
    }

    /// `captured` must come from an unexpired, image-backed look of this root.
    /// Returned receipt is explicitly not evidence that UIA or prior input worked.
    pub fn execute(hwnd: isize, pid: u64, captured: Rect) -> Result<Value, ProtocolError> {
        let hwnd = HWND(hwnd as *mut _);
        let area = unsafe { monitor_work_area(hwnd)? };
        let expected = unsafe { observe(hwnd, pid, area)? };
        if expected.rect != captured {
            return Err(denied("Recovery window moved or resized since capture"));
        }
        let plan =
            drag_plan(expected.rect).ok_or_else(|| denied("Recovery geometry is not safe"))?;
        let attempts = RefCell::new(Vec::<Value>::new());
        let result = reflow(
            expected,
            area,
            || unsafe { observe(hwnd, pid, area) },
            |wanted| {
                let expanding = wanted.width > expected.rect.width;
                let (start, end, prior_rect) = if expanding {
                    (plan.expand_start, plan.expand_end, expected.rect)
                } else {
                    (
                        plan.restore_start,
                        plan.restore_end,
                        Rect {
                            width: expected.rect.width + 4,
                            ..expected.rect
                        },
                    )
                };
                let current = unsafe { observe(hwnd, pid, area)? };
                if current.rect != prior_rect {
                    return Err(denied("Recovery geometry changed before gesture"));
                }
                unsafe {
                    require_right_edge(hwnd, pid, start)?;
                    require_right_edge(hwnd, pid, end)?;
                }
                let current = unsafe { observe(hwnd, pid, area)? };
                if current.rect != prior_rect {
                    return Err(denied(
                        "Recovery geometry changed during border verification",
                    ));
                }
                crate::action_trace::phase(if expanding {
                    "reflow_expand_started"
                } else {
                    "reflow_restore_started"
                });
                let args = json!({
                    "lookId":"explicit-reflow", "action":"drag", "policy":"foreground",
                    "target":{"x":start.x,"y":start.y}, "params":{},
                    "resolvedPoint":{"x":start.x,"y":start.y},
                    "resolvedPath":[{"x":start.x,"y":start.y},{"x":end.x,"y":end.y}],
                    "pointerGuard":{"hwnd":hwnd.0 as isize,"pid":pid}
                });
                match crate::input::act(&args) {
                    Ok(step) => {
                        let partial = step.get("error").is_some()
                            || step["inputDispatch"]["recoveryRequired"] == true;
                        attempts.borrow_mut().push(step);
                        if partial {
                            Err(denied(
                                "Recovery drag was partial; inspect receipt and do not retry",
                            ))
                        } else {
                            Ok(())
                        }
                    }
                    Err(error) => {
                        attempts.borrow_mut().push(json!({"error":{"code":error.code.to_string(),"message":error.message}}));
                        Err(error)
                    }
                }
            },
        );
        let completion = match result.outcome {
            super::Outcome::RejectedBeforeMutation => "not_sent",
            super::Outcome::GeometryRestored => "returned",
            _ => "partial_or_unknown",
        };
        Ok(
            json!({"operation":"window_reflow", "dispatchCompletion":completion, "receipt":result, "steps":attempts.into_inner()}),
        )
    }
}
