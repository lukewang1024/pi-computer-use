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
