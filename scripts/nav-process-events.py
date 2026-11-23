"""Reduce the shard's private tracerpt XML to process observations, never raw payloads."""

import ctypes
import json
import ntpath
from xml.etree import ElementTree as ET


PROCESS = "{3d6fa8d0-fe05-11d0-9dda-00c04fd7ba7c}"
HEADER = "{68fdd900-4a3e-11d1-84f4-0000f80464e3}"
STAGE = {1: "process-start", 2: "process-exit", 3: "process-live-at-start", 4: "process-live-at-stop"}
IMAGES = {"ompdesk-shell.exe", "msedgewebview2.exe"}
UNIX_EPOCH_FILETIME = 116444736000000000
SHORT_IMAGES = {name[:15] for name in IMAGES}
split_cmd = ctypes.windll.shell32.CommandLineToArgvW
split_cmd.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
split_cmd.restype = ctypes.POINTER(ctypes.c_wchar_p)
free_cmd = ctypes.windll.kernel32.LocalFree
free_cmd.argtypes = [ctypes.c_void_p]
free_cmd.restype = ctypes.c_void_p


def epoch_ms(filetime: int) -> int:
    return (filetime - UNIX_EPOCH_FILETIME) // 10000


def image_role(image, cmd):
    if image not in IMAGES and image not in SHORT_IMAGES:
        return None
    argc = ctypes.c_int()
    argv = split_cmd(cmd, ctypes.byref(argc)) if cmd else None
    try:
        if image not in IMAGES:
            exe = ntpath.basename(argv[0]).lower() if argv and argc.value else ""
            if exe not in IMAGES or image != exe[:15]:
                return None
            image = exe
        if image == "ompdesk-shell.exe":
            return image, "shell"
        if not argv:
            return image, "unknown"
        for i in range(1, argc.value):
            arg = argv[i].lower()
            if arg.startswith("--type="):
                role = arg[7:]
                return image, role if role in ("renderer", "gpu-process", "utility", "crashpad-handler") else "other"
        return image, "browser"
    finally:
        if argv:
            free_cmd(argv)


def observation(opcode, stamp, data, active, serial):
    pid = int(data["ProcessId"], 0)
    key = int(data.get("UniqueProcessKey") or "0", 0)
    image = ntpath.basename(data.get("ImageFileName", "")).lower()
    instance = active.get(pid)
    if (opcode == 1 or (instance and key and instance[0] and key != instance[0])
            or (instance and not (key and instance[0]) and image
                and image not in (instance[2], instance[2][:15], ntpath.splitext(instance[2])[0]))):
        instance = None
    if opcode == 1 or (opcode == 2 and instance):
        active.pop(pid, None)

    if not instance:
        match = image_role(image, data.get("CommandLine", ""))
        if not match:
            return None
        instance = (key, serial, *match, int(data["ParentId"], 0))
    if opcode != 2:
        active[pid] = instance
    return {"stage": STAGE[opcode], "atMs": epoch_ms(stamp), "instance": instance[1],
            "pid": pid, "parentPid": instance[4], "image": instance[2], "role": instance[3]}


def transform(source, output):
    stream = ET.iterparse(source, events=("start", "end"))
    _, root = next(stream)
    active = {}
    counts = dict.fromkeys(STAGE, 0)
    header = None
    for action, event in stream:
        if action != "end" or event.tag.rsplit("}", 1)[-1] != "Event":
            continue
        guid = event.findtext("{*}ExtendedTracingInfo/{*}EventGuid", "").lower()
        opcode = int(event.findtext("{*}System/{*}Opcode", "0"))
        if (guid == HEADER and opcode == 0) or (guid == PROCESS and opcode in STAGE):
            data = {node.attrib["Name"]: (node.text or "").strip()
                    for node in event.findall("{*}EventData/{*}Data")}
            if guid == HEADER:
                # logman -ct system and tracerpt -rts give UTC FILETIME, not tracerpt's local offset.
                if int(data["ReservedFlags"], 0) & 3 != 2:
                    raise ValueError("unexpected ETW clock")
                header = {"stage": "process-trace-summary", "startMs": epoch_ms(int(data["StartTime"])),
                          "endMs": epoch_ms(int(data["EndTime"])), "eventsLost": int(data["EventsLost"]),
                          "buffersLost": int(data["BuffersLost"])}
            else:
                counts[opcode] += 1
                stamp = int(event.find("{*}System/{*}TimeCreated").attrib["RawTime"])
                row = observation(opcode, stamp, data, active, sum(counts.values()))
                if row:
                    output.write(json.dumps(row) + "\n")
        root.clear()
    if header is None or not any(counts.values()):
        raise ValueError("missing kernel process trace")
    header["systemEventCounts"] = {STAGE[op]: n for op, n in counts.items()}
    output.write(json.dumps(header) + "\n")


if __name__ == "__main__":
    with open("nav-process.xml", "rb") as source, open("nav-process.jsonl", "w", encoding="utf-8") as out:
        transform(source, out)
