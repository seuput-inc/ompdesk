// swift window-id.swift: the window number of OMPdesk's largest on-screen window (an owner whose name holds "ompdesk"), for
// `screencapture -l`. Prints 0 when there is none. WKWebView has no DevTools endpoint, so a shipped Tauri app is photographed
// from the window server (scripts/shell-move/release-profile.ts).
import CoreGraphics
import Foundation

let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
var best = (number: 0, area: 0.0)
for window in windows {
	guard let owner = window[kCGWindowOwnerName as String] as? String, owner.lowercased().contains("ompdesk"),
		(window[kCGWindowLayer as String] as? Int) == 0,
		let bounds = window[kCGWindowBounds as String] as? [String: Double]
	else { continue }
	let area = (bounds["Width"] ?? 0) * (bounds["Height"] ?? 0)
	if area > best.area { best = (window[kCGWindowNumber as String] as? Int ?? 0, area) }
}
print(best.number)
