//! X11/EWMH enrichment, capture, focus, and guarded XTEST physical input.
use crate::atspi::{Rect, RootSnapshot};
use crate::{ErrorCode, ProtocolError};
use base64::Engine as _;
use serde_json::{json, Value};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ButtonIndex, ClientMessageData, ClientMessageEvent, ConnectionExt as _,
    Drawable, EventMask, ImageFormat, ImageOrder, Keycode, MapState, Window, BUTTON_PRESS_EVENT,
    BUTTON_RELEASE_EVENT, CLIENT_MESSAGE_EVENT, KEY_PRESS_EVENT, KEY_RELEASE_EVENT,
    MOTION_NOTIFY_EVENT,
};
use x11rb::protocol::{composite, xkb, xtest};
use x11rb::rust_connection::RustConnection;

const MAX_CAPTURE_PIXELS: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionKind {
    X11,
    Wayland,
    Headless,
}
impl SessionKind {
    pub fn detect() -> Self {
        let kind = std::env::var("XDG_SESSION_TYPE")
            .unwrap_or_default()
            .to_ascii_lowercase();
        if kind == "wayland" || (kind.is_empty() && std::env::var_os("WAYLAND_DISPLAY").is_some()) {
            Self::Wayland
        } else if kind == "x11" || std::env::var_os("DISPLAY").is_some() {
            Self::X11
        } else {
            Self::Headless
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::X11 => "x11",
            Self::Wayland => "wayland",
            Self::Headless => "headless",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PhysicalPolicy {
    AxOnly,
    Background,
    Default,
    Foreground,
}
impl PhysicalPolicy {
    pub fn parse(value: Option<&str>) -> Result<Self, ProtocolError> {
        match value.unwrap_or("default") {
            "ax_only" => Ok(Self::AxOnly),
            "background" => Ok(Self::Background),
            "default" => Ok(Self::Default),
            "foreground" => Ok(Self::Foreground),
            value => Err(invalid(format!("Unknown delivery policy '{value}'"))),
        }
    }
    pub fn require_physical(self, session: SessionKind) -> Result<(), ProtocolError> {
        if session == SessionKind::Headless {
            return Err(err(
                "Physical input is unavailable in a headless Linux session",
                ErrorCode::CoordinateBlocked,
            ));
        }
        if session != SessionKind::X11 {
            return Err(err(
                "XTEST is unavailable in native Wayland sessions; use AT-SPI",
                ErrorCode::CapabilityDeferred,
            ));
        }
        match self {
            Self::AxOnly => Err(err(
                "ax_only policy forbids XTEST and window focus",
                ErrorCode::CoordinateBlocked,
            )),
            Self::Background => Err(err(
                "Background policy forbids global XTEST input",
                ErrorCode::ForegroundRequired,
            )),
            Self::Default | Self::Foreground => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct WindowInfo {
    pub id: u32,
    pub pid: u64,
    pub title: String,
    pub frame: Rect,
    pub focused: bool,
    pub minimized: bool,
    pub modal: Option<bool>,
    pub z_order: usize,
}
pub struct Capture {
    pub png_base64: String,
    pub width: u16,
    pub height: u16,
    pub source: &'static str,
    pub warnings: Vec<String>,
}
pub fn available() -> bool {
    SessionKind::detect() == SessionKind::X11 && connect().is_ok()
}

pub fn list_windows() -> Result<Vec<WindowInfo>, ProtocolError> {
    let (conn, screen) = connect()?;
    let root = conn.setup().roots[screen].root;
    let a = Atoms::new(&conn)?;
    let active = property32(&conn, root, a.active, AtomEnum::WINDOW.into())
        .first()
        .copied();
    let mut windows = property32(&conn, root, a.stacking, AtomEnum::WINDOW.into());
    if windows.is_empty() {
        windows = property32(&conn, root, a.clients, AtomEnum::WINDOW.into());
    }
    let mut out = Vec::new();
    for (z_order, id) in windows.into_iter().rev().enumerate() {
        let Ok(g) = conn
            .get_geometry(id)
            .ok()
            .and_then(|c| c.reply().ok())
            .ok_or(())
        else {
            continue;
        };
        let translated = conn
            .translate_coordinates(id, root, 0, 0)
            .ok()
            .and_then(|c| c.reply().ok());
        let states = state_property(&conn, id, a.state);
        out.push(WindowInfo {
            id,
            pid: property32(&conn, id, a.pid, AtomEnum::CARDINAL.into())
                .first()
                .copied()
                .unwrap_or(0) as u64,
            title: title(&conn, id, &a),
            frame: Rect {
                x: translated
                    .as_ref()
                    .map(|r| i32::from(r.dst_x))
                    .unwrap_or(i32::from(g.x)),
                y: translated
                    .as_ref()
                    .map(|r| i32::from(r.dst_y))
                    .unwrap_or(i32::from(g.y)),
                width: i32::from(g.width),
                height: i32::from(g.height),
            },
            focused: active == Some(id),
            minimized: states
                .as_ref()
                .is_some_and(|values| values.contains(&a.hidden)),
            modal: states.as_ref().map(|values| values.contains(&a.modal)),
            z_order,
        });
    }
    Ok(out)
}

type AssociationScore = (u8, i64);

pub fn enrich_roots(roots: &mut [RootSnapshot], windows: &[WindowInfo]) {
    // Decide against original accessible bounds before mutating any root. A
    // traversal-order greedy match can assign a browser panel to its picker.
    let scores = roots
        .iter()
        .map(|root| {
            windows
                .iter()
                .map(|window| association_score(root, window))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let root_choices = scores
        .iter()
        .map(|row| unique_association(row.iter().copied().enumerate()))
        .collect::<Vec<_>>();
    let window_choices = (0..windows.len())
        .map(|column| {
            unique_association(
                scores
                    .iter()
                    .enumerate()
                    .map(|(index, row)| (index, row[column])),
            )
        })
        .collect::<Vec<_>>();
    for (index, root) in roots.iter_mut().enumerate() {
        let Some(column) = root_choices[index] else {
            continue;
        };
        if window_choices[column] != Some(index) {
            continue;
        }
        let window = &windows[column];
        root.x11_window = Some(window.id);
        root.frame = Some(window.frame.clone());
        root.is_focused = window.focused;
        root.is_minimized = window.minimized;
        root.x11_modal = window.modal;
        root.z_order = Some(window.z_order);
        if root.name.is_empty() {
            root.name.clone_from(&window.title);
        }
    }
}

pub fn append_unmatched_windows(roots: &mut Vec<RootSnapshot>, windows: &[WindowInfo]) {
    for window in windows {
        if window.pid == 0
            || window.frame.width <= 0
            || window.frame.height <= 0
            || roots.iter().any(|root| root.x11_window == Some(window.id))
        {
            continue;
        }
        // This root explicitly has no accessibility object. Never borrow the
        // nodes of a different window merely because its process is the same.
        let app_name = std::fs::read_link(format!("/proc/{}/exe", window.pid))
            .ok()
            .and_then(|p| {
                p.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| format!("X11 process {}", window.pid));
        roots.push(RootSnapshot {
            accessible: crate::atspi::AccessibleRef {
                destination: "x11-only".to_owned(),
                path: format!("/x11/window/{}/pid/{}", window.id, window.pid),
            },
            accessibility_available: false,
            pid: window.pid,
            name: window.title.clone(),
            app_name,
            role: "window".to_owned(),
            frame: Some(window.frame.clone()),
            x11_window: Some(window.id),
            is_focused: window.focused,
            is_minimized: window.minimized,
            x11_modal: window.modal,
            z_order: Some(window.z_order),
        });
    }
}

fn association_score(root: &RootSnapshot, window: &WindowInfo) -> Option<AssociationScore> {
    if root.pid == 0 || root.pid != window.pid {
        return None;
    }
    let frame = root.frame.as_ref()?;
    if frame.width <= 0 || frame.height <= 0 || window.frame.width <= 0 || window.frame.height <= 0
    {
        return None;
    }
    // Allow ordinary WM decorations, but never guess from PID or title alone.
    // Widen before subtraction so untrusted i32 coordinates cannot overflow.
    let differences = [
        (frame.x, window.frame.x),
        (frame.y, window.frame.y),
        (frame.width, window.frame.width),
        (frame.height, window.frame.height),
    ]
    .map(|(a, b)| (i64::from(a) - i64::from(b)).abs());
    let distance = distance(Some(frame), &window.frame);
    if differences.iter().any(|difference| *difference > 64) || distance > 128 {
        return None;
    }
    let title_match = !root.name.trim().is_empty()
        && !window.title.trim().is_empty()
        && (window.title.contains(&root.name) || root.name.contains(&window.title));
    Some((u8::from(!title_match), distance))
}

fn distance(frame: Option<&Rect>, window: &Rect) -> i64 {
    frame
        .map(|frame| {
            [
                (frame.x, window.x),
                (frame.y, window.y),
                (frame.width, window.width),
                (frame.height, window.height),
            ]
            .iter()
            .map(|(a, b)| (i64::from(*a) - i64::from(*b)).abs())
            .sum()
        })
        .unwrap_or(0)
}

fn unique_association(
    scores: impl Iterator<Item = (usize, Option<AssociationScore>)>,
) -> Option<usize> {
    let mut best: Option<(usize, AssociationScore)> = None;
    let mut ambiguous = false;
    for (index, score) in scores {
        let Some(score) = score else { continue };
        match best {
            None => {
                best = Some((index, score));
                ambiguous = false;
            }
            Some((_, previous)) if score < previous => {
                best = Some((index, score));
                ambiguous = false;
            }
            Some((_, previous)) if score == previous => ambiguous = true,
            _ => {}
        }
    }
    if ambiguous {
        None
    } else {
        best.map(|(index, _)| index)
    }
}

pub fn focus_window(window: Window, policy: PhysicalPolicy) -> Result<Value, ProtocolError> {
    policy.require_physical(SessionKind::detect())?;
    let (conn, screen) = connect()?;
    let root = conn.setup().roots[screen].root;
    let atom = intern(&conn, "_NET_ACTIVE_WINDOW")?;
    let event = ClientMessageEvent {
        response_type: CLIENT_MESSAGE_EVENT,
        format: 32,
        sequence: 0,
        window,
        type_: atom,
        data: ClientMessageData::from([2, 0, 0, 0, 0]),
    };
    conn.send_event(
        false,
        root,
        EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
        event,
    )
    .map_err(xerr)?
    .check()
    .map_err(xerr)?;
    conn.flush().map_err(xerr)?;
    Ok(json!({"focused":true,"delivery":"ewmh","windowId":window}))
}

pub fn capture_window(
    window: Window,
    max_dimension: Option<u32>,
) -> Result<Capture, ProtocolError> {
    let (conn, _) = connect()?;
    let g = conn
        .get_geometry(window)
        .map_err(xerr)?
        .reply()
        .map_err(xerr)?;
    let pixels = u64::from(g.width) * u64::from(g.height);
    if pixels == 0 || pixels > MAX_CAPTURE_PIXELS {
        return Err(err(
            format!(
                "Refusing X11 capture of {}x{} window (64MP limit)",
                g.width, g.height
            ),
            ErrorCode::CaptureFailed,
        ));
    }
    let pixmap = conn.generate_id().map_err(xerr)?;
    let mut warnings = Vec::new();
    let (drawable, source) = match composite::name_window_pixmap(&conn, window, pixmap)
        .ok()
        .and_then(|c| c.check().ok())
        .ok_or(())
    {
        Ok(()) => (pixmap as Drawable, "xcomposite"),
        Err(_) => {
            warnings.push(
                "XComposite unavailable; GetImage fallback may contain stale or obscured pixels"
                    .into(),
            );
            (window as Drawable, "get_image")
        }
    };
    let image = conn
        .get_image(
            ImageFormat::Z_PIXMAP,
            drawable,
            0,
            0,
            g.width,
            g.height,
            u32::MAX,
        )
        .map_err(xerr)?
        .reply()
        .map_err(|e| {
            err(
                format!("X11 GetImage failed: {e}"),
                ErrorCode::CaptureFailed,
            )
        })?;
    if source == "xcomposite" {
        let _ = conn.free_pixmap(pixmap);
    }
    let rgba = decode(
        &image.data,
        g.width,
        g.height,
        image.depth,
        conn.setup().image_byte_order,
    )?;
    let (output_width, output_height) = scaled_dimensions(g.width, g.height, max_dimension);
    let rgba = resize_rgba(&rgba, g.width, g.height, output_width, output_height);
    let mut encoded = Vec::new();
    {
        let mut encoder =
            png::Encoder::new(&mut encoded, output_width.into(), output_height.into());
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().map_err(capture_err)?;
        writer.write_image_data(&rgba).map_err(capture_err)?;
    }
    Ok(Capture {
        png_base64: base64::engine::general_purpose::STANDARD.encode(encoded),
        width: output_width,
        height: output_height,
        source,
        warnings,
    })
}
fn scaled_dimensions(width: u16, height: u16, max_dimension: Option<u32>) -> (u16, u16) {
    let largest = u32::from(width.max(height));
    let Some(limit) = max_dimension.filter(|limit| *limit > 0 && *limit < largest) else {
        return (width, height);
    };
    let scale = f64::from(limit) / f64::from(largest);
    (
        (f64::from(width) * scale).round().max(1.0) as u16,
        (f64::from(height) * scale).round().max(1.0) as u16,
    )
}

fn resize_rgba(
    source: &[u8],
    source_width: u16,
    source_height: u16,
    width: u16,
    height: u16,
) -> Vec<u8> {
    if (source_width, source_height) == (width, height) {
        return source.to_vec();
    }
    let mut output = vec![0; usize::from(width) * usize::from(height) * 4];
    for y in 0..height {
        let source_y = (u32::from(y) * u32::from(source_height) / u32::from(height)) as usize;
        for x in 0..width {
            let source_x = (u32::from(x) * u32::from(source_width) / u32::from(width)) as usize;
            let from = (source_y * usize::from(source_width) + source_x) * 4;
            let to = (usize::from(y) * usize::from(width) + usize::from(x)) * 4;
            output[to..to + 4].copy_from_slice(&source[from..from + 4]);
        }
    }
    output
}

fn decode(
    data: &[u8],
    w: u16,
    h: u16,
    depth: u8,
    order: ImageOrder,
) -> Result<Vec<u8>, ProtocolError> {
    let expected = usize::from(w) * usize::from(h) * 4;
    if !matches!(depth, 24 | 32) || data.len() < expected {
        return Err(err(
            format!(
                "Unsupported X11 image layout: depth {depth}, {} bytes",
                data.len()
            ),
            ErrorCode::CaptureFailed,
        ));
    }
    let mut out = Vec::with_capacity(expected);
    for p in data[..expected].as_chunks::<4>().0 {
        let (r, g, b) = if order == ImageOrder::LSB_FIRST {
            (p[2], p[1], p[0])
        } else {
            (p[1], p[2], p[3])
        };
        out.extend_from_slice(&[r, g, b, 255]);
    }
    Ok(out)
}

#[derive(Debug, Default)]
struct HidDispatch {
    events_attempted: u64,
    keys: std::collections::BTreeSet<u8>,
    buttons: std::collections::BTreeSet<u8>,
}
impl HidDispatch {
    fn attempted(&mut self, event: u8, detail: u8) {
        self.events_attempted += 1;
        match event {
            KEY_PRESS_EVENT => {
                self.keys.insert(detail);
            }
            BUTTON_PRESS_EVENT => {
                self.buttons.insert(detail);
            }
            _ => {}
        }
    }
    fn confirmed(&mut self, event: u8, detail: u8) {
        match event {
            KEY_RELEASE_EVENT => {
                self.keys.remove(&detail);
            }
            BUTTON_RELEASE_EVENT => {
                self.buttons.remove(&detail);
            }
            _ => {}
        }
    }
    fn failed(&self, error: ProtocolError, window: Window) -> Result<Value, ProtocolError> {
        if self.events_attempted == 0 {
            return Err(error);
        }
        Ok(json!({
            "outcome":"unknown",
            "performed":{"grounding":"coordinates","delivery":"hid","mechanism":"xtest","windowId":window},
            "error":{"code":"foreground_interrupted_after_partial_hid","message":error.message,"causeCode":error.code.to_string()},
            "inputDispatch":{"eventsDispatched":self.events_attempted,"eventCountKind":"write_attempts","unreleasedKeys":self.keys,"unreleasedMouseButtons":self.buttons,"recoveryRequired":true,"retrySafe":false}
        }))
    }
}

pub struct Input {
    conn: RustConnection,
    root: Window,
    target: Window,
    expected_pid: u64,
    dispatch: std::cell::RefCell<HidDispatch>,
}
impl Input {
    pub fn connect(
        policy: PhysicalPolicy,
        target: Window,
        expected_pid: u64,
    ) -> Result<Self, ProtocolError> {
        policy.require_physical(SessionKind::detect())?;
        let (conn, screen) = connect()?;
        let root = conn.setup().roots[screen].root;
        validate_target(&conn, root, target, expected_pid)?;
        prepare_focus(&conn, root, target, policy)?;
        xtest::get_version(&conn, 2, 2)
            .map_err(xerr)?
            .reply()
            .map_err(|e| {
                err(
                    format!("XTEST unavailable: {e}"),
                    ErrorCode::CapabilityDeferred,
                )
            })?;
        Ok(Self {
            conn,
            root,
            target,
            expected_pid,
            dispatch: std::cell::RefCell::new(HidDispatch::default()),
        })
    }
    pub fn failure_result(&self, error: ProtocolError) -> Result<Value, ProtocolError> {
        self.dispatch.borrow().failed(error, self.target)
    }
    pub fn move_pointer(&self, x: i32, y: i32) -> Result<(), ProtocolError> {
        self.preflight_point(x, y)?;
        self.fake(MOTION_NOTIFY_EVENT, 0, x, y)
    }
    pub fn click(&self, x: i32, y: i32, button: &str, count: u64) -> Result<(), ProtocolError> {
        let b = button_detail(button)?;
        self.preflight_point(x, y)?;
        self.fake(MOTION_NOTIFY_EVENT, 0, x, y)?;
        for _ in 0..count.clamp(1, 3) {
            self.fake(BUTTON_PRESS_EVENT, b, 0, 0)?;
            self.fake(BUTTON_RELEASE_EVENT, b, 0, 0)?;
        }
        Ok(())
    }
    pub fn scroll(&self, x: i32, y: i32, dx: f64, dy: f64) -> Result<(), ProtocolError> {
        self.preflight_point(x, y)?;
        self.fake(MOTION_NOTIFY_EVENT, 0, x, y)?;
        for _ in 0..dy.abs().ceil().clamp(0., 100.) as usize {
            self.button(if dy < 0. { 4 } else { 5 })?;
        }
        for _ in 0..dx.abs().ceil().clamp(0., 100.) as usize {
            self.button(if dx < 0. { 6 } else { 7 })?;
        }
        Ok(())
    }
    pub fn drag(&self, path: &[(i32, i32)], button: &str) -> Result<(), ProtocolError> {
        if path.len() < 2 {
            return Err(invalid("drag requires at least two points"));
        }
        let b = button_detail(button)?;
        for &(x, y) in path {
            self.preflight_point(x, y)?;
        }
        self.fake(MOTION_NOTIFY_EVENT, 0, path[0].0, path[0].1)?;
        self.fake(BUTTON_PRESS_EVENT, b, 0, 0)?;
        for &(x, y) in &path[1..] {
            self.fake(MOTION_NOTIFY_EVENT, 0, x, y)?;
        }
        self.fake(BUTTON_RELEASE_EVENT, b, 0, 0)
    }
    pub fn prepare_text(&self, text: &str) -> Result<Vec<(u8, u8)>, ProtocolError> {
        let extension = xkb::use_extension(&self.conn, 1, 0)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        if !extension.supported {
            return Err(invalid("XKB keyboard state is unavailable"));
        }
        let state = xkb::get_state(&self.conn, xkb::ID::USE_CORE_KBD.into())
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        validate_text_keyboard_state(u8::from(state.group), u16::from(state.mods))?;
        let setup = self.conn.setup();
        let min = setup.min_keycode;
        let count = setup.max_keycode - min + 1;
        let mapping = self
            .conn
            .get_keyboard_mapping(min, count)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        let width = usize::from(mapping.keysyms_per_keycode);
        if width == 0 {
            return Err(invalid("The X11 keyboard map has no keysyms"));
        }
        prepare_text_events(text, |sym| {
            resolve_base_group_symbol(&mapping.keysyms, width, min, sym)
        })
    }

    pub fn type_prepared(&self, events: &[(u8, u8)]) -> Result<(), ProtocolError> {
        for &(event, code) in events {
            self.fake(event, code, 0, 0)?;
        }
        Ok(())
    }
    pub fn type_text(&self, text: &str) -> Result<(), ProtocolError> {
        let events = self.prepare_text(text)?;
        self.type_prepared(&events)
    }
    pub fn prepare_keypress(&self, names: &[&str]) -> Result<Vec<(u8, u8)>, ProtocolError> {
        prepare_keypress_events(names, |sym| self.keycode(sym))
    }
    pub fn keypress(&self, names: &[&str]) -> Result<(), ProtocolError> {
        let events = self.prepare_keypress(names)?;
        self.type_prepared(&events)
    }
    fn preflight_point(&self, x: i32, y: i32) -> Result<(), ProtocolError> {
        validate_target(&self.conn, self.root, self.target, self.expected_pid)?;
        if active_window(&self.conn, self.root)? != Some(self.target) {
            return Err(err(
                "Refusing XTEST delivery because the owning window is no longer active",
                ErrorCode::ForegroundRequired,
            ));
        }
        let hit = self
            .conn
            .translate_coordinates(self.root, self.root, clamp_i16(x), clamp_i16(y))
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?
            .child;
        if hit == 0 || !windows_related(&self.conn, hit, self.target)? {
            return Err(err(
                "Refusing XTEST pointer delivery because the target point is outside or occluded",
                ErrorCode::CoordinateBlocked,
            ));
        }
        Ok(())
    }
    fn keycode(&self, sym: u32) -> Result<Option<Keycode>, ProtocolError> {
        let setup = self.conn.setup();
        let min = setup.min_keycode;
        let count = setup.max_keycode - min + 1;
        let m = self
            .conn
            .get_keyboard_mapping(min, count)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        Ok(m.keysyms
            .chunks(usize::from(m.keysyms_per_keycode))
            .position(|s| s.contains(&sym))
            .map(|i| min + i as u8))
    }
    fn button(&self, b: u8) -> Result<(), ProtocolError> {
        self.fake(BUTTON_PRESS_EVENT, b, 0, 0)?;
        self.fake(BUTTON_RELEASE_EVENT, b, 0, 0)
    }
    fn fake(&self, event: u8, detail: u8, x: i32, y: i32) -> Result<(), ProtocolError> {
        validate_target(&self.conn, self.root, self.target, self.expected_pid)?;
        if active_window(&self.conn, self.root)? != Some(self.target) {
            return Err(err(
                "Refusing XTEST delivery because the owning window is no longer active",
                ErrorCode::ForegroundRequired,
            ));
        }
        // An error while writing or acknowledging the request cannot prove
        // that no input reached the server. Count the attempt conservatively.
        self.dispatch.borrow_mut().attempted(event, detail);
        xtest::fake_input(
            &self.conn,
            event,
            detail,
            0,
            self.root,
            clamp_i16(x),
            clamp_i16(y),
            0,
        )
        .map_err(xerr)?
        .check()
        .map_err(xerr)?;
        self.conn.flush().map_err(xerr)?;
        self.dispatch.borrow_mut().confirmed(event, detail);
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FocusPlan {
    Confirm,
    ActivateAndConfirm,
}

fn focus_plan(policy: PhysicalPolicy, active: bool) -> Result<FocusPlan, ProtocolError> {
    match policy {
        PhysicalPolicy::Foreground => Ok(FocusPlan::ActivateAndConfirm),
        PhysicalPolicy::Default if active => Ok(FocusPlan::Confirm),
        PhysicalPolicy::Default => Err(err(
            "Default policy requires the owning X11 window to already be active",
            ErrorCode::ForegroundRequired,
        )),
        PhysicalPolicy::AxOnly | PhysicalPolicy::Background => {
            policy.require_physical(SessionKind::X11)?;
            unreachable!()
        }
    }
}
fn prepare_focus(
    c: &RustConnection,
    root: Window,
    target: Window,
    policy: PhysicalPolicy,
) -> Result<(), ProtocolError> {
    let plan = focus_plan(policy, active_window(c, root)? == Some(target))?;
    if plan == FocusPlan::ActivateAndConfirm {
        request_active_window(c, root, target)?;
    }
    for _ in 0..20 {
        if active_window(c, root)? == Some(target) {
            return Ok(());
        }
        if plan == FocusPlan::Confirm {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    Err(err(
        "Window manager did not activate the owning X11 window; refusing XTEST delivery",
        ErrorCode::ForegroundRequired,
    ))
}
fn validate_process_identity(expected: u64, actual: u64) -> Result<(), ProtocolError> {
    if expected == 0 || actual == 0 || expected != actual {
        return Err(err(
            "Owning X11 window process identity changed or is unavailable",
            ErrorCode::StaleRef,
        ));
    }
    Ok(())
}

fn validate_target(
    c: &RustConnection,
    root: Window,
    target: Window,
    expected_pid: u64,
) -> Result<(), ProtocolError> {
    if target == 0 || target == root {
        return Err(err(
            "XTEST requires a specific owning X11 window",
            ErrorCode::CoordinateBlocked,
        ));
    }
    let attributes = c
        .get_window_attributes(target)
        .map_err(xerr)?
        .reply()
        .map_err(|_| {
            err(
                "Owning X11 window no longer exists",
                ErrorCode::TargetNotFound,
            )
        })?;
    let geometry = c.get_geometry(target).map_err(xerr)?.reply().map_err(|_| {
        err(
            "Owning X11 window has no usable geometry",
            ErrorCode::CoordinateBlocked,
        )
    })?;
    let atoms = Atoms::new(c)?;
    let actual_pid = property32(c, target, atoms.pid, AtomEnum::CARDINAL.into())
        .first()
        .copied()
        .unwrap_or(0) as u64;
    validate_process_identity(expected_pid, actual_pid)?;

    if attributes.map_state != MapState::VIEWABLE
        || geometry.width == 0
        || geometry.height == 0
        || property32(c, target, atoms.state, AtomEnum::ATOM.into()).contains(&atoms.hidden)
    {
        return Err(err(
            "Owning X11 window is not mapped and visible",
            ErrorCode::CoordinateBlocked,
        ));
    }
    Ok(())
}
fn active_window(c: &RustConnection, root: Window) -> Result<Option<Window>, ProtocolError> {
    let atom = intern(c, "_NET_ACTIVE_WINDOW")?;
    Ok(property32(c, root, atom, AtomEnum::WINDOW.into())
        .first()
        .copied())
}
fn request_active_window(
    c: &RustConnection,
    root: Window,
    target: Window,
) -> Result<(), ProtocolError> {
    let atom = intern(c, "_NET_ACTIVE_WINDOW")?;
    let event = ClientMessageEvent {
        response_type: CLIENT_MESSAGE_EVENT,
        format: 32,
        sequence: 0,
        window: target,
        type_: atom,
        data: ClientMessageData::from([2, 0, 0, 0, 0]),
    };
    c.send_event(
        false,
        root,
        EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
        event,
    )
    .map_err(xerr)?
    .check()
    .map_err(xerr)?;
    c.flush().map_err(xerr)
}
fn windows_related(c: &RustConnection, hit: Window, target: Window) -> Result<bool, ProtocolError> {
    fn ancestors(c: &RustConnection, mut w: Window) -> Result<Vec<Window>, ProtocolError> {
        let mut out = vec![w];
        for _ in 0..64 {
            let tree = c.query_tree(w).map_err(xerr)?.reply().map_err(xerr)?;
            if tree.parent == 0 || tree.parent == w {
                break;
            }
            w = tree.parent;
            out.push(w);
        }
        Ok(out)
    }
    Ok(ancestors(c, hit)?.contains(&target) || ancestors(c, target)?.contains(&hit))
}
fn clamp_i16(value: i32) -> i16 {
    value.clamp(i16::MIN.into(), i16::MAX.into()) as i16
}

fn button_detail(b: &str) -> Result<u8, ProtocolError> {
    match b {
        "left" => Ok(ButtonIndex::M1.into()),
        "middle" => Ok(ButtonIndex::M2.into()),
        "right" => Ok(ButtonIndex::M3.into()),
        _ => Err(invalid(format!("Unsupported mouse button '{b}'"))),
    }
}
fn prepare_keypress_events(
    names: &[&str],
    mut keycode: impl FnMut(u32) -> Result<Option<u8>, ProtocolError>,
) -> Result<Vec<(u8, u8)>, ProtocolError> {
    if names.is_empty() {
        return Err(invalid("keypress requires keys"));
    }
    let codes = names
        .iter()
        .map(|name| {
            let sym =
                named_keysym(name).ok_or_else(|| invalid(format!("Unsupported key '{name}'")))?;
            keycode(sym)?.ok_or_else(|| invalid(format!("No keycode for keysym 0x{sym:x}")))
        })
        .collect::<Result<Vec<_>, ProtocolError>>()?;
    Ok(codes
        .iter()
        .map(|&code| (KEY_PRESS_EVENT, code))
        .chain(codes.iter().rev().map(|&code| (KEY_RELEASE_EVENT, code)))
        .collect())
}

// Resolve the entire string before emitting any key event. Unsupported late
// characters or missing keycodes must not leave an already typed prefix.
fn prepare_text_events(
    text: &str,
    mut resolve: impl FnMut(u32) -> Option<(u8, bool)>,
) -> Result<Vec<(u8, u8)>, ProtocolError> {
    let mut events = Vec::new();
    for ch in text.chars() {
        let sym = char_keysym(ch)
            .ok_or_else(|| invalid(format!("Unsupported XTEST character {ch:?}")))?;
        let (code, shifted) = resolve(sym)
            .ok_or_else(|| invalid(format!("No base-group keycode for keysym 0x{sym:x}")))?;
        let shift = if shifted {
            let (shift, modifier) = resolve(0xffe1).ok_or_else(|| invalid("No Shift keycode"))?;
            if modifier {
                return Err(invalid("Shift keycode requires a modifier"));
            }
            Some(shift)
        } else {
            None
        };
        if let Some(code) = shift {
            events.push((KEY_PRESS_EVENT, code));
        }
        events.push((KEY_PRESS_EVENT, code));
        events.push((KEY_RELEASE_EVENT, code));
        if let Some(code) = shift {
            events.push((KEY_RELEASE_EVENT, code));
        }
    }
    Ok(events)
}

fn validate_text_keyboard_state(group: u8, modifiers: u16) -> Result<(), ProtocolError> {
    if group != 0 || modifiers != 0 {
        return Err(invalid(
            "Text input requires keyboard group zero and no active modifiers",
        ));
    }
    Ok(())
}

fn resolve_base_group_symbol(
    symbols: &[u32],
    width: usize,
    min: u8,
    sym: u32,
) -> Option<(u8, bool)> {
    if width == 0 {
        return None;
    }
    // Do not mistake a symbol in another group or AltGr level for a key
    // available with no modifier. Prefer an unshifted binding when possible.
    for column in 0..2 {
        for (index, row) in symbols.chunks(width).enumerate() {
            if row.get(column) == Some(&sym) {
                return min
                    .checked_add(u8::try_from(index).ok()?)
                    .map(|code| (code, column == 1));
            }
        }
    }
    None
}

fn char_keysym(c: char) -> Option<u32> {
    match c {
        '\n' | '\r' => Some(0xff0d),
        '\t' => Some(0xff09),
        c if c.is_control() => None,
        c if (c as u32) <= 0xff => Some(c as u32),
        c => Some(0x01000000 | c as u32),
    }
}
fn named_keysym(n: &str) -> Option<u32> {
    match n.to_ascii_lowercase().as_str() {
        "enter" | "return" => Some(0xff0d),
        "tab" => Some(0xff09),
        "escape" | "esc" => Some(0xff1b),
        "backspace" => Some(0xff08),
        "delete" => Some(0xffff),
        "space" => Some(0x20),
        "left" => Some(0xff51),
        "up" => Some(0xff52),
        "right" => Some(0xff53),
        "down" => Some(0xff54),
        "home" => Some(0xff50),
        "end" => Some(0xff57),
        "pageup" => Some(0xff55),
        "pagedown" => Some(0xff56),
        "ctrl" | "control" => Some(0xffe3),
        "shift" => Some(0xffe1),
        "alt" | "option" => Some(0xffe9),
        "meta" | "super" | "cmd" | "command" => Some(0xffeb),
        v if v.len() == 1 => v.chars().next().map(|c| c as u32),
        v if v.starts_with('f') => v[1..]
            .parse::<u32>()
            .ok()
            .filter(|n| (1..=35).contains(n))
            .map(|n| 0xffbd + n),
        _ => None,
    }
}

struct Atoms {
    clients: Atom,
    stacking: Atom,
    active: Atom,
    pid: Atom,
    name: Atom,
    state: Atom,
    hidden: Atom,
    modal: Atom,
    utf8: Atom,
}
impl Atoms {
    fn new(c: &RustConnection) -> Result<Self, ProtocolError> {
        Ok(Self {
            clients: intern(c, "_NET_CLIENT_LIST")?,
            stacking: intern(c, "_NET_CLIENT_LIST_STACKING")?,
            active: intern(c, "_NET_ACTIVE_WINDOW")?,
            pid: intern(c, "_NET_WM_PID")?,
            name: intern(c, "_NET_WM_NAME")?,
            state: intern(c, "_NET_WM_STATE")?,
            hidden: intern(c, "_NET_WM_STATE_HIDDEN")?,
            modal: intern(c, "_NET_WM_STATE_MODAL")?,
            utf8: intern(c, "UTF8_STRING")?,
        })
    }
}
fn connect() -> Result<(RustConnection, usize), ProtocolError> {
    x11rb::connect(None).map_err(|e| {
        err(
            format!("X11 unavailable: {e}"),
            ErrorCode::CapabilityDeferred,
        )
    })
}
fn intern(c: &RustConnection, n: &str) -> Result<Atom, ProtocolError> {
    c.intern_atom(false, n.as_bytes())
        .map_err(xerr)?
        .reply()
        .map(|r| r.atom)
        .map_err(xerr)
}
// Missing state means unset; malformed properties and failed reads stay unknown.
fn state_property(c: &RustConnection, w: Window, state: Atom) -> Option<Vec<u32>> {
    let reply = c
        .get_property(false, w, state, AtomEnum::ANY, 0, 4096)
        .ok()?
        .reply()
        .ok()?;
    decode_state_property(&reply)
}
fn decode_state_property(reply: &x11rb::protocol::xproto::GetPropertyReply) -> Option<Vec<u32>> {
    if reply.type_ == u32::from(AtomEnum::NONE) {
        return (reply.format == 0 && reply.bytes_after == 0 && reply.value.is_empty())
            .then(Vec::new);
    }
    if reply.type_ != u32::from(AtomEnum::ATOM)
        || reply.format != 32
        || reply.bytes_after != 0
        || reply.value.len() != usize::try_from(reply.value_len).ok()?.checked_mul(4)?
    {
        return None;
    }
    let values = reply.value32()?.collect();
    Some(values)
}
fn property32(c: &RustConnection, w: Window, p: Atom, t: Atom) -> Vec<u32> {
    c.get_property(false, w, p, t, 0, u32::MAX)
        .ok()
        .and_then(|v| v.reply().ok())
        .and_then(|v| v.value32().map(Iterator::collect))
        .unwrap_or_default()
}
fn title(c: &RustConnection, w: Window, a: &Atoms) -> String {
    let utf = c
        .get_property(false, w, a.name, a.utf8, 0, 4096)
        .ok()
        .and_then(|v| v.reply().ok())
        .and_then(|v| String::from_utf8(v.value).ok())
        .unwrap_or_default();
    if !utf.is_empty() {
        return utf;
    }
    c.get_property(false, w, AtomEnum::WM_NAME, AtomEnum::STRING, 0, 4096)
        .ok()
        .and_then(|v| v.reply().ok())
        .map(|v| String::from_utf8_lossy(&v.value).into_owned())
        .unwrap_or_default()
}
fn err(m: impl Into<String>, code: ErrorCode) -> ProtocolError {
    ProtocolError::new(m, code)
}
fn invalid(m: impl Into<String>) -> ProtocolError {
    err(m, ErrorCode::InvalidRequest)
}
fn xerr(e: impl std::fmt::Display) -> ProtocolError {
    err(format!("X11 request failed: {e}"), ErrorCode::InternalError)
}
fn capture_err(e: impl std::fmt::Display) -> ProtocolError {
    err(
        format!("PNG encoding failed: {e}"),
        ErrorCode::CaptureFailed,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn association_root(name: &str, frame: Option<Rect>) -> RootSnapshot {
        RootSnapshot {
            accessible: crate::atspi::AccessibleRef {
                destination: ":1.1".into(),
                path: name.into(),
            },
            pid: 42,
            name: name.into(),
            app_name: "Chrome".into(),
            role: "frame".into(),
            frame,
            accessibility_available: true,
            x11_window: None,
            is_focused: false,
            is_minimized: false,
            x11_modal: None,
            z_order: None,
        }
    }
    fn association_window(id: u32, title: &str, frame: Rect) -> WindowInfo {
        WindowInfo {
            id,
            pid: 42,
            title: title.into(),
            frame,
            focused: true,
            minimized: false,
            modal: None,
            z_order: 0,
        }
    }
    fn association_rect(x: i32, y: i32, width: i32, height: i32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }
    #[test]
    fn state_property_rejects_malformed_and_truncated_wire_replies() {
        use x11rb::protocol::xproto::GetPropertyReply;
        let valid = GetPropertyReply {
            format: 32,
            sequence: 0,
            length: 2,
            type_: u32::from(AtomEnum::ATOM),
            bytes_after: 0,
            value_len: 2,
            value: [7_u32.to_ne_bytes(), 11_u32.to_ne_bytes()].concat(),
        };
        assert_eq!(decode_state_property(&valid), Some(vec![7, 11]));
        let mut reply = valid.clone();
        reply.type_ = u32::from(AtomEnum::CARDINAL);
        assert_eq!(decode_state_property(&reply), None);
        reply = valid.clone();
        reply.format = 8;
        assert_eq!(decode_state_property(&reply), None);
        reply = valid.clone();
        reply.bytes_after = 4;
        assert_eq!(decode_state_property(&reply), None);
        reply = valid.clone();
        reply.value.pop();
        assert_eq!(decode_state_property(&reply), None);
        reply = valid.clone();
        reply.value_len = 10;
        assert_eq!(decode_state_property(&reply), None);
        reply = valid.clone();
        reply.type_ = u32::from(AtomEnum::NONE);
        assert_eq!(decode_state_property(&reply), None);
        reply.format = 0;
        reply.value.clear();
        reply.value_len = 0;
        reply.length = 0;
        assert_eq!(decode_state_property(&reply), Some(vec![]));
    }
    #[test]
    fn modal_state_enriches_exact_window_and_preserves_nonmodal_dialog() {
        let frame = association_rect(10, 10, 800, 600);
        for modal in [true, false] {
            let mut roots = vec![association_root("Picker", Some(frame.clone()))];
            roots[0].role = "dialog".into();
            let mut window = association_window(9, "Picker", frame.clone());
            window.modal = Some(modal);
            enrich_roots(&mut roots, &[window]);
            assert_eq!(roots[0].x11_window, Some(9));
            assert_eq!(roots[0].is_modal(), modal);
            let json = crate::atspi::root_json("@r1", &roots[0], 0);
            assert_eq!(json["isModal"], modal);
            assert_eq!(json["metadata"]["modalSource"], "ewmh");
        }
    }
    #[test]
    fn x11_only_modal_state_does_not_borrow_other_process_accessibility() {
        let frame = association_rect(184, 49, 1231, 902);
        let mut window = association_window(9, "Open File", frame);
        window.pid = 999;
        window.modal = Some(true);
        let mut roots = vec![association_root(
            "Browser",
            Some(association_rect(10, 10, 1050, 980)),
        )];
        enrich_roots(&mut roots, &[window.clone()]);
        append_unmatched_windows(&mut roots, &[window]);
        assert_eq!(roots[0].x11_window, None);
        assert_eq!(roots[0].x11_modal, None);
        assert_eq!(roots[1].pid, 999);
        assert!(!roots[1].accessibility_available);
        assert_eq!(roots[1].role, "window");
        assert!(roots[1].is_modal());
        assert_eq!(
            crate::atspi::root_json("@r2", &roots[1], 1)["isModal"],
            true
        );
    }
    #[test]
    fn unavailable_modal_property_remains_explicit_role_inference() {
        let mut root = association_root("Picker", None);
        root.role = "dialog".into();
        assert_eq!(root.x11_modal, None);
        assert!(root.is_modal());
        assert_eq!(root.modal_source(), "role-inferred");
        root.role = "window".into();
        assert!(!root.is_modal());
    }
    #[test]
    fn association_rejects_unrelated_same_pid_picker() {
        let frame = association_rect(10, 10, 1050, 980);
        let mut roots = vec![association_root("Chrome", Some(frame.clone()))];
        let windows = vec![association_window(
            7,
            "Open File",
            association_rect(184, 49, 1231, 902),
        )];
        enrich_roots(&mut roots, &windows);
        assert_eq!(roots[0].x11_window, None);
        assert_eq!(roots[0].frame, Some(frame));
    }
    #[test]
    fn association_rejects_ambiguous_accessibility_roots() {
        let frame = association_rect(10, 10, 1050, 980);
        let mut roots = vec![
            association_root("Chrome", Some(frame.clone())),
            association_root("Chrome", Some(frame.clone())),
        ];
        enrich_roots(&mut roots, &[association_window(7, "Chrome", frame)]);
        assert!(roots.iter().all(|r| r.x11_window.is_none()));
    }
    #[test]
    fn association_does_not_let_first_root_steal_stronger_match() {
        let frame = association_rect(10, 10, 1050, 980);
        let mut roots = vec![
            association_root("Other", Some(association_rect(30, 20, 1050, 980))),
            association_root("Chrome", Some(frame.clone())),
        ];
        enrich_roots(&mut roots, &[association_window(7, "Chrome", frame)]);
        assert_eq!(roots[0].x11_window, None);
        assert_eq!(roots[1].x11_window, Some(7));
    }
    #[test]
    fn association_missing_geometry_never_guesses_by_pid() {
        let mut roots = vec![association_root("Chrome", None)];
        enrich_roots(
            &mut roots,
            &[association_window(
                7,
                "Chrome",
                association_rect(10, 10, 1050, 980),
            )],
        );
        assert_eq!(roots[0].x11_window, None);
    }

    #[test]
    fn association_accepts_unique_window_with_decorations() {
        let mut roots = vec![association_root(
            "Document",
            Some(association_rect(12, 42, 1000, 900)),
        )];
        let window =
            association_window(7, "Document - Editor", association_rect(10, 10, 1004, 936));
        enrich_roots(&mut roots, std::slice::from_ref(&window));
        assert_eq!(roots[0].x11_window, Some(7));
        assert_eq!(roots[0].frame, Some(window.frame));
        assert!(roots[0].is_focused);
    }
    #[test]
    fn association_duplicate_windows_are_ambiguous() {
        let frame = association_rect(10, 10, 1000, 900);
        let mut roots = vec![association_root("Document", Some(frame.clone()))];
        enrich_roots(
            &mut roots,
            &[
                association_window(7, "Document", frame.clone()),
                association_window(8, "Document", frame),
            ],
        );
        assert_eq!(roots[0].x11_window, None);
    }
    #[test]
    fn association_extreme_coordinates_and_unknown_pid_are_rejected() {
        let mut roots = vec![association_root(
            "Document",
            Some(association_rect(i32::MIN, 10, 1000, 900)),
        )];
        enrich_roots(
            &mut roots,
            &[association_window(
                7,
                "Document",
                association_rect(i32::MAX, 10, 1000, 900),
            )],
        );
        assert_eq!(roots[0].x11_window, None);
        roots[0].pid = 0;
        let mut window = association_window(7, "Document", roots[0].frame.clone().unwrap());
        window.pid = 0;
        enrich_roots(&mut roots, &[window]);
        assert_eq!(roots[0].x11_window, None);
    }

    #[test]
    fn unmatched_picker_has_explicit_image_only_root_without_borrowed_nodes() {
        let mut roots = vec![association_root(
            "Chrome",
            Some(association_rect(10, 10, 1050, 980)),
        )];
        let windows = vec![association_window(
            7,
            "Open File",
            association_rect(184, 49, 1231, 902),
        )];
        enrich_roots(&mut roots, &windows);
        append_unmatched_windows(&mut roots, &windows);
        assert_eq!(roots.len(), 2);
        assert!(roots[0].accessibility_available);
        assert_eq!(roots[0].x11_window, None);
        assert!(!roots[1].accessibility_available);
        assert_eq!(roots[1].x11_window, Some(7));
        let outline = crate::atspi::outline_json(&roots[1], &[], 500);
        assert_eq!(outline["pictureOnly"], true);
        assert!(outline.get("ref").is_none());
        assert!(outline["children"].as_array().unwrap().is_empty());
        let public = crate::atspi::root_json("@w2", &roots[1], 1);
        assert_eq!(public["metadata"]["backend"], "x11");
        assert_eq!(public["metadata"]["accessibilityAvailable"], false);
        append_unmatched_windows(&mut roots, &windows);
        assert_eq!(roots.len(), 2);
    }
    #[test]
    fn unmatched_unknown_process_window_never_gains_physical_root() {
        let mut roots = Vec::new();
        let mut window = association_window(7, "Unknown", association_rect(10, 10, 100, 100));
        window.pid = 0;
        append_unmatched_windows(&mut roots, &[window]);
        assert!(roots.is_empty());
    }

    #[test]
    fn physical_input_rejects_reused_xid_with_different_or_unknown_pid() {
        assert!(validate_process_identity(42, 42).is_ok());
        for (expected, actual) in [(42, 43), (42, 0), (0, 42), (0, 0)] {
            assert_eq!(
                validate_process_identity(expected, actual)
                    .unwrap_err()
                    .code,
                ErrorCode::StaleRef
            );
        }
    }

    #[test]
    fn policy_guards() {
        assert_eq!(
            PhysicalPolicy::AxOnly
                .require_physical(SessionKind::X11)
                .unwrap_err()
                .code,
            ErrorCode::CoordinateBlocked
        );
        assert_eq!(
            PhysicalPolicy::Background
                .require_physical(SessionKind::X11)
                .unwrap_err()
                .code,
            ErrorCode::ForegroundRequired
        );
        assert!(PhysicalPolicy::Foreground
            .require_physical(SessionKind::X11)
            .is_ok());
        assert!(PhysicalPolicy::Default
            .require_physical(SessionKind::Headless)
            .is_err());
    }
    #[test]
    fn focus_policy_is_deterministic() {
        assert_eq!(
            focus_plan(PhysicalPolicy::Foreground, false).unwrap(),
            FocusPlan::ActivateAndConfirm
        );
        assert_eq!(
            focus_plan(PhysicalPolicy::Foreground, true).unwrap(),
            FocusPlan::ActivateAndConfirm
        );
        assert_eq!(
            focus_plan(PhysicalPolicy::Default, true).unwrap(),
            FocusPlan::Confirm
        );
        assert_eq!(
            focus_plan(PhysicalPolicy::Default, false).unwrap_err().code,
            ErrorCode::ForegroundRequired
        );
        assert_eq!(
            focus_plan(PhysicalPolicy::Background, true)
                .unwrap_err()
                .code,
            ErrorCode::ForegroundRequired
        );
    }
    #[test]
    fn coordinate_clamping_is_deterministic() {
        assert_eq!(clamp_i16(i32::MIN), i16::MIN);
        assert_eq!(clamp_i16(i32::MAX), i16::MAX);
        assert_eq!(clamp_i16(42), 42);
    }
    #[test]
    fn geometry_is_deterministic() {
        let a = Rect {
            x: 1,
            y: 2,
            width: 3,
            height: 4,
        };
        assert_eq!(distance(Some(&a), &a), 0);
        assert_eq!(distance(Some(&a), &Rect { x: 6, ..a.clone() }), 5);
    }
    #[test]
    fn rejected_input_before_first_write_keeps_normal_error() {
        let error = ProtocolError::new("not focused", ErrorCode::ForegroundRequired);
        assert_eq!(
            HidDispatch::default().failed(error, 99).unwrap_err().code,
            ErrorCode::ForegroundRequired
        );
    }
    #[test]
    fn partial_input_retains_uncertain_presses_and_releases() {
        let mut dispatch = HidDispatch::default();
        dispatch.attempted(KEY_PRESS_EVENT, 37);
        dispatch.confirmed(KEY_PRESS_EVENT, 37);
        dispatch.attempted(BUTTON_PRESS_EVENT, 1);
        dispatch.attempted(KEY_RELEASE_EVENT, 37); // release acknowledgement lost
        let result = dispatch
            .failed(
                ProtocolError::new("focus lost", ErrorCode::ForegroundRequired),
                99,
            )
            .unwrap();
        assert_eq!(result["outcome"], "unknown");
        assert_eq!(
            result["error"]["code"],
            "foreground_interrupted_after_partial_hid"
        );
        assert_eq!(result["inputDispatch"]["eventsDispatched"], 3);
        assert_eq!(result["inputDispatch"]["unreleasedKeys"], json!([37]));
        assert_eq!(
            result["inputDispatch"]["unreleasedMouseButtons"],
            json!([1])
        );
        assert_eq!(result["inputDispatch"]["retrySafe"], false);
        assert_eq!(result["inputDispatch"]["recoveryRequired"], true);
        dispatch.confirmed(KEY_RELEASE_EVENT, 37);
        dispatch.confirmed(BUTTON_RELEASE_EVENT, 1);
        let result = dispatch
            .failed(
                ProtocolError::new("late error", ErrorCode::InternalError),
                99,
            )
            .unwrap();
        assert_eq!(result["inputDispatch"]["unreleasedKeys"], json!([]));
        assert_eq!(result["inputDispatch"]["unreleasedMouseButtons"], json!([]));
        assert_eq!(result["outcome"], "unknown");
    }
    #[test]
    fn key_protocol() {
        assert_eq!(named_keysym("Control"), Some(0xffe3));
        assert_eq!(named_keysym("F12"), Some(0xffc9));
        assert_eq!(char_keysym('A'), Some('A' as u32));
        assert_eq!(char_keysym('!'), Some('!' as u32));
        assert_eq!(char_keysym('é'), Some(0xe9));
        assert_eq!(char_keysym('文'), Some(0x01006587));
    }
    #[test]
    fn complete_key_chord_is_resolved_before_delivery() {
        assert!(
            prepare_keypress_events(&["control", "a"], |sym| Ok(if sym == 0xffe3 {
                Some(37)
            } else {
                None
            }))
            .is_err()
        );
        assert!(prepare_keypress_events(&["control", "unknown"], |_| Ok(Some(37))).is_err());
        assert_eq!(
            prepare_keypress_events(&["control", "a"], |sym| Ok(Some(if sym == 0xffe3 {
                37
            } else {
                38
            })))
            .unwrap(),
            vec![
                (KEY_PRESS_EVENT, 37),
                (KEY_PRESS_EVENT, 38),
                (KEY_RELEASE_EVENT, 38),
                (KEY_RELEASE_EVENT, 37)
            ]
        );
    }
    #[test]
    fn complete_text_is_resolved_before_delivery() {
        assert!(prepare_text_events("abc\0", |_| Some((38, false))).is_err());
        assert!(prepare_text_events("abc/", |sym| if sym == '/' as u32 {
            None
        } else {
            Some((38, false))
        })
        .is_err());
        assert!(prepare_text_events("A", |sym| if sym == 0xffe1 {
            None
        } else {
            Some((38, true))
        })
        .is_err());
        assert_eq!(
            prepare_text_events("A/", |sym| match sym {
                0xffe1 => Some((50, false)),
                65 => Some((38, true)),
                47 => Some((61, false)),
                _ => None,
            })
            .unwrap(),
            vec![
                (KEY_PRESS_EVENT, 50),
                (KEY_PRESS_EVENT, 38),
                (KEY_RELEASE_EVENT, 38),
                (KEY_RELEASE_EVENT, 50),
                (KEY_PRESS_EVENT, 61),
                (KEY_RELEASE_EVENT, 61)
            ]
        );
    }
    #[test]
    fn text_keyboard_state_rejects_foreign_group_or_modifiers() {
        assert!(validate_text_keyboard_state(0, 0).is_ok());
        assert!(validate_text_keyboard_state(1, 0).is_err());
        for mask in [1, 2, 4, 8, 16, 32, 64, 128] {
            assert!(validate_text_keyboard_state(0, mask).is_err());
        }
    }
    #[test]
    fn text_mapping_uses_actual_shift_level_and_mapped_unicode() {
        // A non-US keyboard where slash needs Shift and accented e does not.
        let map = [
            b':' as u32,
            b'/' as u32,
            0,
            0,
            0xe9,
            0xc9,
            0,
            0,
            0xffe1,
            0,
            0,
            0,
            b'a' as u32,
            b'A' as u32,
            0x01006587,
            0,
        ];
        assert_eq!(
            resolve_base_group_symbol(&map, 4, 8, b'/' as u32),
            Some((8, true))
        );
        assert_eq!(
            resolve_base_group_symbol(&map, 4, 8, 0xe9),
            Some((9, false))
        );
        assert_eq!(resolve_base_group_symbol(&map, 4, 8, 0x01006587), None);
        let events =
            prepare_text_events("/é", |sym| resolve_base_group_symbol(&map, 4, 8, sym)).unwrap();
        assert_eq!(
            events,
            vec![
                (KEY_PRESS_EVENT, 10),
                (KEY_PRESS_EVENT, 8),
                (KEY_RELEASE_EVENT, 8),
                (KEY_RELEASE_EVENT, 10),
                (KEY_PRESS_EVENT, 9),
                (KEY_RELEASE_EVENT, 9)
            ]
        );
        assert!(
            prepare_text_events("/é文", |sym| resolve_base_group_symbol(&map, 4, 8, sym)).is_err()
        );
        assert_eq!(
            prepare_text_events("文", |sym| resolve_base_group_symbol(
                &[0x01006587, 0],
                2,
                8,
                sym
            ))
            .unwrap(),
            vec![(KEY_PRESS_EVENT, 8), (KEY_RELEASE_EVENT, 8)]
        );
    }
    #[test]
    fn native_paths_accept_unshifted_ascii_punctuation() {
        for c in "/tmp/a-b_c.1.txt:[]\\;,'`=".chars() {
            assert!(char_keysym(c).is_some(), "path character {c:?}");
        }
    }
    #[test]
    fn bounded_capture_dimensions_preserve_aspect_ratio() {
        assert_eq!(scaled_dimensions(1920, 1080, Some(1000)), (1000, 563));
        assert_eq!(scaled_dimensions(800, 600, Some(1000)), (800, 600));
        assert_eq!(scaled_dimensions(1, 4000, Some(100)), (1, 100));
        assert_eq!(scaled_dimensions(4000, 1, Some(100)), (100, 1));
    }
    #[test]
    fn rgba_resize_is_bounded_and_deterministic() {
        let source = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
        assert_eq!(resize_rgba(&source, 2, 2, 1, 1), vec![1, 2, 3, 4]);
        assert_eq!(resize_rgba(&source, 2, 2, 2, 2), source);
    }
    #[test]
    fn decode_limits() {
        assert_eq!(
            decode(&[1, 2, 3, 0], 1, 1, 24, ImageOrder::LSB_FIRST).unwrap(),
            vec![3, 2, 1, 255]
        );
        assert!(decode(&[0; 2], 1, 1, 16, ImageOrder::LSB_FIRST).is_err());
    }
}
