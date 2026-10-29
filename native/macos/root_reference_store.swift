// AX equality is a reuse hint, not a process/window/type binding.
struct NativeRootBinding: Equatable {
    let pid: Int32
    let windowId: UInt32?
    let role: String
    let subrole: String
}

struct RefreshedRootReferenceStore<Element> {
    struct Record {
        let element: Element
        let binding: NativeRootBinding
    }
    private var records: [String: Record] = [:]

    mutating func store(_ element: Element, binding: NativeRootBinding,
                        equivalent: (Element, Element) -> Bool,
                        makeRef: () -> String) -> String {
        let reused = records.first { _, record in
            record.binding == binding && equivalent(record.element, element)
        }?.key
        let ref = reused ?? makeRef()
        records[ref] = Record(element: element, binding: binding)
        return ref
    }

    func record(for ref: String) -> Record? { records[ref] }
}

func uniqueBoundRootIndex(expected: NativeRootBinding,
                          candidates: [(binding: NativeRootBinding, equivalent: Bool)]) -> Int? {
    let matches = candidates.indices.filter {
        candidates[$0].equivalent && candidates[$0].binding == expected
    }
    return matches.count == 1 ? matches[0] : nil
}

// Chromium can nest an ordinary toolbar more than twenty AX parents deep.
// Keep exact ancestor identity and a finite, cycle-safe walk; never substitute
// a matching process or role for membership in the observed window.
func nativeElementHasAncestor<Element>(_ element: Element, ancestor: Element,
                                      maximumDepth: Int = 128,
                                      equivalent: (Element, Element) -> Bool,
                                      parent: (Element) -> Element?) -> Bool {
    var current: Element? = element
    var visited: [Element] = []
    while let candidate = current, visited.count < maximumDepth {
        if equivalent(candidate, ancestor) { return true }
        if visited.contains(where: { equivalent($0, candidate) }) { return false }
        visited.append(candidate)
        current = parent(candidate)
    }
    return false
}
