//! Separate visual cursor; this renderer never dispatches mouse input or activates windows.
#[cfg(windows)]
mod desktop {
    use crate::pointer_motion::PointerMotion;
    mod artwork {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../cursor_raster.rs"
        ));
    }
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows::core::w;
    use windows::Win32::Foundation::{
        GetLastError, COLORREF, ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HWND, LPARAM, LRESULT,
        POINT, SIZE, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::*;

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
                .spawn(move || unsafe {
                    match setup() {
                        Ok((window, hotspot)) => {
                            let _ = ready_tx.send(Ok(()));
                            run(window, hotspot, rx);
                        }
                        Err(error) => {
                            let _ = ready_tx.send(Err(error));
                        }
                    }
                })
                .map_err(|e| e.to_string())?;
            ready_rx.recv().map_err(|e| e.to_string())??;
            *sender = Some(tx);
        }
        if sender
            .as_ref()
            .unwrap()
            .send(Animation {
                motion,
                started: Instant::now(),
            })
            .is_err()
        {
            *sender = None;
            return Err("cursor renderer stopped; no input was dispatched".into());
        }
        Ok(())
    }

    unsafe fn setup() -> Result<(HWND, [i32; 2]), String> {
        let raster = artwork::render(true);
        let name = w!("PiComputerUseAgentCursor");
        let module = HINSTANCE(GetModuleHandleW(None).map_err(|e| e.to_string())?.0);
        let class = WNDCLASSW {
            hInstance: module,
            lpfnWndProc: Some(window_proc),
            lpszClassName: name,
            ..Default::default()
        };
        // A previous worker may have registered the same class before it stopped.
        if RegisterClassW(&class) == 0 && GetLastError() != ERROR_CLASS_ALREADY_EXISTS {
            return Err(windows::core::Error::from_win32().to_string());
        }
        let window = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST,
            name,
            w!("Pi agent cursor"),
            WS_POPUP,
            0,
            0,
            raster.width as i32,
            raster.height as i32,
            None,
            None,
            module,
            None,
        )
        .map_err(|e| e.to_string())?;
        if let Err(error) = paint_alpha(window, &raster) {
            let _ = DestroyWindow(window);
            return Err(error);
        }
        Ok((window, raster.hotspot))
    }

    unsafe extern "system" fn window_proc(
        window: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match message {
            WM_NCHITTEST => LRESULT(HTTRANSPARENT as isize),
            WM_MOUSEACTIVATE => LRESULT(MA_NOACTIVATE as isize),
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }

    unsafe fn paint_alpha(window: HWND, raster: &artwork::Raster) -> Result<(), String> {
        let dc = CreateCompatibleDC(None);
        if dc.0.is_null() {
            return Err(windows::core::Error::from_win32().to_string());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: raster.width as i32,
                biHeight: -(raster.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bitmap) => bitmap,
            Err(error) => {
                let _ = DeleteDC(dc);
                return Err(error.to_string());
            }
        };
        std::ptr::copy_nonoverlapping(
            raster.pixels.as_ptr(),
            bits.cast::<u32>(),
            raster.pixels.len(),
        );
        let previous = SelectObject(dc, bitmap);
        let size = SIZE {
            cx: raster.width as i32,
            cy: raster.height as i32,
        };
        let origin = POINT::default();
        let blend = BLENDFUNCTION {
            BlendOp: AC_SRC_OVER as u8,
            BlendFlags: 0,
            SourceConstantAlpha: 255,
            AlphaFormat: AC_SRC_ALPHA as u8,
        };
        let result = UpdateLayeredWindow(
            window,
            None,
            None,
            Some(&size),
            dc,
            Some(&origin),
            COLORREF(0),
            Some(&blend),
            ULW_ALPHA,
        )
        .map_err(|error| error.to_string());
        let _ = SelectObject(dc, previous);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(dc);
        result
    }

    unsafe fn run(window: HWND, hotspot: [i32; 2], rx: mpsc::Receiver<Animation>) {
        let mut animation: Option<Animation> = None;
        let mut visible = false;
        let mut last_position = None;
        let mut last_frame_started = Instant::now();
        loop {
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                if message.message == WM_QUIT {
                    update_frame(|state| state.visible = false);
                    let _ = DestroyWindow(window);
                    return;
                }
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            let wait = if animation.is_some() {
                Duration::from_millis(15).saturating_sub(last_frame_started.elapsed())
            } else {
                Duration::from_secs(1)
            };
            match rx.recv_timeout(wait) {
                Ok(mut next) => {
                    next.motion.use_visual_origin(last_position);
                    update_frame(|state| state.samples = 0);
                    animation = Some(next);
                    while let Ok(mut next) = rx.try_recv() {
                        next.motion.use_visual_origin(last_position);
                        animation = Some(next);
                    }
                    if !visible {
                        let _ = ShowWindow(window, SW_SHOWNOACTIVATE);
                        visible = true;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            if let Some(current) = &animation {
                let elapsed = current.started.elapsed().as_millis() as u64;
                if elapsed > current.motion.duration_ms + 8000 {
                    let _ = ShowWindow(window, SW_HIDE);
                    animation = None;
                    visible = false;
                    update_frame(|state| state.visible = false);
                } else {
                    last_frame_started = Instant::now();
                    let (x, y) = current.motion.sample(elapsed);
                    last_position = Some((x, y));
                    update_frame(|state| {
                        state.visible = true;
                        state.samples += 1;
                        state.x = x;
                        state.y = y;
                    });
                    if SetWindowPos(
                        window,
                        HWND_TOPMOST,
                        x - hotspot[0],
                        y - hotspot[1],
                        0,
                        0,
                        SWP_NOACTIVATE | SWP_NOSIZE,
                    )
                    .is_err()
                    {
                        break;
                    }
                }
            }
        }
        update_frame(|state| state.visible = false);
        let _ = DestroyWindow(window);
    }
}
#[cfg(windows)]
pub use desktop::{animate, status};
#[cfg(not(windows))]
pub fn animate(_: Vec<(i32, i32)>, _: u64) -> Result<(), String> {
    Err("Windows desktop cursor is unavailable on this platform".into())
}

#[cfg(not(windows))]
pub fn status() -> serde_json::Value {
    serde_json::json!({"visible":false,"samples":0})
}
