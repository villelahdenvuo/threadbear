import AppKit
import CoreGraphics
import Testing
@testable import BearDock

// A tab strip that overflows scrolls sideways. A mouse wheel only scrolls up
// and down, so over the strip its turn becomes a sideways one (Ville, 11 Nov:
// "scroll wheel does nothing, touchpad swipe and chevron work").

@MainActor private func wheel(vertical: Int32, horizontal: Int32 = 0, units: CGScrollEventUnit = .line, phase: Int64 = 0) -> NSEvent {
    let cg = CGEvent(scrollWheelEvent2Source: nil, units: units, wheelCount: 2, wheel1: vertical, wheel2: horizontal, wheel3: 0)!
    cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
    return NSEvent(cgEvent: cg)!
}

@MainActor @Test func aWheelTurnBecomesSideways() throws {
    let turned = try #require(WheelSideways.sideways(wheel(vertical: -3)))
    #expect(turned.scrollingDeltaY == 0)
    #expect(turned.scrollingDeltaX != 0)
    // Down the page goes right along the strip, as in Finder and Safari's tab bar.
    #expect((turned.scrollingDeltaX < 0) == (wheel(vertical: -3).scrollingDeltaY < 0))
}

@MainActor @Test func aSidewaysScrollIsLeftAlone() {
    // Shift and the wheel, or a tilt wheel: already sideways.
    #expect(WheelSideways.sideways(wheel(vertical: 0, horizontal: 2)) == nil)
}

@MainActor @Test func aTrackpadIsLeftAlone() {
    // A scroll with a phase is a trackpad or Magic Mouse: those swipe sideways
    // already, and turning their up-and-down into sideways would fight the swipe.
    #expect(WheelSideways.sideways(wheel(vertical: -12, units: .pixel, phase: 1)) == nil)
}

@MainActor @Test func aSmoothScrollingMouseIsTurnedToo() {
    // Mouse drivers with smooth scrolling send pixels, but no phase.
    #expect(WheelSideways.sideways(wheel(vertical: -12, units: .pixel)) != nil)
}
