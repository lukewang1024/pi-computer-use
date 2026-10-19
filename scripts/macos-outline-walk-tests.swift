import Foundation
final class Element {
    let name: String
    let hidden: Bool
    var children: [Element]
    init(_ name: String, _ hidden: Bool = false, _ children: [Element] = []) {
        self.name = name; self.hidden = hidden; self.children = children
    }
}
final class Node {
    let name: String
    let hidden: Bool
    var children: [Node] = []
    var truncated = false
    init(_ e: Element, root: Bool = false) { name = e.name; hidden = root ? false : e.hidden }
}
@main struct Tests {
    static func main() {
        var parentReads = 0
        func ancestry(_ target: Int, depth: Int = 64) -> Bool {
            boundedAncestorMatches(start: 0, ancestor: target, maximumDepth: depth,
                parent: { parentReads += 1; return $0 < 80 ? $0 + 1 : nil },
                same: { $0 == $1 }, withinBudget: { true })
        }
        precondition(ancestry(23), "Doubao's observed 24-node canvas chain must reach its exact window")
        precondition(ancestry(63), "The last permitted node is still checked")
        parentReads = 0
        precondition(!ancestry(64) && parentReads == 63, "Do not read beyond the node budget")
        precondition(!ancestry(-1), "Another window cannot establish ownership")
        parentReads = 0
        precondition(!boundedAncestorMatches(start: 0, ancestor: 9,
            parent: { parentReads += 1; return 1 - $0 }, same: { $0 == $1 },
            withinBudget: { true }) && parentReads == 2, "Cycles must terminate")
        parentReads = 0
        precondition(!boundedAncestorMatches(start: 0, ancestor: 0,
            parent: { parentReads += 1; return $0 + 1 }, same: { $0 == $1 },
            withinBudget: { false }) && parentReads == 0, "Expired scope cannot establish ownership")
        precondition(!boundedAncestorMatches(start: 0, ancestor: 1,
            parent: { _ in parentReads += 1; return 1 }, same: { $0 == $1 },
            withinBudget: { parentReads == 0 }), "A parent read that exhausts the budget cannot authorize input")
        var availabilityReads = 0
        let denied = { availabilityReads += 1; return Optional(false) }
        precondition(observedAvailability(canPress: false, hasConfirm: false,
            canSetValue: true, isTextInput: true, read: denied) == false)
        precondition(availabilityReads == 1, "Disabled editable provider must be observed")
        precondition(observedAvailability(canPress: false, hasConfirm: false,
            canSetValue: false, isTextInput: true, read: denied) == false)
        precondition(observedAvailability(canPress: true, hasConfirm: false,
            canSetValue: false, isTextInput: false, read: denied) == false)
        precondition(observedAvailability(canPress: false, hasConfirm: true,
            canSetValue: false, isTextInput: false, read: denied) == false)
        let readsBeforeStatic = availabilityReads
        precondition(observedAvailability(canPress: false, hasConfirm: false,
            canSetValue: false, isTextInput: false, read: denied) == nil)
        precondition(availabilityReads == readsBeforeStatic, "Static nodes must not probe availability")
        precondition(observedAvailability(canPress: false, hasConfirm: false,
            canSetValue: true, isTextInput: false, read: { nil }) == nil)
        precondition(observedAvailability(canPress: false, hasConfirm: false,
            canSetValue: true, isTextInput: false, read: { true }) == true)

        func run(_ root: Element, limit: Int = 2000, budget: @escaping () -> Bool = { true }) -> (Node, [String], [String]) {
            let node = Node(root, root: true)
            var reads: [String] = []; var descriptions: [String] = [root.name]
            walkObservedOutline(root: root, node: node, maxNodes: limit,
                identity: { AnyHashable(ObjectIdentifier($0)) },
                children: { reads.append($0.name); return $0.children },
                describe: { child, _ in descriptions.append(child.name); return Node(child) },
                offscreen: { $0.hidden }, append: { $0.children.append($1) },
                truncate: { $0.truncated = true }, withinBudget: budget)
            return (node, reads, descriptions)
        }
        let hidden = Element("offscreen row", true, [Element("hidden field"), Element("hidden icon")])
        let visible = Element("visible row", false, [Element("visible field")])
        let root = Element("sheet", false, [hidden, visible, Element("Save"), Element("Cancel")])
        let (n, reads, described) = run(root)
        precondition(n.children.map { $0.name } == ["offscreen row", "visible row", "Save", "Cancel"])
        precondition(n.children[0].truncated && n.children[0].children.isEmpty)
        precondition(n.children[1].children.map { $0.name } == ["visible field"])
        precondition(!reads.contains("hidden field") && !described.contains("hidden field"))
        precondition(!n.children[2].truncated && !n.children[3].truncated)
        // Explicit scoped expansion must still expose a deferred row's children.
        let (expanded, _, _) = run(hidden)
        precondition(expanded.children.map { $0.name } == ["hidden field", "hidden icon"] && !expanded.truncated)
        let leaf = Element("offscreen leaf", true)
        let (leaves, _, _) = run(Element("root", false, [leaf]))
        precondition(!leaves.children[0].truncated)
        // No AX requests can occur once the clock budget is exhausted.
        let (expired, expiredReads, _) = run(root, budget: { false })
        precondition(expired.truncated && expiredReads.isEmpty)
        let (limited, limitedReads, names) = run(root, limit: 3)
        precondition(names.count == 3 && limited.truncated && limitedReads == ["sheet"])
        precondition(limited.children.allSatisfy { $0.truncated })
        // Repeated identities and cycles cannot produce duplicate refs/work.
        let repeated = Element("repeated"); repeated.children = [repeated]
        let (cycle, cycleReads, cycleNames) = run(Element("root", false, [repeated, repeated]))
        precondition(cycle.children.count == 1 && cycle.children[0].children.isEmpty)
        precondition(cycleReads == ["root", "repeated"] && cycleNames == ["root", "repeated"])
        print("PASS visible/offscreen containers, scoped expansion, leaves, expired/node budgets and cyclic identity traversal")
    }
}
