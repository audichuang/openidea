// Real CGEvent drag in screen points: down, 20 dragged steps, up. Usage: swift drag.swift x1 y1 x2 y2
import CoreGraphics
import Foundation
let a = CommandLine.arguments.dropFirst().compactMap { Double($0) }
let p1 = CGPoint(x: a[0], y: a[1]), p2 = CGPoint(x: a[2], y: a[3])
func post(_ t: CGEventType, _ p: CGPoint) {
    CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}
post(.mouseMoved, p1); usleep(100_000)
post(.leftMouseDown, p1); usleep(200_000)
for i in 1...20 {
    let f = Double(i) / 20
    post(.leftMouseDragged, CGPoint(x: p1.x + (p2.x - p1.x) * f, y: p1.y + (p2.y - p1.y) * f)); usleep(30_000)
}
usleep(300_000)
post(.leftMouseUp, p2)
