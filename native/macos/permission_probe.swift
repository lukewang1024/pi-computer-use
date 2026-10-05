import Foundation

// Share an in-flight read, including a denied result, without persisting denial.
// A later caller can recheck after the user changes permissions.
final class PermissionProbe<Value>: @unchecked Sendable {
    private final class Flight {
        var value: Value?
        var completed = false
        var waiters = 0
    }
    private let condition = NSCondition()
    private var active: Flight?
    private var cached: Value?

    func read(cacheWhen: (Value) -> Bool, probe: () -> Value) -> Value {
        condition.lock()
        if let cached {
            condition.unlock()
            return cached
        }
        if let flight = active {
            flight.waiters += 1
            while !flight.completed { condition.wait() }
            flight.waiters -= 1
            let value = flight.value!
            condition.unlock()
            return value
        }
        let flight = Flight()
        active = flight
        condition.unlock()
        let value = probe()
        let retain = cacheWhen(value)
        condition.lock()
        flight.value = value
        flight.completed = true
        if retain { cached = value }
        active = nil
        condition.broadcast()
        condition.unlock()
        return value
    }

    func snapshot() -> [String: Any] {
        condition.lock()
        defer { condition.unlock() }
        return ["inFlight": active != nil, "waiters": active?.waiters ?? 0,
                "positiveCached": cached != nil]
    }
}

// A caller deadline cannot cancel ScreenCaptureKit's asynchronous content fetch.
// Retain its slot until the actual callback completes; reject overlapping starts.
final class CompletionOwnedPermissionProbe<Value>: @unchecked Sendable {
    private final class Flight {
        let done = DispatchSemaphore(value: 0)
        var value: Value?
        var completed = false
    }
    private let lock = NSLock()
    private var active: Flight?

    var occupied: Bool {
        lock.lock(); defer { lock.unlock() }
        return active != nil
    }

    func read(timeout: TimeInterval, start: (@escaping (Value) -> Void) -> Void) -> Value? {
        precondition(timeout.isFinite && timeout >= 0)
        lock.lock()
        guard active == nil else { lock.unlock(); return nil }
        let flight = Flight()
        active = flight
        lock.unlock()
        start { value in
            self.lock.lock()
            guard !flight.completed else { self.lock.unlock(); return }
            flight.value = value
            flight.completed = true
            if self.active === flight { self.active = nil }
            self.lock.unlock()
            flight.done.signal()
        }
        guard flight.done.wait(timeout: .now() + timeout) == .success else { return nil }
        lock.lock(); defer { lock.unlock() }
        return flight.value
    }
}
