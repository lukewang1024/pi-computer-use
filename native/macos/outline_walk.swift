// Shared by native AX observation and deterministic traversal regressions.
// Deep web editors can exceed twenty parents. Require the exact ancestor,
// keeping both a node bound and a clock budget; cycles never establish scope.
func boundedAncestorMatches<Element>(
    start: Element, ancestor: Element, maximumDepth: Int = 64,
    parent: (Element) -> Element?, same: (Element, Element) -> Bool,
    withinBudget: () -> Bool
) -> Bool {
    guard maximumDepth > 0 else { return false }
    var current: Element? = start
    var seen: [Element] = []
    for depth in 0..<maximumDepth {
        guard withinBudget(), let candidate = current else { return false }
        if same(candidate, ancestor) { return true }
        guard !seen.contains(where: { same($0, candidate) }) else { return false }
        seen.append(candidate)
        if depth + 1 < maximumDepth { current = parent(candidate) }
    }
    return false
}

func walkObservedOutline<Element, Node>(
    root: Element, node: Node, maxNodes: Int,
    identity: (Element) -> AnyHashable,
    children: (Element) -> [Element],
    describe: (Element, Element) -> Node,
    offscreen: (Node) -> Bool,
    append: (Node, Node) -> Void,
    truncate: (Node) -> Void,
    withinBudget: () -> Bool
) {
    var seen = Set<AnyHashable>([identity(root)])
    var queue: [(Element, Node)] = [(root, node)]
    var index = 0
    var count = 1
    while index < queue.count {
        let (element, current) = queue[index]
        index += 1
        // Do not perform more AX requests after the traversal budget expires.
        guard count < maxNodes, withinBudget() else { truncate(current); continue }
        let descendants = children(element)
        guard !descendants.isEmpty else { continue }
        // Retain the observed container/ref and explicitly defer its subtree.
        // A scoped expand starts from a fresh root, so it can still read it.
        if offscreen(current) { truncate(current); continue }
        for child in descendants {
            guard count < maxNodes, withinBudget() else { truncate(current); break }
            guard seen.insert(identity(child)).inserted else { continue }
            let childNode = describe(child, element)
            append(current, childNode)
            queue.append((child, childNode))
            count += 1
        }
    }
}

// Capability and availability are independent. A provider may declare a value
// setter even when the editor is disabled; retain false and unknown verbatim.
func observedAvailability(canPress: Bool, hasConfirm: Bool, canSetValue: Bool,
                          isTextInput: Bool, read: () -> Bool?) -> Bool? {
    guard canPress || hasConfirm || canSetValue || isTextInput else { return nil }
    return read()
}
