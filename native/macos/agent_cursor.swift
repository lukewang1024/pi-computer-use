import AppKit
import SwiftUI

/// Visual-only cursor; native action delivery remains authoritative.
@MainActor
final class AgentCursor {
    typealias IdleHideScheduler = @MainActor (@escaping @MainActor () -> Void) -> Task<Void, Never>

    static let shared = AgentCursor(scheduleIdleHide: scheduleDefaultIdleHide)

    private var overlay: AgentCursorOverlayWindow?
    private var idleHideTask: Task<Void, Never>?
    private var frameTask: Task<Void, Never>?
    private var idleGeneration: UInt = 0
    private let scheduleIdleHide: IdleHideScheduler

    init(scheduleIdleHide: @escaping IdleHideScheduler) {
        self.scheduleIdleHide = scheduleIdleHide
    }

    func animate(to point: CGPoint, above windowId: UInt32) {
        show(above: windowId)
        AgentCursorRenderer.shared.moveTo(point: point)
        startFrameLoop()
        scheduleHide(after: 8)
    }

    func animate(points: [CGPoint], durationMs: Double, above windowId: UInt32) {
        guard points.count >= 2 else { return }
        show(above: windowId)
        let renderer = AgentCursorRenderer.shared
        var trajectory = points
        if trajectory.count == 2, trajectory[0] == trajectory[1] { trajectory[0] = renderer.position }
        renderer.moveAlong(points: trajectory, durationMs: durationMs)
        startFrameLoop()
        scheduleHide(after: max(8, durationMs / 1000 + 2))
    }

    private func startFrameLoop() {
        frameTask?.cancel()
        frameTask = Task { @MainActor in
            let renderer = AgentCursorRenderer.shared
            while !Task.isCancelled, renderer.isAnimating {
                renderer.tick(now: Date.timeIntervalSinceReferenceDate)
                try? await Task.sleep(for: .milliseconds(16))
            }
        }
    }

    func status() -> [String: Any] {
        let renderer = AgentCursorRenderer.shared
        return ["visible": overlay?.isVisible ?? false, "animating": renderer.isAnimating,
                "samples": renderer.renderedSamples, "x": renderer.position.x, "y": renderer.position.y]
    }

    func hide() {
        idleGeneration &+= 1
        idleHideTask?.cancel()
        idleHideTask = nil
        frameTask?.cancel()
        frameTask = nil
        AgentCursorRenderer.shared.cancelAnimation()
        overlay?.orderOut(nil)
        overlay?.contentView = nil
        overlay?.close()
        overlay = nil
    }

    private func show(above windowId: UInt32) {
        idleHideTask?.cancel()
        idleHideTask = nil
        idleGeneration &+= 1

        let window = ensureWindow()
        if !window.isVisible { window.orderFrontRegardless() }
        window.order(.above, relativeTo: Int(windowId))

        let renderer = AgentCursorRenderer.shared
        if renderer.position == CGPoint(x: -200, y: -200) {
            renderer.setInitialPosition(CGPoint(x: 20, y: 20))
        }
    }

    private func scheduleHide(after seconds: Double) {
        let renderer = AgentCursorRenderer.shared
        let generation = idleGeneration
        let window = overlay
        let hide: @MainActor () -> Void = { [weak self, weak window] in
            guard let self, let window else { return }
            guard generation == idleGeneration, self.overlay === window else { return }

            frameTask?.cancel()
            frameTask = nil
            renderer.cancelAnimation()
            window.orderOut(nil)
            window.contentView = nil
            window.close()
            overlay = nil
            idleHideTask = nil
        }
        if seconds <= 8 {
            idleHideTask = scheduleIdleHide(hide)
        } else {
            idleHideTask = Task { @MainActor in
                try? await Task.sleep(for: .seconds(seconds))
                guard !Task.isCancelled else { return }
                hide()
            }
        }
    }

    private static func scheduleDefaultIdleHide(_ hide: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled else { return }
            hide()
        }
    }

    private static var desktopFrame: CGRect {
        NSScreen.screens.reduce(CGRect.null) { $0.union($1.frame) }
    }

    private func ensureWindow() -> AgentCursorOverlayWindow {
        if let overlay { overlay.setFrame(Self.desktopFrame, display: true); return overlay }
        let window = AgentCursorOverlayWindow(
            contentRect: Self.desktopFrame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = NSHostingView(rootView: AgentCursorView().accessibilityHidden(true))
        overlay = window
        return window
    }
}

/// Desktop-wide, click-through overlay that can never take focus.
private final class AgentCursorOverlayWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override init(contentRect: NSRect, styleMask: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: styleMask, backing: backing, defer: flag)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
    }
}

@MainActor
private struct AgentCursorView: View {
    @Bindable private var renderer = AgentCursorRenderer.shared

    var body: some View {
        let position = renderer.position
        return Canvas { graphics, _ in
            drawCursor(in: graphics, position: position)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    // Shared geometry and palette: src/agent-cursor-style.json. Fixed orientation.
    private func drawCursor(in graphics: GraphicsContext, position: CGPoint) {
        let desktop = NSScreen.screens.reduce(CGRect.null) { $0.union($1.frame) }
        let point = CGPoint(x: position.x - desktop.minX - 3,
                            y: position.y - ((NSScreen.screens.first?.frame.maxY ?? 0) - desktop.maxY) - 2)
        guard point.x.isFinite, point.y.isFinite else { return }
        do {
            let points = [CGPoint(x: 3, y: 0), CGPoint(x: 2, y: 0), CGPoint(x: 1, y: 0), CGPoint(x: 1, y: 1), CGPoint(x: 1, y: 2), CGPoint(x: 10, y: 32), CGPoint(x: 10, y: 33), CGPoint(x: 10, y: 34), CGPoint(x: 11, y: 34), CGPoint(x: 17, y: 20), CGPoint(x: 18, y: 20), CGPoint(x: 18, y: 19), CGPoint(x: 19, y: 18), CGPoint(x: 30, y: 11), CGPoint(x: 31, y: 11), CGPoint(x: 30, y: 10), CGPoint(x: 29, y: 10)]
            var shape = Path()
            shape.addLines(points)
            shape.closeSubpath()
            graphics.fill(shape.applying(CGAffineTransform(translationX: point.x, y: point.y)),
                          with: .color(Color(red: 76/255, green: 29/255, blue: 149/255)))
        }
        do {
            let points = [CGPoint(x: 4, y: 1), CGPoint(x: 3, y: 1), CGPoint(x: 2, y: 1), CGPoint(x: 2, y: 2), CGPoint(x: 2, y: 3), CGPoint(x: 10, y: 31), CGPoint(x: 10, y: 32), CGPoint(x: 11, y: 32), CGPoint(x: 17, y: 20), CGPoint(x: 17, y: 19), CGPoint(x: 18, y: 18), CGPoint(x: 19, y: 18), CGPoint(x: 29, y: 11), CGPoint(x: 29, y: 10), CGPoint(x: 28, y: 10), CGPoint(x: 27, y: 10)]
            var shape = Path()
            shape.addLines(points)
            shape.closeSubpath()
            graphics.fill(shape.applying(CGAffineTransform(translationX: point.x, y: point.y)),
                          with: .color(Color(red: 255/255, green: 255/255, blue: 255/255)))
        }
        do {
            let points = [CGPoint(x: 6, y: 4), CGPoint(x: 5, y: 4), CGPoint(x: 4, y: 4), CGPoint(x: 5, y: 5), CGPoint(x: 10, y: 26), CGPoint(x: 11, y: 27), CGPoint(x: 16, y: 18), CGPoint(x: 16, y: 17), CGPoint(x: 17, y: 17), CGPoint(x: 24, y: 11), CGPoint(x: 23, y: 10)]
            var shape = Path()
            shape.addLines(points)
            shape.closeSubpath()
            graphics.fill(shape.applying(CGAffineTransform(translationX: point.x, y: point.y)),
                          with: .color(Color(red: 139/255, green: 92/255, blue: 246/255)))
        }
    }
}
