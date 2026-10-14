//! Separate visual cursor; this renderer never dispatches mouse input or activates windows.
#[cfg(windows)]
mod desktop {
    use crate::pointer_motion::PointerMotion;
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows::core::w;
    use windows::Win32::Foundation::{
        GetLastError, COLORREF, ERROR_CLASS_ALREADY_EXISTS, HINSTANCE, HWND, LPARAM, LRESULT,
        POINT, WPARAM,
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
                        Ok(window) => {
                            let _ = ready_tx.send(Ok(()));
                            run(window, rx);
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

    unsafe fn setup() -> Result<HWND, String> {
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
            34,
            36,
            None,
            None,
            module,
            None,
        )
        .map_err(|e| e.to_string())?;
        if let Err(error) = SetLayeredWindowAttributes(window, COLORREF(0), 255, LWA_COLORKEY) {
            let _ = DestroyWindow(window);
            return Err(error.to_string());
        }
        Ok(window)
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
            WM_PAINT => {
                let mut paint = PAINTSTRUCT::default();
                let dc = BeginPaint(window, &mut paint);
                let rect = windows::Win32::Foundation::RECT {
                    left: 0,
                    top: 0,
                    right: 34,
                    bottom: 36,
                };
                let black = CreateSolidBrush(COLORREF(0));
                let _ = FillRect(dc, &rect, black);
                // Shared geometry and palette: src/agent-cursor-style.json.
                let no_pen = GetStockObject(NULL_PEN);
                let old_pen = SelectObject(dc, no_pen);
                {
                    let brush = CreateSolidBrush(COLORREF(0x00951d4c));
                    let old_brush = SelectObject(dc, brush);
                    let points = [
                        POINT { x: 3, y: 0 },
                        POINT { x: 2, y: 0 },
                        POINT { x: 1, y: 0 },
                        POINT { x: 1, y: 1 },
                        POINT { x: 1, y: 2 },
                        POINT { x: 10, y: 32 },
                        POINT { x: 10, y: 33 },
                        POINT { x: 10, y: 34 },
                        POINT { x: 11, y: 34 },
                        POINT { x: 17, y: 20 },
                        POINT { x: 18, y: 20 },
                        POINT { x: 18, y: 19 },
                        POINT { x: 19, y: 18 },
                        POINT { x: 30, y: 11 },
                        POINT { x: 31, y: 11 },
                        POINT { x: 30, y: 10 },
                        POINT { x: 29, y: 10 },
                    ];
                    let _ = Polygon(dc, &points);
                    let _ = SelectObject(dc, old_brush);
                    let _ = DeleteObject(brush);
                }
                {
                    let brush = CreateSolidBrush(COLORREF(0x00ffffff));
                    let old_brush = SelectObject(dc, brush);
                    let points = [
                        POINT { x: 4, y: 1 },
                        POINT { x: 3, y: 1 },
                        POINT { x: 2, y: 1 },
                        POINT { x: 2, y: 2 },
                        POINT { x: 2, y: 3 },
                        POINT { x: 10, y: 31 },
                        POINT { x: 10, y: 32 },
                        POINT { x: 11, y: 32 },
                        POINT { x: 17, y: 20 },
                        POINT { x: 17, y: 19 },
                        POINT { x: 18, y: 18 },
                        POINT { x: 19, y: 18 },
                        POINT { x: 29, y: 11 },
                        POINT { x: 29, y: 10 },
                        POINT { x: 28, y: 10 },
                        POINT { x: 27, y: 10 },
                    ];
                    let _ = Polygon(dc, &points);
                    let _ = SelectObject(dc, old_brush);
                    let _ = DeleteObject(brush);
                }
                {
                    let brush = CreateSolidBrush(COLORREF(0x00f65c8b));
                    let old_brush = SelectObject(dc, brush);
                    let points = [
                        POINT { x: 6, y: 4 },
                        POINT { x: 5, y: 4 },
                        POINT { x: 4, y: 4 },
                        POINT { x: 5, y: 5 },
                        POINT { x: 10, y: 26 },
                        POINT { x: 11, y: 27 },
                        POINT { x: 16, y: 18 },
                        POINT { x: 16, y: 17 },
                        POINT { x: 17, y: 17 },
                        POINT { x: 24, y: 11 },
                        POINT { x: 23, y: 10 },
                    ];
                    let _ = Polygon(dc, &points);
                    let _ = SelectObject(dc, old_brush);
                    let _ = DeleteObject(brush);
                }
                let _ = SelectObject(dc, old_pen);
                let _ = DeleteObject(black);
                let _ = EndPaint(window, &paint);
                LRESULT(0)
            }
            _ => DefWindowProcW(window, message, wparam, lparam),
        }
    }

    unsafe fn run(window: HWND, rx: mpsc::Receiver<Animation>) {
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
                        x - 3,
                        y - 2,
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
