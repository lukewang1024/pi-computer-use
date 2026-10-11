@main struct AppMenuIdentityTests {
    static func main() {
        let observed = AppMenuIdentity(pid: 100, windowId: 20, menuBarRole: "AXMenuBar",
            menuBarOwnerPid: 100, windowOwnerPid: 100, frontmostPid: 100,
            focusedWindowId: 20, frontmostWindowId: 20, sameObservedMenuBar: true)
        precondition(appMenuIdentityRefusal(observed) == nil)
        precondition(appMenuInvocationRefusal(observed, elementOwnerPid: 100,
            descendantOfObservedMenuBar: true, enabled: true, declaredActions: ["AXPress"]) == nil)
        var changed = observed
        changed.windowId = 0
        precondition(appMenuIdentityRefusal(changed) == .invalidTarget)
        changed = observed; changed.menuBarOwnerPid = 101
        precondition(appMenuIdentityRefusal(changed) == .foreignOwner)
        changed = observed; changed.windowOwnerPid = nil
        precondition(appMenuIdentityRefusal(changed) == .foreignOwner)
        changed = observed; changed.frontmostPid = 101
        precondition(appMenuIdentityRefusal(changed) == .backgroundApplication)
        // A floating window in the same process must not satisfy exact-window checks.
        changed = observed; changed.frontmostWindowId = 21
        precondition(appMenuIdentityRefusal(changed) == .wrongWindow)
        changed = observed; changed.focusedWindowId = nil
        precondition(appMenuIdentityRefusal(changed) == .wrongWindow)
        changed = observed; changed.sameObservedMenuBar = false
        precondition(appMenuIdentityRefusal(changed) == .staleMenuBar)
        precondition(appMenuInvocationRefusal(observed, elementOwnerPid: 101,
            descendantOfObservedMenuBar: true, enabled: true, declaredActions: ["AXPress"]) == .foreignElement)
        precondition(appMenuInvocationRefusal(observed, elementOwnerPid: 100,
            descendantOfObservedMenuBar: false, enabled: true, declaredActions: ["AXPress"]) == .foreignElement)
        for enabled: Bool? in [false, nil] {
            precondition(appMenuInvocationRefusal(observed, elementOwnerPid: 100,
                descendantOfObservedMenuBar: true, enabled: enabled, declaredActions: ["AXPress"]) == .disabledElement)
        }
        precondition(appMenuInvocationRefusal(observed, elementOwnerPid: 100,
            descendantOfObservedMenuBar: true, enabled: true, declaredActions: []) == .unsupportedAction)
        print("PASS application-menu identity and invocation ownership refusals")
    }
}
