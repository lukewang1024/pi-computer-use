//! One UIA press in a separate COM client process. A blocked Invoke must not
//! occupy the client used to resolve and operate its newly opened dialog.
//! Unlike discovery workers, termination is always an unknown action outcome.
use crate::uia::PressResult;
use serde::{Deserialize, Serialize};

pub const ACTION_BUDGET_MS: u64 = 290_000;
const MAX_REQUEST: usize = 8_000;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    hwnd: isize,
    pid: u64,
    runtime_id: Vec<i32>,
    automation_id: String,
}

fn decode(bytes: &[u8]) -> Result<Request, String> {
    if bytes.len() > MAX_REQUEST { return Err("UIA action request too large".into()); }
    let r: Request = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    if r.hwnd <= 0 || r.pid == 0 || r.pid > u32::MAX as u64 || r.runtime_id.is_empty()
        || r.runtime_id.len() > 128 || r.id.is_empty() || r.id.len() > 128
        || !r.id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') {
        return Err("UIA action requires an exact window and element identity".into());
    }
    Ok(r)
}

#[cfg(windows)]
pub fn serve() {
    use std::io::{Read, Write};
    use windows::Win32::{Foundation::HWND, UI::WindowsAndMessaging::GetWindowThreadProcessId};
    let result = (|| -> Result<PressResult, String> {
        let mut bytes = Vec::new();
        std::io::stdin().take(MAX_REQUEST as u64 + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        let r = decode(&bytes)?;
        let mut actual_pid = 0;
        let tid = unsafe { GetWindowThreadProcessId(HWND(r.hwnd as *mut _), Some(&mut actual_pid)) };
        if tid == 0 || actual_pid as u64 != r.pid { return Err("UIA action window identity changed".into()); }
        let _trace = crate::action_trace::begin(&r.id);
        crate::uia::press(r.hwnd, &r.runtime_id, &r.automation_id)
    })();
    // This worker has no coordinate/keyboard fallback and never retries.
    let _ = writeln!(std::io::stdout().lock(), "{}", serde_json::to_string(&result).unwrap());
}

#[cfg(windows)]
pub fn press(hwnd: isize, pid: u64, runtime_id: &[i32], automation_id: &str) -> Result<PressResult, String> {
    use std::{io::{Read, Write}, os::windows::{io::AsRawHandle, process::CommandExt},
        process::{Command, Stdio}, sync::mpsc, thread, time::{Duration, Instant}};
    use windows::{core::PCWSTR, Win32::{Foundation::{CloseHandle, HANDLE}, System::JobObjects::*}};

    struct Job(HANDLE);
    impl Drop for Job { fn drop(&mut self) { unsafe { let _ = CloseHandle(self.0); } } }
    let request = Request { id: crate::action_trace::request_id().ok_or("Missing action trace identity")?,
        hwnd, pid, runtime_id: runtime_id.to_vec(), automation_id: automation_id.into() };
    let bytes = serde_json::to_vec(&request).map_err(|e| e.to_string())?;
    decode(&bytes)?;
    let job = Job(unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(|e| format!("Action job: {e}"))?);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe { SetInformationJobObject(job.0, JobObjectExtendedLimitInformation,
        &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) }
        .map_err(|e| format!("Action job limits: {e}"))?;
    let mut child = Command::new(std::env::current_exe().map_err(|e| e.to_string())?)
        .arg("--uia-press-worker").creation_flags(0x08000000)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
        .spawn().map_err(|e| format!("Action worker spawn: {e}"))?;
    // The child waits for stdin EOF. Establish containment before handing it
    // any action, so even an abrupt helper exit cannot orphan an input worker.
    if let Err(e) = unsafe { AssignProcessToJobObject(job.0, HANDLE(child.as_raw_handle())) } {
        let _ = child.kill(); let _ = child.wait();
        return Err(format!("Action worker containment failed before dispatch: {e}"));
    }
    let started = Instant::now();
    let result = (|| -> Result<PressResult, String> {
        let mut input = child.stdin.take().ok_or("Action worker stdin unavailable")?;
        input.write_all(&bytes).map_err(|e| format!("Action worker request write failed; outcome unknown: {e}"))?;
        drop(input);
        let stdout = child.stdout.take().ok_or("Action worker stdout unavailable")?;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut bytes = Vec::new();
            let read = stdout.take(65_537).read_to_end(&mut bytes).map(|_| bytes);
            let _ = tx.send(read);
        });
        loop {
            match child.try_wait().map_err(|e| format!("Action worker wait failed; outcome unknown: {e}"))? {
                Some(status) => {
                    if !status.success() { return Err(format!("Action worker exited {status}; outcome unknown")); }
                    let bytes = rx.recv_timeout(Duration::from_secs(1)).map_err(|_| "Action worker response missing; outcome unknown")?
                        .map_err(|e| format!("Action worker response failed; outcome unknown: {e}"))?;
                    if bytes.len() > 65_536 { return Err("Action worker response too large; outcome unknown".into()); }
                    return serde_json::from_slice::<Result<PressResult, String>>(&bytes)
                        .map_err(|e| format!("Invalid action worker response; outcome unknown: {e}"))?;
                }
                None if started.elapsed() < Duration::from_millis(ACTION_BUDGET_MS + 5_000) => thread::sleep(Duration::from_millis(5)),
                None => return Err("UIA action worker timed out; outcome unknown; do not replay".into()),
            }
        }
    })();
    if !matches!(child.try_wait(), Ok(Some(_))) {
        child.kill().map_err(|e| format!("Action worker termination failed; outcome unknown: {e}"))?;
    }
    child.wait().map_err(|e| format!("Action worker reap failed; outcome unknown: {e}"))?;
    result
}

#[cfg(not(windows))]
pub fn press(_hwnd: isize, _pid: u64, _runtime_id: &[i32], _automation_id: &str) -> Result<PressResult, String> {
    Err("UIA action workers require Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn action_worker_requires_bounded_exact_identity() {
        let valid = serde_json::json!({"id":"request-1","hwnd":10,"pid":7,"runtime_id":[1,2],"automation_id":""});
        assert!(decode(&serde_json::to_vec(&valid).unwrap()).is_ok());
        for (key, value) in [("pid", serde_json::json!(0)), ("runtime_id", serde_json::json!([])),
            ("hwnd", serde_json::json!(0)), ("id", serde_json::json!("bad id")), ("extra", serde_json::json!(true))] {
            let mut invalid = valid.clone(); invalid[key] = value;
            assert!(decode(&serde_json::to_vec(&invalid).unwrap()).is_err(), "{key}");
        }
        assert!(decode(&vec![b' '; MAX_REQUEST + 1]).is_err());
    }
}
