import Foundation

private enum FixtureError: Error { case failed }

@main struct Tests {
    static func main() throws {
        let reader = BoundedReadExecutor<[String]>(label: "test.bounded-read")
        let initial = try reader.run(timeout: 1, cancel: {}) { ["中文🙂"] }
        precondition(initial == ["中文🙂"])
        do {
            _ = try reader.run(timeout: 1, cancel: {}) { throw FixtureError.failed }
            preconditionFailure("Operation failure must propagate")
        } catch FixtureError.failed {}

        let started = DispatchSemaphore(value: 0)
        let releaseWorker = DispatchSemaphore(value: 0)
        let cancelStarted = DispatchSemaphore(value: 0)
        let releaseCancel = DispatchSemaphore(value: 0)
        let cancelFinished = DispatchSemaphore(value: 0)
        let start = DispatchTime.now().uptimeNanoseconds
        do {
            _ = try reader.run(timeout: 0.1, cancel: {
                cancelStarted.signal()
                releaseCancel.wait()
                cancelFinished.signal()
            }) {
                started.signal()
                releaseWorker.wait()
                return ["late old result"]
            }
            preconditionFailure("Blocked native work must time out")
        } catch BoundedReadFailure.timedOut {}
        let elapsed = Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000_000
        precondition(elapsed < 2, "Deadline blocked behind native work or cancellation")
        precondition(started.wait(timeout: .now() + .seconds(2)) == .success)
        precondition(cancelStarted.wait(timeout: .now() + .seconds(2)) == .success)
        for _ in 0..<20 {
            do {
                _ = try reader.run(timeout: 1, cancel: { preconditionFailure("Busy read cancelled another job") }) {
                    preconditionFailure("Busy read started overlapping native work")
                }
                preconditionFailure("Timed-out worker must remain occupied until it returns")
            } catch BoundedReadFailure.busy {}
        }
        releaseWorker.signal()
        let recoveryDeadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
        while true {
            do {
                let next = try reader.run(timeout: 1, cancel: {}) { ["fresh next result"] }
                precondition(next == ["fresh next result"], "Late result leaked across observations")
                break
            } catch BoundedReadFailure.busy {
                precondition(DispatchTime.now().uptimeNanoseconds < recoveryDeadline)
                Thread.sleep(forTimeInterval: 0.005)
            }
        }
        // A slow cancellation for the old request does not occupy or cancel the
        // new read. Its completion is never claimed by the deadline response.
        releaseCancel.signal()
        precondition(cancelFinished.wait(timeout: .now() + .seconds(2)) == .success)
        print("PASS bounded native read: deadline, busy admission, failure, cancellation and late-result isolation")
    }
}
