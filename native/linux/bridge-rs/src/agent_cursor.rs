//! Visual-only desktop cursor. All X resources belong to a dedicated connection;
//! no XTEST events, focus requests, or pointer warps are issued by this module.
use crate::pointer_motion::PointerMotion;
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::{render, shape, xproto::*};
#[path = "../../../cursor_raster.rs"]
mod artwork;
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
                    Ok((conn, window, hotspot)) => {
                        let _ = ready_tx.send(Ok(()));
                        run(conn, window, hotspot, rx);
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

fn setup() -> Result<(x11rb::rust_connection::RustConnection, Window, [i32; 2]), String> {
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
    let selection = conn
        .intern_atom(false, format!("_NET_WM_CM_S{screen_index}").as_bytes())
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .atom;
    let composited = conn
        .get_selection_owner(selection)
        .map_err(|e| e.to_string())?
        .reply()
        .map_err(|e| e.to_string())?
        .owner
        != x11rb::NONE;
    let formats = if composited {
        render::query_pict_formats(&conn)
            .ok()
            .and_then(|c| c.reply().ok())
    } else {
        None
    };
    let argb_visual = formats.as_ref().and_then(|formats| {
        let ids: Vec<_> = formats
            .formats
            .iter()
            .filter(|f| {
                f.depth == 32
                    && f.type_ == render::PictType::DIRECT
                    && f.direct.alpha_mask == 255
                    && f.direct.alpha_shift == 24
                    && f.direct.red_mask == 255
                    && f.direct.red_shift == 16
                    && f.direct.green_mask == 255
                    && f.direct.green_shift == 8
                    && f.direct.blue_mask == 255
                    && f.direct.blue_shift == 0
            })
            .map(|f| f.id)
            .collect();
        formats
            .screens
            .get(screen_index)?
            .depths
            .iter()
            .flat_map(|d| &d.visuals)
            .find(|v| ids.contains(&v.format))
            .map(|v| v.visual)
    });
    let glow = argb_visual.is_some();
    let raster = artwork::render(glow);
    let hotspot = raster.hotspot;
    let visual_id = argb_visual.unwrap_or(screen.root_visual);
    let depth = if glow { 32 } else { screen.root_depth };
    let visual = screen
        .allowed_depths
        .iter()
        .flat_map(|d| &d.visuals)
        .find(|v| v.visual_id == visual_id)
        .ok_or("cursor visual unavailable")?;
    let window = conn.generate_id().map_err(|e| e.to_string())?;
    let pixels = conn.generate_id().map_err(|e| e.to_string())?;
    let gc = conn.generate_id().map_err(|e| e.to_string())?;
    let colormap = conn.generate_id().map_err(|e| e.to_string())?;
    conn.create_colormap(ColormapAlloc::NONE, colormap, screen.root, visual_id)
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    conn.create_pixmap(depth, pixels, screen.root, raster.width, raster.height)
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    conn.create_gc(gc, pixels, &CreateGCAux::new())
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    let format = conn
        .setup()
        .pixmap_formats
        .iter()
        .find(|f| f.depth == depth)
        .ok_or("cursor pixmap format unavailable")?;
    let bytes_per_pixel = usize::from(format.bits_per_pixel) / 8;
    if ![2, 3, 4].contains(&bytes_per_pixel) {
        return Err("unsupported cursor pixel format".into());
    }
    let stride = (usize::from(raster.width) * usize::from(format.bits_per_pixel))
        .div_ceil(usize::from(format.scanline_pad))
        * usize::from(format.scanline_pad)
        / 8;
    let mut data = vec![0; stride * usize::from(raster.height)];
    let channel = |value: u32, mask: u32| -> u32 {
        if mask == 0 {
            return 0;
        }
        let shift = mask.trailing_zeros();
        ((value * (mask >> shift) + 127) / 255) << shift
    };
    let unpremultiply =
        |value: u32, alpha: u32| (value * 255).checked_div(alpha).unwrap_or(0).min(255);
    for (i, &pixel) in raster.pixels.iter().enumerate() {
        let pixel = if glow {
            pixel
        } else {
            channel(
                unpremultiply((pixel >> 16) & 255, pixel >> 24),
                visual.red_mask,
            ) | channel(
                unpremultiply((pixel >> 8) & 255, pixel >> 24),
                visual.green_mask,
            ) | channel(unpremultiply(pixel & 255, pixel >> 24), visual.blue_mask)
        };
        let offset = (i / usize::from(raster.width)) * stride
            + (i % usize::from(raster.width)) * bytes_per_pixel;
        if conn.setup().image_byte_order == ImageOrder::LSB_FIRST {
            data[offset..offset + bytes_per_pixel]
                .copy_from_slice(&pixel.to_le_bytes()[..bytes_per_pixel]);
        } else {
            data[offset..offset + bytes_per_pixel]
                .copy_from_slice(&pixel.to_be_bytes()[4 - bytes_per_pixel..]);
        }
    }
    conn.put_image(
        ImageFormat::Z_PIXMAP,
        pixels,
        gc,
        raster.width,
        raster.height,
        0,
        0,
        0,
        depth,
        &data,
    )
    .map_err(|e| e.to_string())?
    .check()
    .map_err(|e| e.to_string())?;
    conn.create_window(
        depth,
        window,
        screen.root,
        0,
        0,
        raster.width,
        raster.height,
        0,
        WindowClass::INPUT_OUTPUT,
        visual_id,
        &CreateWindowAux::new()
            .override_redirect(1)
            .background_pixmap(pixels)
            .border_pixel(0)
            .colormap(colormap),
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
    // Without a compositor, keep a shaped arrow instead of an opaque halo rectangle.
    if !glow {
        let rectangles: Vec<_> = raster
            .pixels
            .iter()
            .enumerate()
            .filter(|(_, pixel)| (**pixel >> 24) >= 128)
            .map(|(i, _)| Rectangle {
                x: (i % usize::from(raster.width)) as i16,
                y: (i / usize::from(raster.width)) as i16,
                width: 1,
                height: 1,
            })
            .collect();
        shape::rectangles(
            &conn,
            shape::SO::SET,
            shape::SK::BOUNDING,
            ClipOrdering::UNSORTED,
            window,
            0,
            0,
            &rectangles,
        )
        .map_err(|e| e.to_string())?
        .check()
        .map_err(|e| e.to_string())?;
    }
    // Empty input shape applies to both the arrow and its full halo surface.
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
    conn.free_gc(gc).map_err(|e| e.to_string())?;
    conn.free_pixmap(pixels).map_err(|e| e.to_string())?;
    // Keep the colormap alive with the window; closing this dedicated connection frees it.
    conn.flush().map_err(|e| e.to_string())?;
    Ok((conn, window, hotspot))
}

fn run(
    conn: x11rb::rust_connection::RustConnection,
    window: Window,
    hotspot: [i32; 2],
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
                            .x(x - hotspot[0])
                            .y(y - hotspot[1])
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
