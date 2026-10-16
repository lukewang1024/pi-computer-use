use serde_json::{json, Value};

use crate::error::{ErrorCode, ProtocolError};

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq)]
enum DragEvent {
    Move(i32, i32),
    LeftDown,
    LeftUp(i32, i32),
}

// Absolute SendInput coordinates cover the entire virtual desktop. Validate
// every point before constructing a gesture, including monitors left/above zero.
#[cfg(any(windows, test))]
fn drag_events(points: &[(i32, i32)], desktop: (i32, i32, i32, i32)) -> Option<Vec<DragEvent>> {
    fn axis(value: i32, origin: i32, span: i32) -> Option<i32> {
        let offset = i64::from(value) - i64::from(origin);
        if span <= 0 || offset < 0 || offset >= i64::from(span) {
            return None;
        }
        Some(if span == 1 {
            0
        } else {
            (offset * 65_535 / i64::from(span - 1)) as i32
        })
    }
    if points.len() < 2 || points.len() > 600 {
        return None;
    }
    let mut moves = Vec::with_capacity(points.len());
    for &(x, y) in points {
        moves.push(DragEvent::Move(
            axis(x, desktop.0, desktop.2)?,
            axis(y, desktop.1, desktop.3)?,
        ));
    }
    let &(last_x, last_y) = points.last()?;
    let release = DragEvent::LeftUp(
        axis(last_x, desktop.0, desktop.2)?,
        axis(last_y, desktop.1, desktop.3)?,
    );
    let mut events = Vec::with_capacity(points.len() + 2);
    let mut moves = moves.into_iter();
    events.push(moves.next()?);
    events.push(DragEvent::LeftDown);
    events.extend(moves);
    events.push(release);
    Some(events)
}

#[cfg(any(windows, test))]
#[derive(Debug)]
struct DragFailure<E> {
    error: E,
    events_sent: usize,
    left_down: bool,
}

// Emit one guarded event at a time. Apps must be able to consume the mouse-down
// and motion messages before release; queuing the entire gesture is insufficient.
#[cfg(any(windows, test))]
fn dispatch_drag<E>(
    events: &[DragEvent],
    mut emit: impl FnMut(&DragEvent) -> Result<(), E>,
    mut settle: impl FnMut(bool),
) -> Result<usize, DragFailure<E>> {
    let mut left_down = false;
    for (sent, event) in events.iter().enumerate() {
        if let Err(error) = emit(event) {
            return Err(DragFailure {
                error,
                events_sent: sent,
                left_down,
            });
        }
        match event {
            DragEvent::LeftDown => left_down = true,
            DragEvent::LeftUp(..) => left_down = false,
            DragEvent::Move(..) => {}
        }
        if !matches!(event, DragEvent::LeftUp(..)) {
            settle(matches!(events.get(sent + 1), Some(DragEvent::LeftUp(..))));
        }
    }
    Ok(events.len())
}

#[cfg(any(windows, test))]
#[derive(Debug, PartialEq)]
enum TextKey {
    Unicode(u16),
    Return,
}

// Office's native slide editor ignores Unicode packets containing CR or LF.
// Normalize all three newline encodings to one Return key, retaining ordinary
// UTF-16 units (including surrogate pairs) and consecutive empty paragraphs.
#[cfg(any(windows, test))]
fn text_keys(text: &str) -> Vec<TextKey> {
    let mut units = text.encode_utf16().peekable();
    let mut keys = Vec::new();
    while let Some(unit) = units.next() {
        if unit == 0x0d && units.peek() == Some(&0x0a) {
            units.next();
        }
        keys.push(match unit {
            0x0a | 0x0d => TextKey::Return,
            unit => TextKey::Unicode(unit),
        });
    }
    keys
}

// ASCII punctuation values are not Windows virtual-key codes: '.' is VK_DELETE.
// Only letters, digits and space have a layout-independent identity mapping.
#[cfg(any(windows, test))]
fn character_virtual_key(name: &str) -> Option<u16> {
    let bytes = name.as_bytes();
    if bytes.len() == 1 && (bytes[0].is_ascii_alphanumeric() || bytes[0] == b' ') {
        Some(bytes[0].to_ascii_uppercase() as u16)
    } else {
        None
    }
}

// Dedicated navigation keys must not be synthesized as their numeric-keypad
// equivalents: Shift+Home otherwise moves the caret without extending selection.
#[cfg(any(windows, test))]
fn extended_virtual_key(vk: u16) -> bool {
    matches!(vk, 0x21..=0x28 | 0x2d | 0x2e | 0x5b | 0x5c)
}

#[cfg(any(windows, test))]
fn key_names(keys: &[Value]) -> Result<Vec<&str>, ProtocolError> {
    if keys.is_empty() {
        return Err(invalid("keypress requires at least one key"));
    }
    keys.iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| invalid("keypress keys must be strings"))
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub enum ActTarget {
    Ref(String),
    Point { x: f64, y: f64 },
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedActRequest {
    pub look_id: String,
    pub pid: Option<u64>,
    pub action: String,
    pub policy: String,
    pub target: ActTarget,
    pub params: Value,
}

pub fn parse_act_request(args: &Value) -> Result<ParsedActRequest, ProtocolError> {
    let look_id = args
        .get("lookId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("act requires lookId"))?
        .to_owned();
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("act requires action"))?
        .to_owned();
    let policy = args
        .get("policy")
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_owned();
    let target_value = args
        .get("target")
        .ok_or_else(|| invalid("act requires target"))?;
    let target = if let Some(reference) = target_value.get("ref").and_then(Value::as_str) {
        ActTarget::Ref(reference.to_owned())
    } else if let (Some(x), Some(y)) = (
        target_value.get("x").and_then(Value::as_f64),
        target_value.get("y").and_then(Value::as_f64),
    ) {
        ActTarget::Point { x, y }
    } else {
        return Err(invalid("act target must include ref or x/y"));
    };
    Ok(ParsedActRequest {
        look_id,
        pid: args.get("pid").and_then(Value::as_u64),
        action,
        policy,
        target,
        params: args.get("params").cloned().unwrap_or_else(|| json!({})),
    })
}

pub fn policy_allows_raw_input(request: &ParsedActRequest) -> Result<(), ProtocolError> {
    if request.policy != "foreground" {
        Err(ProtocolError::new(
            "Background policy blocks global Windows coordinate/raw input grounding",
            if request.policy == "ax_only" {
                ErrorCode::CoordinateBlocked
            } else {
                ErrorCode::ForegroundRequired
            },
        ))
    } else {
        Ok(())
    }
}

pub fn response_with_delta(mut response: Value, source: &str, delta: Vec<Value>) -> Value {
    if !response
        .get("performed")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        response["performed"] = json!({});
    }
    response["performed"]["deltaSource"] = json!(source);
    if !delta.is_empty() {
        response["rootDelta"] = Value::Array(delta);
    }
    response
}

pub fn open_browser_location(url: &str) -> Result<(), ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = url;
        Ok(())
    }
    #[cfg(windows)]
    {
        native::open_browser_location(url)
    }
}

pub fn act(args: &Value) -> Result<Value, ProtocolError> {
    let request = parse_act_request(args)?;
    let grounding = args
        .get("resolvedPoint")
        .map(|_| "coordinates")
        .unwrap_or("description");

    if matches!(
        request.action.as_str(),
        "typeText" | "keypress" | "drag" | "moveMouse"
    ) {
        policy_allows_raw_input(&request)?;
    }
    if grounding == "coordinates" {
        policy_allows_raw_input(&request)?;
    }

    #[cfg(not(windows))]
    {
        Ok(json!({
            "outcome": "unknown",
            "performed": { "grounding": grounding, "delivery": if grounding == "description" { "ax" } else { "hid" } },
            "evidence": { "platform": "non-windows-test-stub" }
        }))
    }

    #[cfg(windows)]
    {
        native::act(&request, args, grounding)
    }
}

fn invalid(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(message.into(), ErrorCode::InvalidRequest)
}

#[cfg(windows)]
mod native {
    use super::*;
    use crate::pointer_motion::PointerMotion;
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetCursorPos, GetSystemMetrics, SetCursorPos, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN,
        SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
    };

    pub fn open_browser_location(url: &str) -> Result<(), ProtocolError> {
        hotkey(&[VK_CONTROL], VK_L)?;
        send_text(url)?;
        send(&[key(VK_RETURN, false), key(VK_RETURN, true)])
    }

    pub fn act(
        request: &ParsedActRequest,
        args: &Value,
        grounding: &str,
    ) -> Result<Value, ProtocolError> {
        let point = args.get("resolvedPoint").and_then(point_value);
        match request.action.as_str() {
            "press" | "click" => {
                let (x, y) = point.ok_or_else(|| invalid("click requires resolvedPoint"))?;
                click(
                    x,
                    y,
                    args,
                    request
                        .params
                        .get("button")
                        .and_then(Value::as_str)
                        .unwrap_or("left"),
                )?;
                ok("unknown", grounding, "hid")
            }
            "moveMouse" => {
                let (x, y) = point.ok_or_else(|| invalid("moveMouse requires resolvedPoint"))?;
                let duration = match request.params.get("durationMs") {
                    None => 350,
                    Some(v) => v.as_u64().filter(|n| *n <= 30_000).ok_or_else(|| {
                        invalid("durationMs must be an integer between 0 and 30000")
                    })?,
                };
                let mut cursor = POINT::default();
                unsafe { GetCursorPos(&mut cursor) }.map_err(input_failed)?;
                let mut points = if let Some(raw) = args.get("resolvedPath") {
                    raw.as_array()
                        .ok_or_else(|| invalid("resolvedPath must be an array"))?
                        .iter()
                        .map(point_value_required)
                        .collect::<Result<Vec<_>, _>>()?
                } else {
                    let start = if guard_point(args, cursor.x, cursor.y).is_ok() {
                        (cursor.x, cursor.y)
                    } else {
                        (x, y)
                    };
                    vec![start, (x, y)]
                };
                if points.last() != Some(&(x, y)) {
                    points.push((x, y));
                }
                let motion = PointerMotion::new(points.clone(), duration).map_err(invalid)?;
                for &(px, py) in &points {
                    guard_point(args, px, py)?;
                }
                match motion.run(|px, py| {
                    guard_point(args, px, py)?;
                    unsafe { SetCursorPos(px, py) }.map_err(input_failed)
                }) {
                    Ok(report) => Ok(
                        json!({"outcome":"unknown","performed":{"grounding":"coordinates","delivery":"hid","pointerMotion":{"durationMs":duration,"elapsedMs":report.elapsed_ms,"samples":report.samples,"cursorBefore":{"x":cursor.x,"y":cursor.y},"endpoint":{"x":x,"y":y}}}}),
                    ),
                    Err(failure) if failure.samples == 0 => Err(failure.error),
                    Err(failure) => Ok(
                        json!({"outcome":"unknown","performed":{"grounding":"coordinates","delivery":"hid"},"error":{"code":"foreground_interrupted_after_partial_hid","message":failure.error.message},"inputDispatch":{"eventsDispatched":failure.samples,"recoveryRequired":true,"unreleasedKeys":[],"unreleasedMouseButtons":[]}}),
                    ),
                }
            }
            "drag" => {
                let path = args
                    .get("resolvedPath")
                    .and_then(Value::as_array)
                    .ok_or_else(|| invalid("drag requires resolvedPath"))?;
                let points = path
                    .iter()
                    .map(point_value_required)
                    .collect::<Result<Vec<_>, _>>()?;
                drag(&points, args)
            }
            "scroll" => {
                let (x, y) = point.ok_or_else(|| invalid("scroll requires resolvedPoint"))?;
                let dy = request
                    .params
                    .get("scrollY")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                let dx = request
                    .params
                    .get("scrollX")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                scroll(x, y, dx, dy, args)?;
                ok("unknown", grounding, "hid")
            }
            "typeText" => {
                send_text(
                    request
                        .params
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                )?;
                ok("unknown", "coordinates", "hid")
            }
            "setText" => {
                if let Some((x, y)) = point {
                    click(x, y, args, "left")?;
                }
                hotkey(&[VK_CONTROL], VK_A)?;
                let text = request
                    .params
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                send_text(text)?;
                Ok(
                    json!({ "outcome": "unknown", "performed": { "grounding": grounding, "delivery": "hid" }, "evidence": { "value": text } }),
                )
            }
            "keypress" => {
                let keys = request
                    .params
                    .get("keys")
                    .and_then(Value::as_array)
                    .ok_or_else(|| invalid("keypress requires keys"))?;
                send_keys(keys)?;
                ok("unknown", "coordinates", "hid")
            }
            other => Err(ProtocolError::new(
                format!("Unsupported Windows action '{other}'"),
                ErrorCode::UnsupportedCommand,
            )),
        }
    }

    fn ok(outcome: &str, grounding: &str, delivery: &str) -> Result<Value, ProtocolError> {
        Ok(
            json!({ "outcome": outcome, "performed": { "grounding": grounding, "delivery": delivery } }),
        )
    }

    fn input_failed(error: impl std::fmt::Display) -> ProtocolError {
        ProtocolError::new(format!("Input failed: {error}"), ErrorCode::CaptureFailed)
    }

    fn point_value(value: &Value) -> Option<(i32, i32)> {
        Some((
            value.get("x")?.as_f64()?.round() as i32,
            value.get("y")?.as_f64()?.round() as i32,
        ))
    }

    fn point_value_required(value: &Value) -> Result<(i32, i32), ProtocolError> {
        point_value(value).ok_or_else(|| invalid("point requires x and y"))
    }

    fn send(inputs: &[INPUT]) -> Result<(), ProtocolError> {
        let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
        if sent == inputs.len() as u32 {
            Ok(())
        } else {
            Err(input_failed(format!(
                "SendInput inserted {sent}/{} events",
                inputs.len()
            )))
        }
    }

    fn mouse(flags: MOUSE_EVENT_FLAGS, data: u32) -> INPUT {
        INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dwFlags: flags,
                    mouseData: data,
                    ..Default::default()
                },
            },
        }
    }

    fn key(vk: VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    dwFlags: (if up {
                        KEYEVENTF_KEYUP
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    }) | (if extended_virtual_key(vk.0) {
                        KEYEVENTF_EXTENDEDKEY
                    } else {
                        KEYBD_EVENT_FLAGS(0)
                    }),
                    ..Default::default()
                },
            },
        }
    }

    fn unicode(ch: u16, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wScan: ch,
                    dwFlags: KEYEVENTF_UNICODE
                        | if up {
                            KEYEVENTF_KEYUP
                        } else {
                            KEYBD_EVENT_FLAGS(0)
                        },
                    ..Default::default()
                },
            },
        }
    }

    fn guard_point(args: &Value, x: i32, y: i32) -> Result<(), ProtocolError> {
        let hwnd = args["pointerGuard"]["hwnd"]
            .as_i64()
            .ok_or_else(|| invalid("Pointer input requires an observed HWND guard"))?;
        let pid = args["pointerGuard"]["pid"]
            .as_u64()
            .ok_or_else(|| invalid("Pointer input requires an observed PID guard"))?;
        crate::window::require_pointer_target(hwnd as isize, pid, x, y)
    }

    fn click(x: i32, y: i32, args: &Value, button: &str) -> Result<(), ProtocolError> {
        guard_point(args, x, y)?;
        unsafe { SetCursorPos(x, y) }.map_err(input_failed)?;
        guard_point(args, x, y)?;
        let (down, up) = match button {
            "right" => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
            "middle" => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
            _ => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        };
        send(&[mouse(down, 0), mouse(up, 0)])
    }

    fn drag(points: &[(i32, i32)], args: &Value) -> Result<Value, ProtocolError> {
        if points.len() < 2 {
            return Err(invalid("drag requires at least two points"));
        }
        for &(x, y) in points {
            guard_point(args, x, y)?;
        }
        let desktop = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        let events = drag_events(points, desktop)
            .ok_or_else(|| invalid("Drag path is outside the current virtual desktop"))?;
        let started = std::time::Instant::now();
        let mut move_index = 0;
        let result = dispatch_drag(
            &events,
            |event| {
                let point = match event {
                    DragEvent::Move(..) => {
                        let p = points[move_index];
                        move_index += 1;
                        p
                    }
                    DragEvent::LeftDown => points[0],
                    DragEvent::LeftUp(..) => *points.last().unwrap(),
                };
                guard_point(args, point.0, point.1)?;
                let input = match *event {
                    DragEvent::Move(x, y) | DragEvent::LeftUp(x, y) => INPUT {
                        r#type: INPUT_MOUSE,
                        Anonymous: INPUT_0 {
                            mi: MOUSEINPUT {
                                dx: x,
                                dy: y,
                                dwFlags: MOUSEEVENTF_MOVE
                                    | MOUSEEVENTF_ABSOLUTE
                                    | MOUSEEVENTF_VIRTUALDESK
                                    | MOUSEEVENTF_MOVE_NOCOALESCE
                                    | if matches!(event, DragEvent::LeftUp(..)) {
                                        MOUSEEVENTF_LEFTUP
                                    } else {
                                        MOUSE_EVENT_FLAGS(0)
                                    },
                                ..Default::default()
                            },
                        },
                    },
                    DragEvent::LeftDown => mouse(MOUSEEVENTF_LEFTDOWN, 0),
                };
                // A single-event SendInput is either inserted or not inserted;
                // the interpreter therefore retains the exact sent-event count.
                send(&[input])
            },
            |before_release| {
                // Let the application consume the final move while the button
                // is still held, before it sees the release/global up state.
                std::thread::sleep(std::time::Duration::from_millis(if before_release {
                    150
                } else {
                    16
                }));
            },
        );
        match result {
            Ok(sent) => {
                // Let queued release/input messages settle before a caller
                // observes/captures the app; this sends no further input.
                std::thread::sleep(std::time::Duration::from_millis(150));
                let mut cursor = POINT::default();
                let cursor_after = unsafe { GetCursorPos(&mut cursor) }
                    .is_ok()
                    .then(|| json!({"x":cursor.x,"y":cursor.y}));
                Ok(
                    json!({"outcome":"unknown","performed":{"grounding":"coordinates","delivery":"hid","drag":{"points":points.len(),"eventsDispatched":sent,"stepDwellMs":16,"releaseDwellMs":150,"postReleaseSettleMs":150,"leftDownAfter":unsafe {GetAsyncKeyState(1)} < 0,"elapsedMs":started.elapsed().as_millis(),"endpoint":points.last(),"cursorAfter":cursor_after}}}),
                )
            }
            Err(failure) if failure.events_sent == 0 => Err(failure.error),
            Err(failure) => Ok(json!({
                "outcome":"unknown",
                "performed":{"grounding":"coordinates","delivery":"hid"},
                "error":{"code":"foreground_interrupted_after_partial_hid","message":failure.error.message},
                "inputDispatch":{"eventsDispatched":failure.events_sent,"recoveryRequired":true,"retrySafe":false,"unreleasedKeys":[],"unreleasedMouseButtons":if failure.left_down {vec![1]} else {vec![]}}
            })),
        }
    }

    fn scroll(x: i32, y: i32, dx: f64, dy: f64, args: &Value) -> Result<(), ProtocolError> {
        guard_point(args, x, y)?;
        unsafe { SetCursorPos(x, y) }.map_err(input_failed)?;
        guard_point(args, x, y)?;
        let mut inputs = Vec::new();
        if dy != 0.0 {
            inputs.push(mouse(
                MOUSEEVENTF_WHEEL,
                (-dy * 120.0).round() as i32 as u32,
            ));
        }
        if dx != 0.0 {
            inputs.push(mouse(
                MOUSEEVENTF_HWHEEL,
                (dx * 120.0).round() as i32 as u32,
            ));
        }
        if inputs.is_empty() {
            return Ok(());
        }
        send(&inputs)
    }

    fn send_text(text: &str) -> Result<(), ProtocolError> {
        let mut inputs = Vec::new();
        for text_key in text_keys(text) {
            match text_key {
                TextKey::Unicode(unit) => {
                    inputs.push(unicode(unit, false));
                    inputs.push(unicode(unit, true));
                }
                TextKey::Return => {
                    inputs.push(key(VK_RETURN, false));
                    inputs.push(key(VK_RETURN, true));
                }
            }
        }
        send(&inputs)
    }

    fn send_keys(keys: &[Value]) -> Result<(), ProtocolError> {
        let names = key_names(keys)?;
        let vks = names
            .iter()
            .map(|name| vk_for(name).ok_or_else(|| invalid(format!("Unsupported key '{name}'"))))
            .collect::<Result<Vec<_>, _>>()?;
        for vk in &vks[..vks.len().saturating_sub(1)] {
            send(&[key(*vk, false)])?;
        }
        if let Some(last) = vks.last() {
            send(&[key(*last, false), key(*last, true)])?;
        }
        for vk in vks[..vks.len().saturating_sub(1)].iter().rev() {
            send(&[key(*vk, true)])?;
        }
        Ok(())
    }

    fn hotkey(mods: &[VIRTUAL_KEY], key_vk: VIRTUAL_KEY) -> Result<(), ProtocolError> {
        for vk in mods {
            send(&[key(*vk, false)])?;
        }
        send(&[key(key_vk, false), key(key_vk, true)])?;
        for vk in mods.iter().rev() {
            send(&[key(*vk, true)])?;
        }
        Ok(())
    }

    #[cfg(test)]
    mod key_guard_tests {
        use super::*;

        #[test]
        fn rejects_punctuation_after_modifier_before_any_key_is_sent() {
            assert!(vk_for(".").is_none());
            assert!(send_keys(&[json!("Ctrl"), json!(".")]).is_err());
        }

        #[test]
        fn rejects_malformed_modifier_chord_before_any_key_is_sent() {
            assert!(send_keys(&[json!("Ctrl"), json!(42), json!("s")]).is_err());
        }
    }

    fn vk_for(name: &str) -> Option<VIRTUAL_KEY> {
        match name.to_ascii_lowercase().as_str() {
            "enter" | "return" => Some(VK_RETURN),
            "escape" | "esc" => Some(VK_ESCAPE),
            "tab" => Some(VK_TAB),
            "backspace" => Some(VK_BACK),
            "delete" => Some(VK_DELETE),
            "space" => Some(VK_SPACE),
            "left" | "arrowleft" => Some(VK_LEFT),
            "right" | "arrowright" => Some(VK_RIGHT),
            "up" | "arrowup" => Some(VK_UP),
            "down" | "arrowdown" => Some(VK_DOWN),
            "home" => Some(VK_HOME),
            "end" => Some(VK_END),
            "pageup" => Some(VK_PRIOR),
            "pagedown" => Some(VK_NEXT),
            "ctrl" | "control" => Some(VK_CONTROL),
            "shift" => Some(VK_SHIFT),
            "alt" | "option" => Some(VK_MENU),
            "cmd" | "win" | "meta" => Some(VK_LWIN),
            key if key.len() == 1 => character_virtual_key(key).map(VIRTUAL_KEY),
            key if key.starts_with('f') => key[1..]
                .parse::<u16>()
                .ok()
                .filter(|n| (1..=24).contains(n))
                .map(|n| VIRTUAL_KEY(VK_F1.0 + n - 1)),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drag_queues_path_between_one_down_and_one_up() {
        use DragEvent::{LeftDown, LeftUp, Move};
        assert_eq!(
            drag_events(&[(0, 0), (50, 25), (100, 50)], (0, 0, 101, 51)),
            Some(vec![
                Move(0, 0),
                LeftDown,
                Move(32767, 32767),
                Move(65535, 65535),
                LeftUp(65535, 65535),
            ])
        );
    }

    #[test]
    fn absolute_drag_supports_negative_monitor_origins_and_edge_pixels() {
        use DragEvent::{LeftDown, LeftUp, Move};
        assert_eq!(
            drag_events(&[(-1920, -1080), (1919, 1079)], (-1920, -1080, 3840, 2160)),
            Some(vec![
                Move(0, 0),
                LeftDown,
                Move(65535, 65535),
                LeftUp(65535, 65535)
            ])
        );
        assert!(drag_events(&[(0, 0), (1, 1)], (0, 0, 2, 2)).is_some());
    }

    #[test]
    fn invalid_drag_geometry_has_no_partial_input_plan() {
        for points in [vec![], vec![(0, 0)], vec![(0, 0), (100, 100)]] {
            assert_eq!(drag_events(&points, (0, 0, 100, 100)), None);
        }
        assert_eq!(drag_events(&[(0, 0), (1, 1)], (0, 0, 0, 100)), None);
        assert_eq!(drag_events(&[(0, 0), (-1, 1)], (0, 0, 100, 100)), None);
    }

    #[test]
    fn drag_interruption_reports_held_button_and_never_sends_release_to_new_target() {
        let events = drag_events(&[(0, 0), (50, 25), (100, 50)], (0, 0, 101, 51)).unwrap();
        let mut sent = vec![];
        let mut waits = 0;
        let failure = dispatch_drag(
            &events,
            |event| {
                if sent.len() == 3 {
                    return Err("target changed");
                }
                sent.push(*event);
                Ok(())
            },
            |_| waits += 1,
        )
        .unwrap_err();
        assert_eq!(failure.error, "target changed");
        assert_eq!(failure.events_sent, 3);
        assert!(failure.left_down);
        assert_eq!(waits, 3);
        assert!(!sent.iter().any(|e| matches!(e, DragEvent::LeftUp(..))));
    }

    #[test]
    fn paced_drag_finishes_once_and_initial_rejection_never_presses_a_button() {
        let events = drag_events(&[(0, 0), (100, 50)], (0, 0, 101, 51)).unwrap();
        let mut sent = vec![];
        let mut waits = vec![];
        let count = dispatch_drag(
            &events,
            |e| {
                sent.push(*e);
                Ok::<_, ()>(())
            },
            |before_release| waits.push(before_release),
        )
        .unwrap();
        assert_eq!(sent, events);
        assert_eq!(count, 4);
        assert_eq!(waits, vec![false, false, true]);
        let failure = dispatch_drag(
            &events,
            |_| Err("stale"),
            |_| panic!("no wait after failed preflight"),
        )
        .unwrap_err();
        assert_eq!(failure.events_sent, 0);
        assert!(!failure.left_down);
        assert!(drag_events(&vec![(0, 0); 601], (0, 0, 101, 51)).is_none());
    }

    #[test]
    fn native_text_newlines_use_one_return_per_logical_break() {
        use TextKey::{Return, Unicode};
        for text in ["A\nB", "A\rB", "A\r\nB"] {
            assert_eq!(text_keys(text), vec![Unicode(65), Return, Unicode(66)]);
        }
        assert_eq!(text_keys("\n\r\n\r"), vec![Return, Return, Return]);
        assert_eq!(text_keys(""), vec![]);
    }

    #[test]
    fn native_text_keeps_unicode_pairs_tabs_and_literal_punctuation() {
        let text = "中🙂\t.Delete";
        assert_eq!(
            text_keys(text),
            text.encode_utf16()
                .map(TextKey::Unicode)
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn navigation_keys_keep_their_dedicated_keyboard_identity() {
        for vk in [
            0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2d, 0x2e, 0x5b, 0x5c,
        ] {
            assert!(extended_virtual_key(vk));
        }
        for vk in [0x08, 0x09, 0x0d, 0x10, 0x11, 0x12, 0x20, 0x41, 0x61, 0x70] {
            assert!(!extended_virtual_key(vk));
        }
    }

    #[test]
    fn malformed_key_list_is_rejected_as_a_whole() {
        for keys in [
            json!([]),
            json!(["Ctrl", 42, "s"]),
            json!(["a", null]),
            json!([false]),
        ] {
            assert!(key_names(keys.as_array().unwrap()).is_err());
        }
        let keys = json!(["Ctrl", "s"]);
        assert_eq!(
            key_names(keys.as_array().unwrap()).unwrap(),
            vec!["Ctrl", "s"]
        );
    }

    #[test]
    fn character_keys_never_alias_ascii_punctuation_to_control_keys() {
        assert_eq!(character_virtual_key("."), None); // ASCII 46 is VK_DELETE.
        for byte in 0..=127u8 {
            let name = (byte as char).to_string();
            let expected = if byte.is_ascii_alphanumeric() || byte == b' ' {
                Some(byte.to_ascii_uppercase() as u16)
            } else {
                None
            };
            assert_eq!(character_virtual_key(&name), expected, "ASCII {byte}");
        }
        for name in ["", "é", "中", "Enter", "ab"] {
            assert_eq!(character_virtual_key(name), None);
        }
    }

    #[test]
    fn parses_discriminated_click_request() {
        let parsed = parse_act_request(&json!({"lookId":"look_1","action":"click","policy":"default","target":{"ref":"@e1"},"params":{"button":"left"}})).unwrap();
        assert_eq!(parsed.action, "click");
        assert_eq!(parsed.target, ActTarget::Ref("@e1".to_owned()));
    }

    #[test]
    fn non_foreground_policies_block_raw_input() {
        let parsed = parse_act_request(&json!({"lookId":"look_1","action":"typeText","policy":"ax_only","target":{"ref":"@e1"},"params":{"text":"x"}})).unwrap();
        let err = policy_allows_raw_input(&parsed).unwrap_err();
        assert_eq!(err.code, ErrorCode::CoordinateBlocked);
        let background = parse_act_request(&json!({"lookId":"look_1","action":"click","policy":"background","target":{"x":1,"y":1},"params":{}})).unwrap();
        assert_eq!(
            policy_allows_raw_input(&background).unwrap_err().code,
            ErrorCode::ForegroundRequired
        );
        let default_policy = parse_act_request(&json!({"lookId":"look_1","action":"click","policy":"default","target":{"x":1,"y":1},"params":{}})).unwrap();
        assert_eq!(
            policy_allows_raw_input(&default_policy).unwrap_err().code,
            ErrorCode::ForegroundRequired
        );
        let foreground = parse_act_request(&json!({"lookId":"look_1","action":"click","policy":"foreground","target":{"x":1,"y":1},"params":{}})).unwrap();
        assert!(policy_allows_raw_input(&foreground).is_ok());
    }

    #[test]
    fn attaches_delta_source_and_delta() {
        let out = response_with_delta(
            json!({"outcome":"worked","performed":{}}),
            "snapshot",
            vec![json!({"change":"focused","kind":"window","pid":1})],
        );
        assert_eq!(out["performed"]["deltaSource"], "snapshot");
        assert_eq!(out["rootDelta"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn coordinate_actions_reject_background_before_native_dispatch() {
        for action in ["click", "moveMouse", "scroll", "typeText", "keypress"] {
            let error = act(&json!({
                "lookId":"look_1", "action":action, "policy":"background",
                "target":{"x":1,"y":1}, "params":{}, "resolvedPoint":{"x":1,"y":1}
            }))
            .unwrap_err();
            assert_eq!(error.code, ErrorCode::ForegroundRequired, "{action}");
        }
    }

    // This test exercises the non-Windows stub, never real desktop input.
    #[cfg(not(windows))]
    #[test]
    fn raw_coordinate_actions_do_not_claim_worked() {
        let actions = ["click", "moveMouse", "scroll", "typeText", "keypress"];
        for action in actions {
            let params = match action {
                "typeText" => json!({"text":"abc"}),
                "keypress" => json!({"keys":["enter"]}),
                "scroll" => json!({"scrollY":1,"scrollX":0}),
                _ => json!({}),
            };
            let result = act(&json!({"lookId":"look_1","action":action,"policy":"foreground","target":{"x":1,"y":1},"params":params,"resolvedPoint":{"x":1,"y":1}})).unwrap();
            assert_ne!(
                result["outcome"], "worked",
                "{action} must not report worked without verification"
            );
        }
    }
}
