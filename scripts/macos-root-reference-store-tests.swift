final class Proxy {
    let identity: Int
    let generation: Int
    init(_ identity: Int, _ generation: Int) {
        self.identity = identity
        self.generation = generation
    }
}

@main struct Tests {
    static func main() {
        let window = NativeRootBinding(pid: 7, windowId: 11, role: "AXWindow", subrole: "")
        var store = RefreshedRootReferenceStore<Proxy>()
        var sequence = 0
        func mint() -> String { sequence += 1; return "w\(sequence)" }
        let old = Proxy(1, 1), fresh = Proxy(1, 2)
        let ref = store.store(old, binding: window, equivalent: { $0.identity == $1.identity }, makeRef: mint)
        let refreshed = store.store(fresh, binding: window, equivalent: { $0.identity == $1.identity }, makeRef: mint)
        precondition(ref == refreshed && sequence == 1)
        precondition(store.record(for: ref)?.element === fresh)
        precondition(store.record(for: "missing") == nil)
        let foreign = [
            NativeRootBinding(pid: 8, windowId: 11, role: "AXWindow", subrole: ""),
            NativeRootBinding(pid: 7, windowId: 12, role: "AXWindow", subrole: ""),
            NativeRootBinding(pid: 7, windowId: nil, role: "AXWindow", subrole: ""),
            NativeRootBinding(pid: 7, windowId: 11, role: "AXApplication", subrole: ""),
            NativeRootBinding(pid: 7, windowId: 11, role: "AXWindow", subrole: "AXDialog"),
        ]
        for binding in foreign {
            let other = store.store(Proxy(1, 3), binding: binding,
                                    equivalent: { $0.identity == $1.identity }, makeRef: mint)
            precondition(other != ref && store.record(for: other)?.binding == binding)
            precondition(store.record(for: ref)?.element === fresh)
            precondition(uniqueBoundRootIndex(expected: window,
                         candidates: [(binding, true)]) == nil)
        }
        precondition(uniqueBoundRootIndex(expected: window, candidates: []) == nil)
        precondition(uniqueBoundRootIndex(expected: window, candidates: [(window, false)]) == nil)
        precondition(uniqueBoundRootIndex(expected: window,
                     candidates: [(window, true), (window, true)]) == nil)
        precondition(uniqueBoundRootIndex(expected: window,
                     candidates: [(foreign[3], true), (window, true)]) == 1)
        print("PASS fresh proxies, process/window/type bindings, missing and ambiguous roots")
    }
}
