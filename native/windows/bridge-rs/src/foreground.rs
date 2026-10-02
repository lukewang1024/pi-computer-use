//! Exact-HWND activation. Never synthesize input or attach foreign input queues.
use crate::error::{ErrorCode, ProtocolError};
use serde_json::{json, Value};
use std::{
    mem::size_of,
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

static ACTIVATION_UNCERTAIN: AtomicBool = AtomicBool::new(false);

pub fn ensure_activation_safe() -> Result<(), ProtocolError> {
    if ACTIVATION_UNCERTAIN.load(Ordering::SeqCst) {
        return Err(ProtocolError::new("A previous UIA activation timed out; physical input is blocked until this CU session is closed and reopened", ErrorCode::ForegroundRequired));
    }
    Ok(())
}

use windows::core::PWSTR;
use windows::Win32::{
    Foundation::{HANDLE, HWND},
    System::{
        RemoteDesktop::{
            ProcessIdToSessionId, WTSActive, WTSConnectState, WTSFreeMemory,
            WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW, WTS_CURRENT_SERVER_HANDLE,
        },
        StationsAndDesktops::{
            CloseDesktop, GetProcessWindowStation, GetThreadDesktop, GetUserObjectInformationW,
            OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS, UOI_NAME,
        },
        Threading::{GetCurrentProcessId, GetCurrentThreadId},
    },
    UI::{Input::KeyboardAndMouse::IsWindowEnabled, WindowsAndMessaging::*},
};

unsafe fn desktop_name(handle: HANDLE) -> Option<String> {
    let mut buf = [0u16; 256];
    GetUserObjectInformationW(
        handle,
        UOI_NAME,
        Some(buf.as_mut_ptr().cast()),
        (buf.len() * 2) as u32,
        None,
    )
    .ok()?;
    let end = buf.iter().position(|v| *v == 0)?;
    Some(String::from_utf16_lossy(&buf[..end]))
}

// Fail closed for lock screen, unavailable input desktop, and disconnected RDP.
unsafe fn desktop_state(target_thread: u32) -> Value {
    let mut session = 0;
    let session_ok = ProcessIdToSessionId(GetCurrentProcessId(), &mut session).is_ok();
    let mut buffer = PWSTR::null();
    let mut bytes = 0;
    let queried = session_ok
        && WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            session,
            WTSConnectState,
            &mut buffer,
            &mut bytes,
        )
        .is_ok();
    let connection = if queried && !buffer.is_null() && bytes >= 4 {
        Some(*(buffer.0.cast::<i32>()))
    } else {
        None
    };
    if !buffer.is_null() {
        WTSFreeMemory(buffer.0.cast());
    }
    let mut info_buffer = PWSTR::null();
    let mut info_bytes = 0;
    let info_result = WTSQuerySessionInformationW(
        WTS_CURRENT_SERVER_HANDLE,
        session,
        WTSSessionInfoEx,
        &mut info_buffer,
        &mut info_bytes,
    );
    let session_flags = if info_result.is_ok()
        && !info_buffer.is_null()
        && info_bytes as usize >= size_of::<WTSINFOEXW>()
    {
        let info = &*info_buffer.0.cast::<WTSINFOEXW>();
        (info.Level == 1).then(|| info.Data.WTSInfoExLevel1.SessionFlags)
    } else {
        None
    };
    let session_info_error = info_result.err().map(|e| e.to_string());
    if !info_buffer.is_null() {
        WTSFreeMemory(info_buffer.0.cast());
    }
    let input = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS);
    let input_desktop_error = input.as_ref().err().map(|e| e.to_string());
    let input_name = input.as_ref().ok().and_then(|d| desktop_name(HANDLE(d.0)));
    if let Ok(d) = input {
        let _ = CloseDesktop(d);
    }
    let target_name = GetThreadDesktop(target_thread)
        .ok()
        .and_then(|d| desktop_name(HANDLE(d.0)));
    let helper_name = GetThreadDesktop(GetCurrentThreadId())
        .ok()
        .and_then(|d| desktop_name(HANDLE(d.0)));
    let window_station = GetProcessWindowStation()
        .ok()
        .and_then(|s| desktop_name(HANDLE(s.0)));
    let ready = interactive_desktop_ready(
        connection,
        window_station.as_deref(),
        input_name.as_deref(),
        target_name.as_deref(),
        helper_name.as_deref(),
    );
    json!({"ready":ready,"windowStation":window_station,"sessionId":session,"connectionState":connection,"sessionFlags":session_flags,"sessionInfoError":session_info_error,"inputDesktopError":input_desktop_error,"inputDesktop":input_name,"targetDesktop":target_name,"helperDesktop":helper_name})
}

unsafe fn identity(hwnd: HWND) -> Value {
    let mut pid = 0;
    let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    let mut gui = GUITHREADINFO {
        cbSize: size_of::<GUITHREADINFO>() as u32,
        ..Default::default()
    };
    let gui_ok = tid != 0 && GetGUIThreadInfo(tid, &mut gui).is_ok();
    let mut class_name = [0u16; 256];
    let class_len = GetClassNameW(hwnd, &mut class_name).max(0) as usize;
    let root = GetAncestor(hwnd, GA_ROOT);
    let mut owners = Vec::new();
    let mut current = hwnd;
    for _ in 0..8 {
        let Ok(owner) = GetWindow(current, GW_OWNER) else {
            break;
        };
        if owner.0.is_null()
            || owners
                .iter()
                .any(|v: &Value| v["hwnd"] == json!(owner.0 as isize))
        {
            break;
        }
        let mut owner_pid = 0;
        let owner_thread = GetWindowThreadProcessId(owner, Some(&mut owner_pid));
        owners.push(json!({"hwnd":owner.0 as isize,"pid":owner_pid,"threadId":owner_thread}));
        current = owner;
    }
    json!({"hwnd":hwnd.0 as isize,"className":String::from_utf16_lossy(&class_name[..class_len]),"rootHwnd":root.0 as isize,"pid":pid,"threadId":tid,"valid":IsWindow(hwnd).as_bool(),"visible":IsWindowVisible(hwnd).as_bool(),"enabled":IsWindowEnabled(hwnd).as_bool(),"minimized":IsIconic(hwnd).as_bool(),"ownerChain":owners,"guiThreadInfo":if gui_ok {json!({"activeHwnd":gui.hwndActive.0 as isize,"focusHwnd":gui.hwndFocus.0 as isize,"flags":gui.flags.0})} else {Value::Null}})
}

unsafe fn observe(hwnd: HWND, pid: u32, tid: u32) -> Value {
    let target = identity(hwnd);
    let desktop = desktop_state(tid);
    let foreground = GetForegroundWindow();
    let eligible = target["valid"] == true
        && target["pid"] == pid
        && target["threadId"] == tid
        && target["enabled"] == true
        && desktop["ready"] == true;
    json!({"eligible":eligible,"focused":eligible && foreground == hwnd && target["minimized"] == false && target["visible"] == true,"target":target,"foreground":identity(foreground),"desktop":desktop})
}

/// Check focus continuity without activating a window or changing the caret.
/// Even an implicit keyboard target must remain the exact foreground HWND.
pub fn require_foreground(raw: isize, expected_pid: u64) -> Result<(), ProtocolError> {
    ensure_activation_safe()?;
    unsafe {
        let hwnd = HWND(raw as *mut _);
        let mut pid = 0;
        let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if !IsWindow(hwnd).as_bool() || tid == 0 || pid == 0 || u64::from(pid) != expected_pid {
            return Err(ProtocolError::new(
                "Target HWND no longer exists or its process ownership changed",
                ErrorCode::StaleRef,
            ));
        }
        let observation = observe(hwnd, pid, tid);
        if observation["focused"] != true {
            return Err(ProtocolError::new(
                format!("Target lost foreground; physical input was not sent: {observation}"),
                ErrorCode::ForegroundRequired,
            ));
        }
        Ok(())
    }
}

pub fn activate(raw: isize, expected_pid: u64) -> Result<Value, ProtocolError> {
    ensure_activation_safe()?;
    unsafe {
        let hwnd = HWND(raw as *mut _);
        let mut pid = 0;
        let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if !IsWindow(hwnd).as_bool() || tid == 0 || pid == 0 || u64::from(pid) != expected_pid {
            return Err(ProtocolError::new(
                "Target HWND no longer exists or its process ownership changed",
                ErrorCode::StaleRef,
            ));
        }
        let initial = observe(hwnd, pid, tid);
        let already = initial["focused"] == true;
        let was_minimized = initial["target"]["minimized"] == true;
        let mut observations = vec![json!({"step":"initial","observation":initial})];
        for step in 0..6 {
            let before = observe(hwnd, pid, tid);
            if before["focused"] == true || before["eligible"] != true {
                break;
            }
            let api = match step {
                0 if IsIconic(hwnd).as_bool() => {
                    json!({"ShowWindowAsyncRestore":ShowWindowAsync(hwnd, SW_RESTORE).as_bool()})
                }
                0 => json!({"restore":"not_minimized"}),
                1 => json!({"ShowWindowAsyncShow":ShowWindowAsync(hwnd, SW_SHOW).as_bool()}),
                // Async z-order request avoids waiting on an unresponsive target thread.
                2 => {
                    json!({"SetWindowPosAsync":SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_ASYNCWINDOWPOS | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE).map(|_| "ok".to_owned()).unwrap_or_else(|e| e.to_string())})
                }
                _ => json!({"SetForegroundWindow":SetForegroundWindow(hwnd).as_bool()}),
            };
            thread::sleep(Duration::from_millis(50));
            observations.push(json!({"step":step,"api":api,"observation":observe(hwnd,pid,tid)}));
        }
        let before_uia = observe(hwnd, pid, tid);
        if before_uia["focused"] != true && before_uia["eligible"] == true {
            let result = uia_fallback(raw, pid, tid).map_err(|e| {
                ProtocolError::new(
                    format!(
                        "{e}; physical input was not sent; diagnostics={}",
                        json!({"attempts":observations,"final":observe(hwnd,pid,tid)})
                    ),
                    ErrorCode::ForegroundRequired,
                )
            })?;
            thread::sleep(Duration::from_millis(50));
            observations
                .push(json!({"step":"uia","api":result,"observation":observe(hwnd,pid,tid)}));
        }
        let final_state = observe(hwnd, pid, tid);
        Ok(
            json!({"focused":final_state["focused"],"alreadyFocused":already,"unminimized":was_minimized && final_state["target"]["minimized"] == false,"activated":final_state["focused"],"raised":final_state["focused"],"setFocused":final_state["focused"],"activationDiagnostics":{"attempts":observations,"final":final_state}}),
        )
    }
}

/// Run UIA in a disposable process: a hung provider cannot leave a late focus
/// request racing physical input. Timeout kills and reaps it, and fences all
/// later physical input in this helper until session disposal.
fn uia_fallback(hwnd: isize, pid: u32, tid: u32) -> Result<Value, String> {
    use std::{
        io::Read,
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        time::Instant,
    };
    let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .args([
            "--foreground-uia",
            &hwnd.to_string(),
            &pid.to_string(),
            &tid.to_string(),
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // A cold Word provider can complete SetFocus after 750 ms. Keep the
    // fallback bounded, while allowing its RPC to return before poisoning the
    // session. Timeout still kills/reaps the worker and blocks physical input.
    let deadline = Instant::now() + Duration::from_millis(1500);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut output = String::new();
                if let Some(stdout) = child.stdout.take() {
                    stdout
                        .take(8192)
                        .read_to_string(&mut output)
                        .map_err(|e| e.to_string())?;
                }
                return if status.success() {
                    serde_json::from_str(&output).map_err(|e| e.to_string())
                } else {
                    Err(format!("UIA worker exited {status}"))
                };
            }
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(10)),
            _ => {
                ACTIVATION_UNCERTAIN.store(true, Ordering::SeqCst);
                // Killing the caller cannot cancel a provider RPC already in progress.
                // Fence later physical input in this helper until session disposal.
                // If termination cannot be confirmed, propagate an uncertain error;
                // never report focus success or proceed to physical input.
                child
                    .kill()
                    .map_err(|e| format!("UIA worker termination failed: {e}"))?;
                child
                    .wait()
                    .map_err(|e| format!("UIA worker reap failed: {e}"))?;
                return Err("UIA activation timed out; worker terminated and reaped".into());
            }
        }
    }
}

pub fn uia_worker(raw: isize, pid: u32, tid: u32) -> Value {
    use windows::Win32::{System::Com::*, UI::Accessibility::*};
    unsafe {
        let hwnd = HWND(raw as *mut _);
        let initial = observe(hwnd, pid, tid);
        if initial["eligible"] != true {
            return json!({"skipped":initial});
        }
        if let Err(e) = CoInitializeEx(None, COINIT_MULTITHREADED).ok() {
            return json!({"error":e.to_string()});
        }
        let result = (|| -> windows::core::Result<Value> {
            let uia: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
            let root = uia.ElementFromHandle(hwnd)?;
            let mut steps = Vec::new();
            if observe(hwnd, pid, tid)["eligible"] != true {
                return Ok(json!({"skipped":"target_or_desktop_changed"}));
            }
            if IsIconic(hwnd).as_bool() {
                if let Ok(pattern) =
                    root.GetCurrentPatternAs::<IUIAutomationWindowPattern>(UIA_WindowPatternId)
                {
                    let restored = pattern.SetWindowVisualState(WindowVisualState_Normal);
                    steps.push(json!({"WindowPatternRestore":restored.err().map(|e| e.to_string()),"observation":observe(hwnd,pid,tid)}));
                }
            }
            if observe(hwnd, pid, tid)["eligible"] != true {
                return Ok(json!({"steps":steps,"skipped":"target_or_desktop_changed"}));
            }
            let focused = root.SetFocus();
            steps.push(json!({"UIASetFocus":focused.err().map(|e| e.to_string()),"observation":observe(hwnd,pid,tid)}));
            Ok(json!({"steps":steps}))
        })();
        CoUninitialize();
        result.unwrap_or_else(|e| json!({"error":e.to_string()}))
    }
}

fn interactive_desktop_ready(
    connection: Option<i32>,
    station: Option<&str>,
    input: Option<&str>,
    target: Option<&str>,
    helper: Option<&str>,
) -> bool {
    connection == Some(WTSActive.0)
        && station.is_some_and(|name| name.eq_ignore_ascii_case("WinSta0"))
        && input.is_some_and(|name| name.eq_ignore_ascii_case("Default"))
        && target == input
        && helper == input
}

/// Read-only gate for screen-pixel fallback. It must depict the requested window.
pub fn capture_state(raw: isize) -> Value {
    unsafe {
        let hwnd = HWND(raw as *mut _);
        let mut pid = 0;
        let tid = GetWindowThreadProcessId(hwnd, Some(&mut pid));
        observe(hwnd, pid, tid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_gate_rejects_locked_disconnected_and_wrong_desktops() {
        assert!(interactive_desktop_ready(
            Some(0),
            Some("WinSta0"),
            Some("Default"),
            Some("Default"),
            Some("Default")
        ));
        for (connection, station, input, target, helper) in [
            (
                Some(4),
                Some("WinSta0"),
                Some("Default"),
                Some("Default"),
                Some("Default"),
            ),
            (
                None,
                Some("WinSta0"),
                Some("Default"),
                Some("Default"),
                Some("Default"),
            ),
            (
                Some(0),
                Some("WinSta0"),
                None,
                Some("Default"),
                Some("Default"),
            ),
            (
                Some(0),
                Some("WinSta0"),
                Some("Winlogon"),
                Some("Default"),
                Some("Default"),
            ),
            (
                Some(0),
                Some("Service-0"),
                Some("Default"),
                Some("Default"),
                Some("Default"),
            ),
            (
                Some(0),
                Some("WinSta0"),
                Some("Default"),
                Some("Other"),
                Some("Default"),
            ),
            (
                Some(0),
                Some("WinSta0"),
                Some("Default"),
                Some("Default"),
                Some("Other"),
            ),
        ] {
            assert!(!interactive_desktop_ready(
                connection, station, input, target, helper
            ));
        }
    }
    #[test]
    fn destroyed_or_reassigned_hwnd_is_rejected_before_activation() {
        assert_eq!(activate(0, 1).unwrap_err().code, ErrorCode::StaleRef);
        unsafe {
            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE(0),
                windows::core::w!("STATIC"),
                windows::core::w!("foreground test"),
                WS_POPUP,
                0,
                0,
                10,
                10,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let error =
                activate(hwnd.0 as isize, u64::from(GetCurrentProcessId()) + 1).unwrap_err();
            let _ = DestroyWindow(hwnd);
            assert_eq!(error.code, ErrorCode::StaleRef);
        }
    }
}
