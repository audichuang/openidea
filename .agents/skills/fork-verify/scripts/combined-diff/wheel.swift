// Real CGEvent scroll-wheel input in screen points.
// Usage: wheel X Y DELTA_PX COUNT [INTERVAL_MS]   (DELTA_PX > 0 scrolls content down)
import CoreGraphics
import Foundation
let a = CommandLine.arguments.dropFirst().compactMap { Double($0) }
let p = CGPoint(x: a[0], y: a[1])
let delta = Int32(a[2]), count = Int(a[3]), interval = a.count > 4 ? a[4] : 40
CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
usleep(80_000)
for _ in 0..<count {
    let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: -delta, wheel2: 0, wheel3: 0)
    e?.location = p
    e?.post(tap: .cghidEventTap)
    usleep(useconds_t(interval * 1000))
}
