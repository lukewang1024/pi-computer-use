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
        show(above: windowId, at: point)
        AgentCursorRenderer.shared.moveTo(point: point)
        startFrameLoop()
        scheduleHide(after: 8)
    }

    func animate(points: [CGPoint], durationMs: Double, above windowId: UInt32) {
        guard points.count >= 2 else { return }
        show(above: windowId, at: points[0])
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
                updateSurface(at: renderer.position)
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

    private func show(above windowId: UInt32, at point: CGPoint) {
        idleHideTask?.cancel()
        idleHideTask = nil
        idleGeneration &+= 1

        let window = ensureWindow(at: point)
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

    private static func screenFrame(at point: CGPoint) -> CGRect {
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        let appKitPoint = CGPoint(x: point.x, y: primaryTop - point.y)
        return (NSScreen.screens.first { $0.frame.contains(appKitPoint) } ?? NSScreen.screens.first)?.frame ?? .zero
    }

    private func updateSurface(at point: CGPoint) {
        guard let overlay else { return }
        let frame = Self.screenFrame(at: point)
        guard overlay.frame != frame else { return }
        overlay.setFrame(frame, display: true)
        overlay.contentView = NSHostingView(rootView: AgentCursorView(screenFrame: frame).accessibilityHidden(true))
    }

    private func ensureWindow(at point: CGPoint) -> AgentCursorOverlayWindow {
        if let overlay { updateSurface(at: point); return overlay }
        let frame = Self.screenFrame(at: point)
        let window = AgentCursorOverlayWindow(
            contentRect: frame,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = NSHostingView(rootView: AgentCursorView(screenFrame: frame).accessibilityHidden(true))
        overlay = window
        return window
    }
}

/// A display-sized, click-through overlay that can never take focus.
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
    let screenFrame: CGRect

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
        let point = CGPoint(x: position.x - screenFrame.minX - 2,
                            y: position.y - ((NSScreen.screens.first?.frame.maxY ?? 0) - screenFrame.maxY) - 1)
        guard point.x.isFinite, point.y.isFinite else { return }
        // Shared glow: src/agent-cursor-style.json. The arrow and action hotspot
        // stay compact; only the translucent, click-through halo extends outward.
        let glowCenter = CGPoint(x: point.x + 9, y: point.y + 9)
        let glowRadius: CGFloat = 33
        let stops: [Gradient.Stop] = [
            .init(color: Color(red: 97/255, green: 92/255, blue: 89/255).opacity(0.40), location: 0),
            .init(color: Color(red: 110/255, green: 105/255, blue: 102/255).opacity(0.28), location: 0.50),
            .init(color: Color(red: 117/255, green: 112/255, blue: 110/255).opacity(0.11), location: 0.82),
            .init(color: Color(red: 153/255, green: 153/255, blue: 153/255).opacity(0), location: 1),
        ]
        graphics.fill(Path(ellipseIn: CGRect(x: glowCenter.x-glowRadius, y: glowCenter.y-glowRadius,
                                            width: glowRadius*2, height: glowRadius*2)),
                      with: .radialGradient(Gradient(stops: stops), center: glowCenter,
                                            startRadius: 0, endRadius: glowRadius))

        do {
            let points = [CGPoint(x: 3, y: 1), CGPoint(x: 2, y: 1), CGPoint(x: 1, y: 2), CGPoint(x: 1, y: 3), CGPoint(x: 6, y: 16), CGPoint(x: 7, y: 17), CGPoint(x: 8, y: 17), CGPoint(x: 9, y: 16), CGPoint(x: 11, y: 11), CGPoint(x: 16, y: 9), CGPoint(x: 17, y: 8), CGPoint(x: 17, y: 7), CGPoint(x: 16, y: 6), CGPoint(x: 4, y: 1)]
            var shape = Path()
            shape.addLines(points)
            shape.closeSubpath()
            graphics.fill(shape.applying(CGAffineTransform(translationX: point.x, y: point.y)),
                          with: .color(Color(red: 230/255, green: 230/255, blue: 230/255)))
        }
        do {
            let points = [CGPoint(x: 3, y: 3), CGPoint(x: 7, y: 15), CGPoint(x: 8, y: 15), CGPoint(x: 10, y: 10), CGPoint(x: 15, y: 8), CGPoint(x: 15, y: 7)]
            var shape = Path()
            shape.addLines(points)
            shape.closeSubpath()
            graphics.fill(shape.applying(CGAffineTransform(translationX: point.x, y: point.y)),
                          with: .color(Color(red: 97/255, green: 92/255, blue: 89/255)))
        }
    }
}
