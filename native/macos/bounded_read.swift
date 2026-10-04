import Foundation

enum BoundedReadFailure: Error {
    case busy
    case timedOut
}

private final class ReadResult<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Value, Error>?
    let completed = DispatchSemaphore(value: 0)

    func finish(_ value: Result<Value, Error>) {
        lock.lock()
        result = value
        lock.unlock()
    }

    func value() throws -> Value {
        lock.lock()
        let value = result
        lock.unlock()
        guard let value else { preconditionFailure("Read signalled before completion") }
        return try value.get()
    }
}

// A caller's deadline does not imply that synchronous native work stopped.
// Keep the worker occupied until the operation actually returns, including
// after cancellation, so repeated observations cannot accumulate OCR jobs.
final class BoundedReadExecutor<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var occupied = false
    private let queue: DispatchQueue

    init(label: String) { queue = DispatchQueue(label: label, qos: .userInitiated) }

    func run(timeout: TimeInterval, cancel: @escaping () -> Void,
        operation: @escaping () throws -> Value) throws -> Value {
        precondition(timeout > 0 && timeout.isFinite)
        let deadline = DispatchTime.now() + timeout
        lock.lock()
        guard !occupied else {
            lock.unlock()
            throw BoundedReadFailure.busy
        }
        occupied = true
        lock.unlock()
        let result = ReadResult<Value>()
        queue.async(execute: DispatchWorkItem {
            result.finish(Result(catching: operation))
            self.lock.lock()
            self.occupied = false
            self.lock.unlock()
            result.completed.signal()
        })
        guard result.completed.wait(timeout: deadline) == .success else {
            // Cancellation itself must not block the observation deadline.
            // Each cancellation captures only its own request; a late callback
            // cannot cancel or supply results for a subsequent request.
            DispatchQueue.global(qos: .userInitiated).async(execute: DispatchWorkItem(block: cancel))
            throw BoundedReadFailure.timedOut
        }
        return try result.value()
    }
}
