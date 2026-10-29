import Foundation

private final class Element {
    let name: String
    var children: [Element]?
    init(_ name: String, _ children: [Element]? = []) {
        self.name = name
        self.children = children
    }
}

@main struct Tests {
    static func main() {
        var reads = 0
        func scan(_ root: Element, limit: Int = 2000, exact: Bool = false,
                  budget: () -> Bool = { true }) -> ConditionScan<Element> {
            scanCondition(root: root, maxNodes: limit,
                identity: { AnyHashable(ObjectIdentifier($0)) },
                children: { reads += 1; return exact ? [] : $0.children },
                matches: { $0.name == "target" }, withinBudget: budget)
        }

        // Real Word comment and zoom controls were 29 and 15 wrappers deep.
        for depth in [15, 29, 80] {
            let target = Element("target")
            var root = target
            for i in 0..<depth { root = Element("wrapper\(i)", [root]) }
            let result = scan(root)
            precondition(result.match === target && result.nodeCount == depth + 1)
            precondition(result.satisfies(gone: false) == true)
            precondition(result.satisfies(gone: true) == false)
            let limited = scan(root, limit: 12)
            precondition(limited.match == nil && !limited.complete)
            precondition(limited.satisfies(gone: false) == nil)
            precondition(limited.satisfies(gone: true) == nil,
                         "An unread deep match must never prove absence")
        }

        let root = Element("root", [Element("leaf"), Element("other")])
        let absent = scan(root, limit: 3)
        precondition(absent.complete && absent.nodeCount == 3)
        precondition(absent.satisfies(gone: true) == true)
        precondition(absent.satisfies(gone: false) == false)
        let wide = scan(root, limit: 2)
        precondition(wide.nodeCount <= 2 && !wide.complete)
        precondition(wide.satisfies(gone: true) == nil)

        // Failed AXChildren reads are not leaves. Other readable branches can
        // still prove presence, but cannot repair an absence proof.
        let unreadable = Element("unreadable", nil)
        let failed = scan(Element("root", [unreadable]))
        precondition(!failed.complete && failed.satisfies(gone: true) == nil)
        let target = Element("target")
        let sibling = scan(Element("root", [unreadable, target]))
        precondition(sibling.match === target && sibling.satisfies(gone: false) == true)

        // Repeated identities and cycles consume no extra node capacity.
        let cycle = Element("cycle")
        cycle.children = [cycle]
        let repeated = scan(Element("root", [cycle, cycle]), limit: 2)
        precondition(repeated.complete && repeated.nodeCount == 2)
        precondition(repeated.satisfies(gone: true) == true)

        reads = 0
        let expired = scan(root, budget: { false })
        precondition(expired.nodeCount == 0 && !expired.complete && reads == 0)
        precondition(expired.satisfies(gone: true) == nil)
        var checks = 0
        let interrupted = scan(root, budget: { checks += 1; return checks < 3 })
        precondition(!interrupted.complete && interrupted.satisfies(gone: true) == nil)
        let exact = scan(root, limit: 1, exact: true)
        precondition(exact.complete && exact.nodeCount == 1)
        precondition(exact.satisfies(gone: true) == true)
        print("PASS deep native conditions, complete absence, failed reads, node/time budgets, exact scope and cyclic identities")
    }
}
