---
name: ompdesk-mobile-emulator
description: Use when an app change needs an iOS Simulator or Android emulator: list, boot, install, launch, tap, type, screenshot, read the UI tree or logs, and shut it down again with xcrun simctl or adb.
---

# Mobile emulators

Drive devices with the platform tools from bash; OMPdesk adds no wrapper. Show the person what you see: save a screenshot and open it with `gui_visualize`. The person can also watch a running device in the Preview's start page (Devices), and tap an Android one there.

## Ownership

- A process your bash starts (`emulator -avd …`, `adb`, a log stream) carries this tab's tag and ends with the tab. Start a long one as a background job.
- A Simulator is launchd's, not yours: `xcrun simctl shutdown <udid>` when you are done with a device you booted. Leave a device the person booted running.

## iOS Simulator (macOS, Xcode)

| Goal | Command |
| --- | --- |
| Devices | `xcrun simctl list devices available --json` (booted: `xcrun simctl list devices booted`) |
| Boot | `xcrun simctl boot <udid>`, then `xcrun simctl bootstatus <udid> -b`; `open -a Simulator` only when the person should see the window |
| Install, launch | `xcrun simctl install <udid> <path.app>`; `xcrun simctl launch --terminate-running-process <udid> <bundle-id>` |
| Open a link | `xcrun simctl openurl <udid> <url>` |
| Screenshot | `xcrun simctl io <udid> screenshot <file.png>` |
| Settings | `xcrun simctl ui <udid> appearance dark`; `xcrun simctl privacy <udid> grant photos <bundle-id>`; `xcrun simctl location <udid> set <lat>,<lon>` |
| Logs | `xcrun simctl spawn <udid> log stream --predicate 'process == "<name>"'` (background job) |

simctl cannot tap or type. For touches and keys, drive the Simulator window with the computer-use tools (agent-desktop), or test through the app's own UI tests (`xcodebuild test`).

## Android (emulator or USB device)

| Goal | Command |
| --- | --- |
| Devices | `adb devices -l`; images: `emulator -list-avds` |
| Boot | `emulator -avd <name> -no-snapshot-save` as a background job, then `adb -s <serial> wait-for-device` |
| Install, launch | `adb -s <serial> install -r <app.apk>`; `adb -s <serial> shell monkey -p <package> 1` |
| Tap, swipe | `adb -s <serial> shell input tap <x> <y>`; `… input swipe <x1> <y1> <x2> <y2> <ms>` (screen pixels) |
| Type, keys | `adb -s <serial> shell input text '<text>'` (`%s` is a space); `… input keyevent KEYCODE_BACK` |
| Screenshot | `adb -s <serial> exec-out screencap -p > <file.png>` |
| UI tree | `adb -s <serial> exec-out uiautomator dump /dev/tty` (tap a node at the centre of its `bounds`) |
| Logs | `adb -s <serial> logcat -d -t 200` (or `logcat` as a background job) |
| Stop | `adb -s <serial> emu kill` for an emulator you started |

Always pass `-s <serial>` once more than one device is attached.
