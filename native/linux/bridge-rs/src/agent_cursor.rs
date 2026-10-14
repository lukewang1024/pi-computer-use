//! Visual-only desktop cursor. All X resources belong to a dedicated connection;
//! no XTEST events, focus requests, or pointer warps are issued by this module.
use crate::pointer_motion::PointerMotion;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::{shape, xproto::*};
use x11rb::wrapper::ConnectionExt as _;

#[derive(Clone, Default)]
struct FrameState {
    visible: bool,
    samples: u64,
    x: i32,
    y: i32,
}
static FRAME: OnceLock<Mutex<FrameState>> = OnceLock::new();
fn update_frame(update: impl FnOnce(&mut FrameState)) {
    if let Ok(mut frame) = FRAME
        .get_or_init(|| Mutex::new(FrameState::default()))
        .lock()
    {
        update(&mut frame);
    }
}
pub fn status() -> serde_json::Value {
    let frame = FRAME
        .get_or_init(|| Mutex::new(FrameState::default()))
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    serde_json::json!({"visible":frame.visible,"samples":frame.samples,"x":frame.x,"y":frame.y})
}
struct Animation {
    motion: PointerMotion,
    started: Instant,
}
static WORKER: OnceLock<Mutex<Option<mpsc::Sender<Animation>>>> = OnceLock::new();

pub fn animate(points: Vec<(i32, i32)>, duration_ms: u64) -> Result<(), String> {
    let motion = PointerMotion::new(points, duration_ms).map_err(str::to_owned)?;
    let mut sender = WORKER
        .get_or_init(|| Mutex::new(None))
        .lock()
        .map_err(|_| "cursor worker lock poisoned")?;
    if sender.is_none() {
        let (tx, rx) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("agent-cursor".into())
            .spawn(move || {
                let result = setup();
                match result {
                    Ok((conn, window)) => {
                        let _ = ready_tx.send(Ok(()));
                        run(conn, window, rx);
                    }
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                    }
                }
            })
            .map_err(|error| error.to_string())?;
        ready_rx.recv().map_err(|error| error.to_string())??;
        *sender = Some(tx);
    }
    let animation = Animation {
        motion,
        started: Instant::now(),
    };
    if sender.as_ref().unwrap().send(animation).is_err() {
        *sender = None;
        return Err("cursor renderer stopped; no input was dispatched".into());
    }
    Ok(())
}

fn setup() -> Result<(x11rb::rust_connection::RustConnection, Window), String> {
    let (conn, screen_index) = x11rb::connect(None).map_err(|e| e.to_string())?;
    let shape_version = shape::query_version(&conn)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?;
    if shape_version.major_version == 0
        || (shape_version.major_version == 1 && shape_version.minor_version < 1)
    {
        return Err("X Shape 1.1 is required for an input-transparent cursor".into());
    }
    let screen = &conn.setup().roots[screen_index];
    let window = conn.generate_id().map_err(|e| e.to_string())?;
    let pixels = conn.generate_id().map_err(|e| e.to_string())?;
    let mask = conn.generate_id().map_err(|e| e.to_string())?;
    let color_gc = conn.generate_id().map_err(|e| e.to_string())?;
    let mask_gc = conn.generate_id().map_err(|e| e.to_string())?;
    conn.create_pixmap(screen.root_depth, pixels, screen.root, 34, 36)
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    conn.create_pixmap(1, mask, screen.root, 34, 36)
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    conn.create_gc(
        color_gc,
        pixels,
        &CreateGCAux::new().foreground(screen.white_pixel),
    )
    .map_err(|e| e.to_string())?
    .check()
    .map_err(|e| e.to_string())?;
    conn.create_gc(mask_gc, mask, &CreateGCAux::new().foreground(0))
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    let full = [Rectangle {
        x: 0,
        y: 0,
        width: 34,
        height: 36,
    }];
    conn.poly_fill_rectangle(pixels, color_gc, &full)
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    conn.poly_fill_rectangle(mask, mask_gc, &full)
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    // Shared geometry and palette: src/agent-cursor-style.json.
    {
        let color = conn
            .alloc_color(screen.default_colormap, 19532, 7453, 38293)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?
            .pixel;
        let points = [
            (3, 0),
            (2, 0),
            (1, 0),
            (1, 1),
            (1, 2),
            (10, 32),
            (10, 33),
            (10, 34),
            (11, 34),
            (17, 20),
            (18, 20),
            (18, 19),
            (19, 18),
            (30, 11),
            (31, 11),
            (30, 10),
            (29, 10),
        ]
        .map(|(x, y)| Point { x, y });
        conn.change_gc(color_gc, &ChangeGCAux::new().foreground(color))
            .map_err(|e| e.to_string())?;
        conn.fill_poly(
            pixels,
            color_gc,
            PolyShape::COMPLEX,
            CoordMode::ORIGIN,
            &points,
        )
        .map_err(|e| e.to_string())?;
        conn.change_gc(mask_gc, &ChangeGCAux::new().foreground(1))
            .map_err(|e| e.to_string())?;
        conn.fill_poly(
            mask,
            mask_gc,
            PolyShape::COMPLEX,
            CoordMode::ORIGIN,
            &points,
        )
        .map_err(|e| e.to_string())?;
    }
    {
        let color = conn
            .alloc_color(screen.default_colormap, 65535, 65535, 65535)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?
            .pixel;
        let points = [
            (4, 1),
            (3, 1),
            (2, 1),
            (2, 2),
            (2, 3),
            (10, 31),
            (10, 32),
            (11, 32),
            (17, 20),
            (17, 19),
            (18, 18),
            (19, 18),
            (29, 11),
            (29, 10),
            (28, 10),
            (27, 10),
        ]
        .map(|(x, y)| Point { x, y });
        conn.change_gc(color_gc, &ChangeGCAux::new().foreground(color))
            .map_err(|e| e.to_string())?;
        conn.fill_poly(
            pixels,
            color_gc,
            PolyShape::COMPLEX,
            CoordMode::ORIGIN,
            &points,
        )
        .map_err(|e| e.to_string())?;
    }
    {
        let color = conn
            .alloc_color(screen.default_colormap, 35723, 23644, 63222)
            .map_err(|e| e.to_string())?
            .reply()
            .map_err(|e| e.to_string())?
            .pixel;
        let points = [
            (6, 4),
            (5, 4),
            (4, 4),
            (5, 5),
            (10, 26),
            (11, 27),
            (16, 18),
            (16, 17),
            (17, 17),
            (24, 11),
            (23, 10),
        ]
        .map(|(x, y)| Point { x, y });
        conn.change_gc(color_gc, &ChangeGCAux::new().foreground(color))
            .map_err(|e| e.to_string())?;
        conn.fill_poly(
            pixels,
            color_gc,
            PolyShape::COMPLEX,
            CoordMode::ORIGIN,
            &points,
        )
        .map_err(|e| e.to_string())?;
    }
    conn.create_window(
        x11rb::COPY_DEPTH_FROM_PARENT,
        window,
        screen.root,
        0,
        0,
        34,
        36,
        0,
        WindowClass::INPUT_OUTPUT,
        x11rb::COPY_FROM_PARENT,
        &CreateWindowAux::new()
            .override_redirect(1)
            .background_pixmap(pixels),
    )
    .map_err(|e| e.to_string())?
    .check()
    .map_err(|e| e.to_string())?;
    conn.change_property8(
        PropMode::REPLACE,
        window,
        AtomEnum::WM_NAME,
        AtomEnum::STRING,
        b"Pi agent cursor",
    )
    .map_err(|e| e.to_string())?
    .check()
    .map_err(|e| e.to_string())?;
    // Visual mask and input shape are separate: the arrow is visible but never receives input.
    shape::mask(
        &conn,
        shape::SO::SET,
        shape::SK::BOUNDING,
        window,
        0,
        0,
        mask,
    )
    .map_err(|e| e.to_string())?
    .check()
    .map_err(|e| e.to_string())?;
    shape::rectangles(
        &conn,
        shape::SO::SET,
        shape::SK::INPUT,
        ClipOrdering::UNSORTED,
        window,
        0,
        0,
        &[],
    )
    .map_err(|e| e.to_string())?
    .check()
    .map_err(|e| e.to_string())?;
    conn.free_gc(color_gc).map_err(|e| e.to_string())?;
    conn.free_gc(mask_gc).map_err(|e| e.to_string())?;
    conn.free_pixmap(mask).map_err(|e| e.to_string())?;
    // The window retains its background pixmap until the window is destroyed.
    conn.free_pixmap(pixels).map_err(|e| e.to_string())?;
    conn.flush().map_err(|e| e.to_string())?;
    Ok((conn, window))
}

fn run(
    conn: x11rb::rust_connection::RustConnection,
    window: Window,
    rx: mpsc::Receiver<Animation>,
) {
    let mut animation: Option<Animation> = None;
    let mut visible = false;
    let mut last_position = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(16)) {
            Ok(mut next) => {
                next.motion.use_visual_origin(last_position);
                update_frame(|state| state.samples = 0);
                animation = Some(next);
                // Drain superseded commands: never replay stale visual trajectories.
                while let Ok(mut next) = rx.try_recv() {
                    next.motion.use_visual_origin(last_position);
                    animation = Some(next);
                }
                if !visible {
                    if conn.map_window(window).is_err() {
                        break;
                    }
                    visible = true;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        if let Some(current) = &animation {
            let elapsed = current.started.elapsed().as_millis() as u64;
            if elapsed > current.motion.duration_ms + 8000 {
                if conn.unmap_window(window).is_err() {
                    break;
                }
                animation = None;
                visible = false;
                update_frame(|state| state.visible = false);
            } else {
                let (x, y) = current.motion.sample(elapsed);
                last_position = Some((x, y));
                update_frame(|state| {
                    state.visible = true;
                    state.samples += 1;
                    state.x = x;
                    state.y = y;
                });
                if conn
                    .configure_window(
                        window,
                        &ConfigureWindowAux::new()
                            .x(x - 3)
                            .y(y - 2)
                            .stack_mode(StackMode::ABOVE),
                    )
                    .is_err()
                {
                    break;
                }
            }
            if conn.flush().is_err() {
                break;
            }
        }
    }
    update_frame(|state| state.visible = false);
    let _ = conn.destroy_window(window);
    let _ = conn.flush();
}
