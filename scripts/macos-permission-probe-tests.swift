import Foundation

private final class Counts: @unchecked Sendable {
    let lock = NSLock()
    var probes = 0
    var results = [Bool]()
    func probe() { lock.lock(); probes += 1; lock.unlock() }
    func record(_ result: Bool) { lock.lock(); results.append(result); lock.unlock() }
}

@main struct PermissionProbeTests {
    static func main() {
        for granted in [false, true] {
            let cache = PermissionProbe<Bool>()
            let counts = Counts()
            let started = DispatchSemaphore(value: 0)
            let release = DispatchSemaphore(value: 0)
            let group = DispatchGroup()
            group.enter()
            DispatchQueue.global().async {
                counts.record(cache.read(cacheWhen: { $0 }) {
                    counts.probe(); started.signal()
                    precondition(release.wait(timeout: .now() + 5) == .success)
                    return granted
                })
                group.leave()
            }
            precondition(started.wait(timeout: .now() + 5) == .success)
            for _ in 0..<8 {
                group.enter()
                DispatchQueue.global().async {
                    counts.record(cache.read(cacheWhen: { $0 }) {
                        counts.probe(); return granted
                    })
                    group.leave()
                }
            }
            let deadline = Date().addingTimeInterval(5)
            while cache.snapshot()["waiters"] as? Int != 8 && Date() < deadline {
                Thread.sleep(forTimeInterval: 0.001)
            }
            precondition(cache.snapshot()["waiters"] as? Int == 8)
            release.signal()
            precondition(group.wait(timeout: .now() + 5) == .success)
            precondition(counts.probes == 1 && counts.results.count == 9)
            precondition(counts.results.allSatisfy { $0 == granted })
            precondition(cache.snapshot()["positiveCached"] as? Bool == granted)
            let next = cache.read(cacheWhen: { $0 }) { counts.probe(); return true }
            precondition(next && counts.probes == (granted ? 1 : 2))
        }
        let completionProbe = CompletionOwnedPermissionProbe<Bool>()
        var first: ((Bool) -> Void)?
        var second: ((Bool) -> Void)?
        precondition(completionProbe.read(timeout: 0) { first = $0 } == nil)
        precondition(completionProbe.occupied)
        precondition(completionProbe.read(timeout: 0) { _ in
            preconditionFailure("Timed-out native fetch must retain its slot")
        } == nil)
        first!(false)
        precondition(!completionProbe.occupied)
        precondition(completionProbe.read(timeout: 0) { $0(true) } == true)
        precondition(!completionProbe.occupied)
        precondition(completionProbe.read(timeout: 0) { second = $0 } == nil)
        first!(true) // Duplicate old completion cannot release the newer flight.
        precondition(completionProbe.occupied)
        second!(false)
        precondition(!completionProbe.occupied)
        print("Concurrent permission probes share grants and denials; later denied checks can recover")
    }
}
