//! Process boundary for read-only provider calls that cannot be cancelled in-process.
use std::{
    io::Read,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub fn run(command: &mut Command, budget: Duration, max_output: usize) -> Result<Vec<u8>, String> {
    let started = Instant::now();
    let mut child = command
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|e| format!("UIA read worker spawn: {e}"))?;
    let stdout = child.stdout.take().expect("piped worker stdout");
    // Drain concurrently: waiting for exit before reading deadlocks when an
    // otherwise healthy outline exceeds the OS pipe capacity.
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut output = Vec::new();
        let result = stdout
            .take(max_output as u64 + 1)
            .read_to_end(&mut output)
            .map(|_| output)
            .map_err(|e| e.to_string());
        let _ = sender.send(result);
    });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < budget => thread::sleep(Duration::from_millis(5)),
            result => {
                // Never leave an owned timed-out read worker running. No input
                // or activation methods are reachable in this worker mode.
                child
                    .kill()
                    .map_err(|e| format!("UIA read worker termination failed: {e}"))?;
                child
                    .wait()
                    .map_err(|e| format!("UIA read worker reap failed: {e}"))?;
                return Err(match result {
                    Err(e) => format!("UIA read worker wait failed: {e}"),
                    _ => "UIA read worker deadline exceeded; terminated and reaped".into(),
                });
            }
        }
    };
    let output = receiver
        .recv_timeout(Duration::from_millis(100))
        .map_err(|e| format!("UIA read worker output unavailable: {e}"))??;
    if output.len() > max_output {
        return Err("UIA read worker output limit exceeded".into());
    }
    if !status.success() {
        return Err(format!("UIA read worker exited {status}"));
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn worker(mode: &str) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "read_worker::tests::worker_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("CU_READ_WORKER_TEST_MODE", mode);
        command
    }
    // Only the test executable contains this fixture. Production workers have
    // no delay injection or general command execution capability.
    #[test]
    #[ignore]
    fn worker_fixture() {
        match std::env::var("CU_READ_WORKER_TEST_MODE").as_deref() {
            Ok("large") => {
                use std::io::Write;
                std::io::stdout().write_all(&vec![b'x'; 200000]).unwrap();
            }
            Ok("hang") => thread::sleep(Duration::from_secs(20)),
            Ok("fail") => std::process::exit(1),
            _ => panic!("worker fixture requires an explicit mode"),
        }
    }
    #[test]
    fn drains_outline_larger_than_pipe_capacity() {
        let bytes = run(&mut worker("large"), Duration::from_secs(2), 250000).unwrap();
        assert!(bytes.len() >= 200000);
    }
    #[test]
    fn kills_and_reaps_nonresponsive_worker() {
        let started = Instant::now();
        let error = run(&mut worker("hang"), Duration::from_millis(100), 1000).unwrap_err();
        assert!(error.contains("terminated and reaped"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    #[test]
    fn rejects_failed_exit_and_oversized_output() {
        assert!(run(&mut worker("fail"), Duration::from_secs(2), 1000)
            .unwrap_err()
            .contains("exited"));
        assert!(run(&mut worker("large"), Duration::from_secs(2), 1000)
            .unwrap_err()
            .contains("output limit"));
    }
}
