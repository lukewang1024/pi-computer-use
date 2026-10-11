// Application-menu ownership is distinct from window-descendant ownership.
// These predicates require freshly read identities; callers must not substitute
// cached process IDs or use them to authorize keyboard/pointer delivery.
func nativeReferenceRequiresCachedElement(action: String, popupMenu: Bool, applicationMenu: Bool) -> Bool {
    return popupMenu || applicationMenu || action == "selectText" || action == "cancel"
}

func nativeRefindSemanticMatch(observedRole: String, observedIdentifier: String, observedLabel: String,
                              currentRole: String, currentIdentifier: String, currentLabel: String) -> Bool {
    guard currentRole == observedRole else { return false }
    guard !observedIdentifier.isEmpty || !observedLabel.isEmpty else { return false }
    if !observedIdentifier.isEmpty && currentIdentifier != observedIdentifier { return false }
    // AX identifiers can name a shared action handler, not a unique control.
    if !observedLabel.isEmpty && currentLabel != observedLabel { return false }
    return true
}

struct AppMenuIdentity {
    var pid: Int32
    var windowId: UInt32
    var menuBarRole: String
    var menuBarOwnerPid: Int32?
    var windowOwnerPid: Int32?
    var frontmostPid: Int32?
    var focusedWindowId: UInt32?
    var frontmostWindowId: UInt32?
    var sameObservedMenuBar: Bool
}

enum AppMenuRefusal: String {
    case invalidTarget, foreignOwner, backgroundApplication, wrongWindow, staleMenuBar
    case foreignElement, disabledElement, unsupportedAction
}

func appMenuIdentityRefusal(_ identity: AppMenuIdentity) -> AppMenuRefusal? {
    guard identity.pid > 0, identity.windowId > 0, identity.menuBarRole == "AXMenuBar" else {
        return .invalidTarget
    }
    guard identity.menuBarOwnerPid == identity.pid, identity.windowOwnerPid == identity.pid else {
        return .foreignOwner
    }
    guard identity.frontmostPid == identity.pid else { return .backgroundApplication }
    guard identity.focusedWindowId == identity.windowId,
          identity.frontmostWindowId == identity.windowId else { return .wrongWindow }
    guard identity.sameObservedMenuBar else { return .staleMenuBar }
    return nil
}

func appMenuInvocationRefusal(_ identity: AppMenuIdentity, elementOwnerPid: Int32?,
                              descendantOfObservedMenuBar: Bool, enabled: Bool?,
                              declaredActions: [String]) -> AppMenuRefusal? {
    if let refusal = appMenuIdentityRefusal(identity) { return refusal }
    guard elementOwnerPid == identity.pid, descendantOfObservedMenuBar else { return .foreignElement }
    guard enabled == true else { return .disabledElement }
    guard declaredActions.contains("AXPress") else { return .unsupportedAction }
    return nil
}
