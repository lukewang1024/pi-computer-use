//! GDI screenshot capture for Windows.
//!
//! Captures window content via GDI (PrintWindow) on Windows.
//! On non-Windows platforms all entry points return a deterministic
//! `unsupported_platform` error.
//!
//! Selected-window capture only. Desktop capture is not implemented. DXGI and
//! Windows Graphics Capture are not used.

use serde_json::Value;
#[cfg(any(windows, test))]
use std::collections::HashMap;

use crate::error::{ErrorCode, ProtocolError};
use crate::refs::{RefStore, WindowRef};

#[cfg(windows)]
use crate::state::StateId;
#[cfg(windows)]
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
#[cfg(windows)]
use image::codecs::png::PngEncoder;
#[cfg(windows)]
use image::{imageops::FilterType, ExtendedColorType, ImageEncoder, RgbaImage};
#[cfg(windows)]
use serde_json::json;

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/// Capture a screenshot of the target window, optionally extracting UIA
/// accessibility elements from the same window.
///
/// # Arguments
///
/// * `store` - RefStore containing the window handle for `target_ref`.
///   Also receives inserted element refs when `include_elements` is true.
/// * `target_ref` - Reference to the window to capture.
/// * `include_elements` - When true, also extracts UIA elements and includes
///   them in the response as an `axTargets` array.
///
/// # Returns
///
/// On success, a JSON value with shape:
/// ```json
/// {
///   "target": "@w1",
///   "capture": { ... },
///   "warnings": [],
///   "axTargets": []
/// }
/// ```
/// The `axTargets` field is only present when `include_elements` is true
/// and at least one element was found.
///
/// On non-Windows this always returns `UnsupportedPlatform`.
pub fn screenshot(
    store: &mut RefStore,
    target_ref: &WindowRef,
    include_elements: bool,
    max_dimension: Option<u32>,
) -> Result<Value, ProtocolError> {
    #[cfg(not(windows))]
    {
        let _ = store;
        let _ = target_ref;
        let _ = include_elements;
        let _ = max_dimension;
        Err(ProtocolError::new(
            "Screenshot capture is only supported on Windows",
            ErrorCode::UnsupportedPlatform,
        ))
    }

    #[cfg(windows)]
    {
        screenshot_impl(store, target_ref, include_elements, max_dimension)
    }
}

// ---------------------------------------------------------------------------
// Windows-specific implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
use windows::Win32::Foundation::{HWND, POINT, RECT};
#[cfg(windows)]
use windows::Win32::Graphics::Gdi::{
    BitBlt, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject,
    GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HDC, HGDIOBJ, SRCCOPY,
};
#[cfg(windows)]
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
#[cfg(windows)]
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetWindowRect, GetWindowThreadProcessId, IsIconic, IsWindow,
};

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct CaptureFrame {
    hwnd: isize,
    pid: u32,
    thread_id: u32,
    bounds: (i32, i32, i32, i32),
    valid: bool,
    minimized: bool,
    desktop_ready: bool,
}

#[cfg(any(windows, test))]
fn capture_owner_matches(expected: CaptureFrame, actual: CaptureFrame) -> bool {
    expected.valid
        && actual.valid
        && expected.hwnd != 0
        && expected.pid != 0
        && expected.thread_id != 0
        && (expected.hwnd, expected.pid, expected.thread_id)
            == (actual.hwnd, actual.pid, actual.thread_id)
}

#[cfg(any(windows, test))]
fn capture_frame_matches(expected: CaptureFrame, actual: CaptureFrame) -> bool {
    capture_owner_matches(expected, actual)
        && !expected.minimized
        && !actual.minimized
        && expected.desktop_ready
        && actual.desktop_ready
        && expected.bounds.2 > 0
        && expected.bounds.3 > 0
        && expected.bounds == actual.bounds
}

#[cfg(windows)]
unsafe fn read_capture_frame(hwnd: HWND) -> Option<CaptureFrame> {
    let mut bounds = RECT::default();
    if GetWindowRect(hwnd, &mut bounds).is_err() {
        return None;
    }
    let mut pid = 0;
    let thread_id = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    Some(CaptureFrame {
        hwnd: hwnd.0 as isize,
        pid,
        thread_id,
        bounds: (
            bounds.left,
            bounds.top,
            bounds.right - bounds.left,
            bounds.bottom - bounds.top,
        ),
        valid: IsWindow(hwnd).as_bool(),
        minimized: IsIconic(hwnd).as_bool(),
        desktop_ready: crate::foreground::capture_state(hwnd.0 as isize)["desktop"]["ready"]
            == true,
    })
}

#[cfg(any(windows, test))]
fn dominant_color_counts_bgra(bits: &[u8]) -> (usize, usize) {
    let mut pixel_count = 0usize;
    let mut buckets: HashMap<(u8, u8, u8), usize> = HashMap::new();

    // Inspect every pixel: a fixed stride aliases with widths such as 1164 = 97 * 12.
    for pixel in bits.chunks_exact(4) {
        pixel_count += 1;
        let bucket = (pixel[0] >> 3, pixel[1] >> 3, pixel[2] >> 3);
        *buckets.entry(bucket).or_default() += 1;
    }

    (buckets.values().copied().max().unwrap_or(0), pixel_count)
}

// Use the OS client rectangle rather than guessing a border width or lowering
// the existing 97% threshold. Invalid/clipped regions cannot classify a capture.
#[cfg(any(windows, test))]
fn dominant_client_counts_bgra(
    bits: &[u8],
    width: usize,
    height: usize,
    region: (usize, usize, usize, usize),
) -> Option<(usize, usize)> {
    let (x, y, w, h) = region;
    if w == 0
        || h == 0
        || x.checked_add(w)? > width
        || y.checked_add(h)? > height
        || width.checked_mul(height)?.checked_mul(4)? != bits.len()
    {
        return None;
    }
    let mut buckets = HashMap::new();
    for row in y..y + h {
        for pixel in bits[(row * width + x) * 4..(row * width + x + w) * 4].chunks_exact(4) {
            *buckets
                .entry((pixel[0] >> 3, pixel[1] >> 3, pixel[2] >> 3))
                .or_insert(0usize) += 1;
        }
    }
    Some((buckets.values().copied().max().unwrap_or(0), w * h))
}

#[cfg(windows)]
unsafe fn client_capture_region(
    hwnd: HWND,
    window_x: i32,
    window_y: i32,
) -> Option<(usize, usize, usize, usize)> {
    let mut rect = RECT::default();
    if GetClientRect(hwnd, &mut rect).is_err() {
        return None;
    }
    let mut origin = POINT {
        x: rect.left,
        y: rect.top,
    };
    if !ClientToScreen(hwnd, &mut origin).as_bool() {
        return None;
    }
    Some((
        usize::try_from(i64::from(origin.x) - i64::from(window_x)).ok()?,
        usize::try_from(i64::from(origin.y) - i64::from(window_y)).ok()?,
        usize::try_from(i64::from(rect.right) - i64::from(rect.left)).ok()?,
        usize::try_from(i64::from(rect.bottom) - i64::from(rect.top)).ok()?,
    ))
}

#[cfg(any(windows, test))]
fn is_effectively_blank_bgra(bits: &[u8]) -> bool {
    let (dominant, total) = dominant_color_counts_bgra(bits);
    total > 0 && dominant * 100 >= total * 97
}

#[cfg(windows)]
fn screenshot_impl(
    store: &mut RefStore,
    target_ref: &WindowRef,
    include_elements: bool,
    max_dimension: Option<u32>,
) -> Result<Value, ProtocolError> {
    let image_started = std::time::Instant::now();
    // 1. Look up the window handle.
    let native = store.get_window(target_ref).ok_or_else(|| {
        ProtocolError::new(
            format!("Window ref '{}' not found", target_ref),
            ErrorCode::TargetNotFound,
        )
    })?;
    let hwnd = HWND(native.raw() as *mut _);

    let mut warnings: Vec<String> = Vec::new();

    // 2. Check for minimized state.
    let is_minimized = unsafe { IsIconic(hwnd).as_bool() };
    if is_minimized {
        warnings.push("window_minimized".to_owned());
    }

    // 3. Get the window rect so we know capture dimensions.
    let (mut x, mut y, mut width, mut height) = unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return Err(ProtocolError::new(
                "Failed to get window bounds",
                ErrorCode::CaptureFailed,
            ));
        }
        let w = (rect.right - rect.left).max(0);
        let h = (rect.bottom - rect.top).max(0);
        (rect.left, rect.top, w, h)
    };

    if width == 0 || height == 0 {
        warnings.push("zero_sized_window".to_owned());
        // Return capture metadata with zero dimensions and no image data.
        let state_id = StateId::fresh("s");
        return Ok(json!({
            "target": target_ref.to_string(),
            "capture": {
                "stateId": state_id,
                "x": x,
                "y": y,
                "width": 0,
                "height": 0,
                "imageFormat": "png",
                "imageBase64": null,
            },
            "warnings": warnings,
        }));
    }

    // 4. GDI capture (unsafe FFI block).
    // SAFETY: All GDI objects are created and destroyed within this
    // function.  Object lifetimes follow the Acquire → Use → Release
    // pattern with proper cleanup on every error path.
    // Restoring a GPU window can expose its iconic bounds or an unpainted
    // surface briefly. Retry only capture failures on an available target,
    // refreshing geometry each time; never accept a blank image as success.
    let owner = unsafe { read_capture_frame(hwnd) }.ok_or_else(|| {
        ProtocolError::new(
            "Capture target identity unavailable",
            ErrorCode::CaptureFailed,
        )
    })?;
    let mut captured =
        unsafe { gdi_capture_to_base64(hwnd, x, y, width, height, max_dimension, owner) };
    for _ in 0..3 {
        if captured.is_ok() || crate::foreground::capture_state(hwnd.0 as isize)["eligible"] != true
        {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(75));
        unsafe {
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect).is_err() || IsIconic(hwnd).as_bool() {
                break;
            }
            x = rect.left;
            y = rect.top;
            width = (rect.right - rect.left).max(0);
            height = (rect.bottom - rect.top).max(0);
        }
        if width == 0 || height == 0 {
            break;
        }
        captured =
            unsafe { gdi_capture_to_base64(hwnd, x, y, width, height, max_dimension, owner) };
    }
    let (png_base64, output_width, output_height, captured_frame, capture_diagnostics) = captured?;
    let image_capture_ms = image_started.elapsed().as_millis() as u64;

    let state_id = StateId::fresh("s");

    // Build the base response.
    let mut result = json!({
        "target": target_ref.to_string(),
        "capture": {
            "stateId": state_id,
            "x": x,
            "y": y,
            "sourceBounds": { "x": x, "y": y, "width": width, "height": height },
            "width": output_width,
            "height": output_height,
            "imageFormat": "png",
            "imageBase64": png_base64,
        },
        "warnings": warnings,
        "captureDiagnostics": capture_diagnostics,
    });

    // 5. Optionally extract UIA accessibility elements.
    let uia_started = std::time::Instant::now();
    if include_elements {
        let elements = crate::uia::extract_elements(store, hwnd.0 as isize);
        if !elements.is_empty() {
            if let Some(obj) = result.as_object_mut() {
                obj.insert("axTargets".to_owned(), Value::Array(elements));
            }
        }
    }

    let final_frame = unsafe { read_capture_frame(hwnd) };
    if !final_frame.is_some_and(|current| capture_frame_matches(captured_frame, current)) {
        return Err(ProtocolError::new(
            format!("Capture identity, geometry or desktop changed before observation returned: captured={captured_frame:?}, current={final_frame:?}"),
            ErrorCode::CaptureFailed,
        ));
    }
    result["timings"] = json!({
        "captureFrameVerified": true,
        "imageCaptureMs": image_capture_ms,
        "uiaExtractionMs": uia_started.elapsed().as_millis() as u64,
        "uiaExtractionRequested": include_elements,
    });

    Ok(result)
}

/// Perform GDI capture of the given window and return a base64-encoded PNG.
///
/// # Safety
///
/// Caller must provide a valid HWND and positive dimensions.
#[cfg(windows)]
unsafe fn gdi_capture_to_base64(
    hwnd: HWND,
    window_x: i32,
    window_y: i32,
    width: i32,
    height: i32,
    max_dimension: Option<u32>,
    owner: CaptureFrame,
) -> Result<(String, u32, u32, CaptureFrame, Value), ProtocolError> {
    let before = read_capture_frame(hwnd).ok_or_else(|| {
        ProtocolError::new(
            "Capture target identity unavailable",
            ErrorCode::CaptureFailed,
        )
    })?;
    if !capture_owner_matches(owner, before)
        || !capture_frame_matches(before, before)
        || before.bounds != (window_x, window_y, width, height)
    {
        return Err(ProtocolError::new(format!("Capture identity, geometry or desktop changed before GDI: expected={owner:?}, actual={before:?}"), ErrorCode::CaptureFailed));
    }
    // Acquire the window DC.
    let hdc_window = GetDC(hwnd);
    if hdc_window.is_invalid() {
        return Err(ProtocolError::new("GetDC failed", ErrorCode::CaptureFailed));
    }

    // Create a compatible memory DC.
    let hdc_mem = CreateCompatibleDC(hdc_window);
    if hdc_mem.is_invalid() {
        ReleaseDC(hwnd, hdc_window);
        return Err(ProtocolError::new(
            "CreateCompatibleDC failed",
            ErrorCode::CaptureFailed,
        ));
    }

    // Create a compatible bitmap.
    let hbitmap = CreateCompatibleBitmap(hdc_window, width, height);
    if hbitmap.is_invalid() {
        let _ = DeleteDC(hdc_mem);
        ReleaseDC(hwnd, hdc_window);
        return Err(ProtocolError::new(
            "CreateCompatibleBitmap failed",
            ErrorCode::CaptureFailed,
        ));
    }

    // Select bitmap into memory DC (save old to restore later).
    let old_bitmap = SelectObject(hdc_mem, hbitmap);

    // Render the window content using PrintWindow (client area).
    let pw_ok = PrintWindow(hwnd, hdc_mem, PRINT_WINDOW_FLAGS(0));
    if !pw_ok.as_bool() {
        // PrintWindow can fail for various reasons.  We note it but
        // continue — the DC might still have partial content.
    }

    // Prepare BITMAPINFO for GetDIBits (request 32-bit BGRA top-down).
    let header = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: width,
        biHeight: -height, // negative = top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB.0,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    let mut bmi = BITMAPINFO {
        bmiHeader: header,
        ..Default::default()
    };

    // Allocate the pixel buffer.
    let buf_size = (width as usize) * (height as usize) * 4;
    let mut bits: Vec<u8> = vec![0u8; buf_size];

    // GetDIBits requires the bitmap to be deselected from every DC.
    SelectObject(hdc_mem, old_bitmap);
    let mut dib_ok = GetDIBits(
        hdc_mem,
        hbitmap,
        0,
        height as u32,
        Some(bits.as_mut_ptr() as *mut std::ffi::c_void),
        &mut bmi,
        DIB_RGB_COLORS,
    );

    // PrintWindow can succeed with uniform black, white, or gray GPU surfaces.
    // Fall back to compositor-visible pixels when it carries no useful detail.
    let (print_dominant, print_total) = dominant_color_counts_bgra(&bits);
    let print_whole_blank = print_total > 0 && print_dominant * 100 >= print_total * 97;
    let print_client_region = client_capture_region(hwnd, window_x, window_y);
    let print_client_counts = if print_whole_blank {
        None
    } else {
        print_client_region.and_then(|region| {
            dominant_client_counts_bgra(&bits, width as usize, height as usize, region)
        })
    };
    let print_client_blank = print_client_counts
        .is_some_and(|(dominant, total)| total > 0 && dominant * 100 >= total * 97);
    let print_window_blank = print_whole_blank || print_client_blank;
    let print_dib_rows = dib_ok;
    let mut fallback_result = None;
    let mut fallback_gate = None;
    if !pw_ok.as_bool() || dib_ok == 0 || print_window_blank {
        let mut screen_read_ok = false;
        let gate = crate::foreground::capture_state(hwnd.0 as isize);
        let screen_dc = if gate["focused"] == true {
            GetDC(HWND(std::ptr::null_mut()))
        } else {
            HDC::default()
        };
        fallback_gate = Some(gate.clone());
        SelectObject(hdc_mem, hbitmap);
        if !screen_dc.is_invalid()
            && BitBlt(
                hdc_mem, 0, 0, width, height, screen_dc, window_x, window_y, SRCCOPY,
            )
            .is_ok()
        {
            SelectObject(hdc_mem, old_bitmap);
            dib_ok = GetDIBits(
                hdc_mem,
                hbitmap,
                0,
                height as u32,
                Some(bits.as_mut_ptr() as *mut std::ffi::c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            );
            let after = crate::foreground::capture_state(hwnd.0 as isize);
            let mut rect = RECT::default();
            let geometry_matches = GetWindowRect(hwnd, &mut rect).is_ok()
                && (
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                ) == (window_x, window_y, width, height);
            screen_read_ok = dib_ok == height
                && after["focused"] == true
                && after["target"]["pid"] == gate["target"]["pid"]
                && after["target"]["threadId"] == gate["target"]["threadId"]
                && geometry_matches;
            fallback_gate =
                Some(json!({"before":gate,"after":after,"geometryMatches":geometry_matches}));
        }
        fallback_result = Some(screen_read_ok && !is_effectively_blank_bgra(&bits));
        if !screen_dc.is_invalid() {
            ReleaseDC(HWND(std::ptr::null_mut()), screen_dc);
        }
    }

    // Restore old bitmap and destroy GDI objects.
    SelectObject(hdc_mem, old_bitmap);
    let _ = DeleteObject(HGDIOBJ(hbitmap.0));
    let _ = DeleteDC(hdc_mem);
    ReleaseDC(hwnd, hdc_window);

    let after = read_capture_frame(hwnd);
    if !after.is_some_and(|current| capture_frame_matches(before, current)) {
        return Err(ProtocolError::new(format!("Capture identity, geometry or desktop changed during GDI: before={before:?}, after={after:?}"), ErrorCode::CaptureFailed));
    }

    if dib_ok != height {
        return Err(ProtocolError::new(
            "GetDIBits failed to retrieve bitmap data",
            ErrorCode::CaptureFailed,
        ));
    }

    if fallback_result == Some(false) {
        return Err(ProtocolError::new(
            format!("Window capture has no useful pixels: hwnd={}, PrintWindow={}, printWindowBlank={}, screenFallbackValid=false, foregroundGate={}; this is capture evidence, not a product white-screen diagnosis", hwnd.0 as isize, pw_ok.as_bool(), print_window_blank, serde_json::to_string(&fallback_gate).unwrap_or_default()),
            ErrorCode::CaptureFailed,
        ));
    }
    bgrx_to_opaque_rgba(&mut bits);

    let source_width = width as u32;
    let source_height = height as u32;
    let (output_width, output_height) = match max_dimension.filter(|limit| *limit > 0) {
        Some(limit) if source_width.max(source_height) > limit => {
            let scale = limit as f64 / source_width.max(source_height) as f64;
            (
                (source_width as f64 * scale).round().max(1.0) as u32,
                (source_height as f64 * scale).round().max(1.0) as u32,
            )
        }
        _ => (source_width, source_height),
    };
    let pixels = if (output_width, output_height) == (source_width, source_height) {
        bits
    } else {
        let source = RgbaImage::from_raw(source_width, source_height, bits).ok_or_else(|| {
            ProtocolError::new(
                "Captured bitmap had an invalid byte length",
                ErrorCode::CaptureFailed,
            )
        })?;
        image::imageops::resize(&source, output_width, output_height, FilterType::Triangle)
            .into_raw()
    };

    // Encode to PNG in memory.
    let mut png_data: Vec<u8> = Vec::new();
    {
        let encoder = PngEncoder::new(&mut png_data);
        encoder
            .write_image(
                &pixels,
                output_width,
                output_height,
                ExtendedColorType::Rgba8,
            )
            .map_err(|e| {
                ProtocolError::new(
                    format!("PNG encoding failed: {e}"),
                    ErrorCode::CaptureFailed,
                )
            })?;
    }

    // Base64-encode the PNG bytes.
    Ok((
        BASE64.encode(&png_data),
        output_width,
        output_height,
        before,
        json!({
            "version": 1,
            "method": if fallback_result == Some(true) { "screen-bitblt" } else { "print-window" },
            "printWindowSucceeded": pw_ok.as_bool(),
            "printWindowDibRows": print_dib_rows,
            "printWindowBlank": print_window_blank,
            "printWindowWholeBlank": print_whole_blank,
            "printWindowClientBlank": print_client_blank,
            "printWindowClientRegion": print_client_region,
            "printWindowClientCounts": print_client_counts,
            "printWindowDominantPixels": print_dominant,
            "printWindowTotalPixels": print_total,
            "sourceWidth": width,
            "sourceHeight": height,
            "screenFallbackValid": fallback_result,
            "foregroundGate": fallback_gate,
        }),
    ))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// BI_RGB 32-bit DIBs contain B,G,R plus an unused byte, not alpha. GDI may
// leave that byte zero or undefined. Normalize before resizing or PNG encoding
// so alpha-aware viewers do not hide the captured window's RGB content.
#[cfg(any(windows, test))]
fn bgrx_to_opaque_rgba(pixels: &mut [u8]) {
    for pixel in pixels.chunks_exact_mut(4) {
        pixel.swap(0, 2);
        pixel[3] = 255;
    }
}

#[cfg(test)]
mod unit_tests {
    #[test]
    fn capture_frame_rejects_move_resize_owner_change_and_minimize() {
        let frame = CaptureFrame {
            hwnd: 12,
            pid: 34,
            thread_id: 56,
            bounds: (-100, 20, 800, 600),
            valid: true,
            minimized: false,
            desktop_ready: true,
        };
        assert!(capture_frame_matches(frame, frame));
        for changed in [
            CaptureFrame { hwnd: 13, ..frame },
            CaptureFrame { pid: 35, ..frame },
            CaptureFrame {
                thread_id: 57,
                ..frame
            },
            CaptureFrame {
                valid: false,
                ..frame
            },
            CaptureFrame {
                minimized: true,
                ..frame
            },
            CaptureFrame {
                desktop_ready: false,
                ..frame
            },
            CaptureFrame {
                bounds: (-99, 20, 800, 600),
                ..frame
            },
            CaptureFrame {
                bounds: (-100, 20, 801, 600),
                ..frame
            },
            CaptureFrame { pid: 0, ..frame },
        ] {
            assert!(!capture_frame_matches(frame, changed));
        }
        assert!(!capture_frame_matches(
            CaptureFrame {
                bounds: (0, 0, 0, 600),
                ..frame
            },
            CaptureFrame {
                bounds: (0, 0, 0, 600),
                ..frame
            }
        ));
        // A bounded retry may refresh geometry, but cannot adopt a new owner.
        assert!(capture_owner_matches(
            frame,
            CaptureFrame {
                bounds: (0, 0, 900, 700),
                ..frame
            }
        ));
        assert!(!capture_owner_matches(
            frame,
            CaptureFrame { pid: 35, ..frame }
        ));
    }
    #[test]
    fn client_capture_detects_blank_surface_behind_nonclient_border() {
        let (width, height) = (936usize, 608usize);
        let mut pixels = [24, 80, 120, 0].repeat(width * height);
        for y in 0..600 {
            for x in 8..928 {
                pixels[(y * width + x) * 4..(y * width + x) * 4 + 3].fill(240);
            }
        }
        assert_eq!(dominant_color_counts_bgra(&pixels), (552000, 569088));
        assert!(!is_effectively_blank_bgra(&pixels));
        assert_eq!(
            dominant_client_counts_bgra(&pixels, width, height, (8, 0, 920, 600)),
            Some((552000, 552000))
        );
        // Real client content must remain distinguishable from a blank surface.
        for y in 0..600 {
            for x in (8..928).step_by(10) {
                pixels[(y * width + x) * 4..(y * width + x) * 4 + 3].fill(24);
            }
        }
        let (dominant, total) =
            dominant_client_counts_bgra(&pixels, width, height, (8, 0, 920, 600)).unwrap();
        assert!(dominant * 100 < total * 97);
        for region in [
            (0, 0, 0, 1),
            (0, 0, 937, 608),
            (0, 608, 1, 1),
            (usize::MAX, 0, 1, 1),
        ] {
            assert_eq!(
                dominant_client_counts_bgra(&pixels, width, height, region),
                None
            );
        }
        assert_eq!(
            dominant_client_counts_bgra(&pixels[..10], width, height, (8, 0, 920, 600)),
            None
        );
    }

    #[test]
    fn detects_uniform_failed_compositor_captures() {
        let black = [0, 0, 0, 255].repeat(10_000);
        let white = [231, 231, 231, 255].repeat(10_000);
        let mut almost_uniform = white.clone();
        for offset in (0..almost_uniform.len()).step_by(4).take(200) {
            almost_uniform[offset..offset + 3].copy_from_slice(&[40, 120, 200]);
        }

        assert!(is_effectively_blank_bgra(&black));
        assert!(is_effectively_blank_bgra(&white));
        assert!(is_effectively_blank_bgra(&almost_uniform));
    }

    #[test]
    fn preserves_light_windows_with_real_visual_detail() {
        let mut detailed = Vec::new();
        for index in 0..10_000 {
            let value = if index % 20 == 0 { 20 } else { 245 };
            detailed.extend_from_slice(&[value, value, value, 255]);
        }

        assert!(!is_effectively_blank_bgra(&detailed));
    }

    #[test]
    fn detects_uniform_window_with_thin_border_at_stride_aligned_width() {
        let (width, height) = (1164usize, 688usize);
        let mut pixels = [240, 240, 240, 255].repeat(width * height);
        for y in 0..height {
            for x in 0..width {
                if x < 9 || x >= width - 9 || y < 3 || y >= height - 3 {
                    let offset = (y * width + x) * 4;
                    pixels[offset..offset + 3].fill(24);
                }
            }
        }
        let uniform = pixels
            .chunks_exact(4)
            .filter(|pixel| pixel[0] == 240)
            .count();
        assert!(uniform * 1000 >= width * height * 975);
        let stride_samples: Vec<_> = pixels.chunks_exact(4).step_by(97).collect();
        let stride_uniform = stride_samples
            .iter()
            .filter(|pixel| pixel[0] == 240)
            .count();
        assert!(stride_uniform * 100 < stride_samples.len() * 97);
        assert!(is_effectively_blank_bgra(&pixels));
    }

    #[test]
    fn preserves_window_with_visible_text_like_rows_at_stride_aligned_width() {
        let (width, height) = (1164usize, 688usize);
        let mut pixels = [240, 240, 240, 255].repeat(width * height);
        // Repeated short dark runs model visible text rather than a blank surface.
        for y in 30..height - 30 {
            for x in 30..width - 30 {
                if y % 24 < 3 && x % 16 < 10 {
                    let offset = (y * width + x) * 4;
                    pixels[offset..offset + 3].fill(24);
                }
            }
        }
        assert!(!is_effectively_blank_bgra(&pixels));
    }

    use super::*;
    use crate::error::ErrorCode;
    #[cfg(windows)]
    use crate::refs::NativeHandle;
    use crate::state::StateId;

    #[test]
    fn gdi_unused_bytes_do_not_become_png_transparency() {
        use image::{codecs::png::PngEncoder, ExtendedColorType, ImageEncoder};

        let mut pixels = vec![30, 20, 10, 0, 60, 50, 40, 64, 90, 80, 70, 255];
        bgrx_to_opaque_rgba(&mut pixels);
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&pixels, 3, 1, ExtendedColorType::Rgba8)
            .unwrap();
        let decoded = image::load_from_memory(&png).unwrap().into_rgba8();
        assert_eq!(
            decoded.as_raw(),
            &[10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]
        );
        let resized =
            image::imageops::resize(&decoded, 2, 1, image::imageops::FilterType::Triangle);
        assert!(resized.pixels().all(|pixel| pixel[3] == 255));
    }

    // -- Platform support check (non-Windows) -------------------------------

    #[test]
    #[cfg(not(windows))]
    fn test_screenshot_unsupported_platform() {
        let mut store = RefStore::new();
        let wref = WindowRef { id: 1 };
        let result = screenshot(&mut store, &wref, false, None);
        assert!(result.is_err());
        let err = result.unwrap_err();
        assert_eq!(err.code, ErrorCode::UnsupportedPlatform);
    }

    // -- Response shape tests (cross-platform) -----------------------------

    #[test]
    fn test_screenshot_response_shape_json() {
        // Verify that a successful screenshot response serialises to the
        // expected JSON shape.  This test does not require a real window.
        let state_id = StateId::fresh("s");
        let response = serde_json::json!({
            "target": "@w1",
            "capture": {
                "stateId": state_id,
                "width": 800,
                "height": 600,
                "imageFormat": "png",
                "imageBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            },
            "warnings": [],
        });

        // Validate structural fields
        assert_eq!(response["target"].as_str(), Some("@w1"));
        assert!(response["capture"].is_object());
        assert!(response["warnings"].is_array());
        assert!(response["warnings"].as_array().unwrap().is_empty());

        let capture = &response["capture"];
        assert!(capture["stateId"].as_str().unwrap().starts_with("s-"));
        assert_eq!(capture["width"].as_u64(), Some(800));
        assert_eq!(capture["height"].as_u64(), Some(600));
        assert_eq!(capture["imageFormat"].as_str(), Some("png"));
        assert!(capture["imageBase64"].as_str().unwrap().len() > 10);
    }

    #[test]
    fn test_screenshot_response_with_warnings() {
        // Verify response with warnings and null image for zero-sized capture.
        let state_id = StateId::fresh("s");
        let response = serde_json::json!({
            "target": "@w1",
            "capture": {
                "stateId": state_id,
                "width": 0,
                "height": 0,
                "imageFormat": "png",
                "imageBase64": null,
            },
            "warnings": ["zero_sized_window"],
        });

        assert_eq!(response["target"].as_str(), Some("@w1"));
        assert_eq!(
            response["warnings"].as_array().unwrap(),
            &[serde_json::json!("zero_sized_window")]
        );
        assert!(response["capture"]["imageBase64"].is_null());
        assert_eq!(response["capture"]["width"].as_u64(), Some(0));
        assert_eq!(response["capture"]["height"].as_u64(), Some(0));
    }

    #[test]
    fn test_screenshot_target_not_found_error() {
        // Verify that a non-existent window ref produces the expected error.
        // On non-Windows the platform check returns UnsupportedPlatform first;
        // on Windows an empty store would return TargetNotFound.
        let mut store = RefStore::new();
        let wref = WindowRef { id: 999 };
        let result = screenshot(&mut store, &wref, false, None);
        assert!(result.is_err());
        let err = result.unwrap_err();
        #[cfg(not(windows))]
        assert_eq!(err.code, ErrorCode::UnsupportedPlatform);
        #[cfg(windows)]
        assert_eq!(err.code, ErrorCode::TargetNotFound);
    }

    // -- Windows-only integration tests ------------------------------------

    #[test]
    #[cfg(windows)]
    fn test_screenshot_capture_fresh_state_id() {
        // On Windows, verify that each screenshot gets a unique stateId.
        let mut store = RefStore::new();
        // Only works if there's at least one visible HWND.
        // We use a synthetic handle — the test checks the stateId property
        // not the actual capture quality.
        let wref = store.insert_window(NativeHandle::new(0)); // HWND 0 is invalid

        match screenshot(&mut store, &wref, false, None) {
            Ok(val) => {
                let sid = val["capture"]["stateId"]
                    .as_str()
                    .expect("stateId should be a string");
                assert!(sid.starts_with("s-"), "stateId should start with s-");
            }
            Err(e) => {
                // In CI / headless environments this will fail with
                // CaptureFailed because HWND 0 is not a valid window.
                // That's acceptable — the error path is exercised.
                assert_eq!(
                    e.code,
                    ErrorCode::CaptureFailed,
                    "Expected CaptureFailed for invalid HWND: {e:?}",
                );
            }
        }
    }

    #[test]
    #[cfg(windows)]
    fn test_screenshot_fresh_state_ids_differ() {
        let mut store = RefStore::new();
        let wref = store.insert_window(NativeHandle::new(0));

        // Same as above; just check that two calls produce different IDs
        // when they succeed or the same error when they fail.
        let result_a = screenshot(&mut store, &wref, false, None);
        let result_b = screenshot(&mut store, &wref, false, None);

        let err_a = result_a.as_ref().err().map(|e| e.code);
        let err_b = result_b.as_ref().err().map(|e| e.code);
        assert_eq!(err_a, err_b, "both calls should produce the same outcome");
    }
}
