// Live X11 acceptance harness. Run only against a disposable test X server.
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::{shape, xproto::*};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    assert_eq!(
        std::env::var("PI_CU_CURSOR_TEST").as_deref(),
        Ok("1"),
        "This harness requires an explicitly disposable X server"
    );
    let (conn, screen) = x11rb::connect(None)?;
    let root = conn.setup().roots[screen].root;
    let window = conn.generate_id()?;
    conn.create_window(
        x11rb::COPY_DEPTH_FROM_PARENT,
        window,
        root,
        0,
        0,
        800,
        600,
        0,
        WindowClass::INPUT_OUTPUT,
        x11rb::COPY_FROM_PARENT,
        &CreateWindowAux::new()
            .background_pixel(0x224466)
            .event_mask(EventMask::BUTTON_PRESS),
    )?
    .check()?;
    conn.map_window(window)?.check()?;
    conn.set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME)?
        .check()?;
    conn.warp_pointer(x11rb::NONE, root, 0, 0, 0, 0, 400, 300)?
        .check()?;
    let before = conn.query_pointer(root)?.reply()?;
    let focus = conn.get_input_focus()?.reply()?.focus;
    linux_bridge::agent_cursor::animate(vec![(20, 50), (600, 50), (400, 300)], 1600)?;
    let start = Instant::now();
    let mut positions = std::collections::HashSet::new();
    let mut overlay = 0;
    while start.elapsed() < Duration::from_millis(1800) {
        for candidate in conn.query_tree(root)?.reply()?.children {
            let name = conn
                .get_property(
                    false,
                    candidate,
                    AtomEnum::WM_NAME,
                    AtomEnum::STRING,
                    0,
                    100,
                )?
                .reply()?
                .value;
            if name == b"Pi agent cursor" {
                overlay = candidate;
                let translated = conn.translate_coordinates(candidate, root, 0, 0)?.reply()?;
                positions.insert((translated.dst_x, translated.dst_y));
            }
        }
        let pointer = conn.query_pointer(root)?.reply()?;
        assert_eq!(
            (pointer.root_x, pointer.root_y),
            (before.root_x, before.root_y),
            "renderer moved the real pointer"
        );
        assert_eq!(
            conn.get_input_focus()?.reply()?.focus,
            focus,
            "renderer stole keyboard focus"
        );
        std::thread::sleep(Duration::from_millis(16));
    }
    assert_ne!(overlay, 0, "no cursor window rendered");
    let geometry = conn.get_geometry(overlay)?.reply()?;
    if geometry.depth == 32 {
        assert_eq!((geometry.width, geometry.height), (85, 86));
        let halo = conn
            .get_image(ImageFormat::Z_PIXMAP, overlay, 60, 42, 1, 1, u32::MAX)?
            .reply()?
            .data;
        let alpha = if conn.setup().image_byte_order == ImageOrder::LSB_FIRST {
            halo[3]
        } else {
            halo[0]
        };
        assert!(
            alpha > 0 && alpha < 255,
            "halo must retain per-pixel translucency"
        );
    } else {
        assert_eq!((geometry.width, geometry.height), (19, 20));
    }

    assert!(
        positions.len() >= 60,
        "animation did not produce enough distinct positions: {}",
        positions.len()
    );
    let region = shape::get_rectangles(&conn, overlay, shape::SK::INPUT)?.reply()?;
    assert!(
        region.rectangles.is_empty(),
        "cursor must have an empty input region"
    );
    assert_ne!(
        conn.query_pointer(root)?.reply()?.child,
        overlay,
        "cursor intercepted pointer hit testing"
    );
    assert_ne!(
        conn.translate_coordinates(root, root, 405, 310)?
            .reply()?
            .child,
        overlay,
        "virtual cursor blocked native preflight hit testing"
    );
    let pixel = conn
        .get_image(ImageFormat::Z_PIXMAP, root, 405, 310, 1, 1, u32::MAX)?
        .reply()?
        .data;
    assert_eq!(
        &pixel[..3],
        &[89, 92, 97],
        "cursor was not present in the composed desktop image"
    );
    x11rb::protocol::xtest::fake_input(&conn, BUTTON_PRESS_EVENT, 1, 0, root, 400, 300, 0)?
        .check()?;
    x11rb::protocol::xtest::fake_input(&conn, BUTTON_RELEASE_EVENT, 1, 0, root, 400, 300, 0)?
        .check()?;
    conn.flush()?;
    let deadline = Instant::now() + Duration::from_millis(500);
    let mut clicked = false;
    while Instant::now() < deadline {
        if let Some(x11rb::protocol::Event::ButtonPress(event)) = conn.poll_for_event()? {
            clicked = event.event == window;
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        clicked,
        "real click failed to pass through the virtual cursor"
    );
    linux_bridge::agent_cursor::animate(vec![(400, 300), (50, 100)], 0)?;
    std::thread::sleep(Duration::from_millis(40));
    let translated = conn.translate_coordinates(overlay, root, 0, 0)?.reply()?;
    assert_eq!(
        (translated.dst_x, translated.dst_y),
        (47, 98),
        "replacement did not land at exact endpoint"
    );
    std::thread::sleep(Duration::from_millis(8100));
    assert_eq!(
        conn.get_window_attributes(overlay)?.reply()?.map_state,
        MapState::UNMAPPED,
        "idle cursor stayed visible"
    );
    conn.destroy_window(window)?.check()?;
    println!("{{\"platform\":\"linux-x11\",\"distinctPositions\":{},\"systemPointerUnchanged\":true,\"focusUnchanged\":true,\"clickThrough\":true,\"composedPixels\":true,\"idleHidden\":true}}",positions.len());
    Ok(())
}
