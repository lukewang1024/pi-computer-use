// Shared by native AX observation and deterministic traversal regressions.
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

struct ConditionScan<Element> {
    let match: Element?
    let complete: Bool
    let nodeCount: Int

    // A positive match proves presence even if other branches were unreadable.
    // Absence requires a complete read of the requested scope.
    func satisfies(gone: Bool) -> Bool? {
        if case .some = match { return !gone }
        return complete ? gone : nil
    }
}

// Native conditions must reach deeply nested web controls, just as observation
// does. Bound work by unique nodes and the caller's deadline, not wrapper depth.
// nil children means a failed native read, rather than a proven leaf.
func scanCondition<Element>(
    root: Element, maxNodes: Int,
    identity: (Element) -> AnyHashable,
    children: (Element) -> [Element]?,
    matches: (Element) -> Bool,
    withinBudget: () -> Bool
) -> ConditionScan<Element> {
    let limit = max(1, maxNodes)
    var queue = [root]
    var seen = Set<AnyHashable>([identity(root)])
    var index = 0
    var complete = true
    while index < queue.count {
        guard withinBudget() else {
            return ConditionScan(match: nil, complete: false, nodeCount: index)
        }
        let element = queue[index]
        index += 1
        if matches(element) {
            return ConditionScan(match: element, complete: false, nodeCount: index)
        }
        guard withinBudget() else {
            return ConditionScan(match: nil, complete: false, nodeCount: index)
        }
        guard let descendants = children(element) else { complete = false; continue }
        for child in descendants {
            guard withinBudget() else {
                return ConditionScan(match: nil, complete: false, nodeCount: index)
            }
            guard seen.insert(identity(child)).inserted else { continue }
            guard queue.count < limit else { complete = false; continue }
            queue.append(child)
        }
    }
    return ConditionScan(match: nil, complete: complete, nodeCount: index)
}
