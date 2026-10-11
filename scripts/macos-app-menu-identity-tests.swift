@main struct AppMenuIdentityTests {
    static func main() {
        // Word's hidden Zoom submenu shares an action identifier. Matching
        // that handler must never turn a requested 125% into the first 500%.
        precondition(!nativeRefindSemanticMatch(observedRole: "AXMenuItem",
            observedIdentifier: "galleryItemSelected:", observedLabel: "125%",
            currentRole: "AXMenuItem", currentIdentifier: "galleryItemSelected:", currentLabel: "500%"))
        precondition(nativeRefindSemanticMatch(observedRole: "AXButton",
            observedIdentifier: "shared", observedLabel: "Save",
            currentRole: "AXButton", currentIdentifier: "shared", currentLabel: "Save"))
        precondition(!nativeRefindSemanticMatch(observedRole: "AXButton",
            observedIdentifier: "shared", observedLabel: "Save",
            currentRole: "AXButton", currentIdentifier: "other", currentLabel: "Save"))
        precondition(!nativeRefindSemanticMatch(observedRole: "AXButton",
            observedIdentifier: "", observedLabel: "",
            currentRole: "AXButton", currentIdentifier: "", currentLabel: ""))
        precondition(!nativeRefindSemanticMatch(observedRole: "AXButton",
            observedIdentifier: "shared", observedLabel: "Save",
            currentRole: "AXMenuItem", currentIdentifier: "shared", currentLabel: "Save"))
        for action in ["press", "invoke", "click", "typeText", "selectText", "cancel"] {
            precondition(nativeReferenceRequiresCachedElement(action: action, popupMenu: true, applicationMenu: false))
            precondition(nativeReferenceRequiresCachedElement(action: action, popupMenu: false, applicationMenu: true))
        }
        precondition(nativeReferenceRequiresCachedElement(action: "selectText", popupMenu: false, applicationMenu: false))
        precondition(nativeReferenceRequiresCachedElement(action: "cancel", popupMenu: false, applicationMenu: false))
        precondition(!nativeReferenceRequiresCachedElement(action: "press", popupMenu: false, applicationMenu: false))
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
