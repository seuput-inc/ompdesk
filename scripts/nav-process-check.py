"""Windows: python -I scripts/nav-process-check.py"""

import json
import runpy
from pathlib import Path


probe = runpy.run_path(str(Path(__file__).with_name("nav-process-events.py")))
active = {}
base = {"ProcessId": "0x20", "ParentId": "0x10", "UniqueProcessKey": "0xa",
        "ImageFileName": "msedgewebview2.exe", "CommandLine": 'msedgewebview2.exe "--label=private --type=renderer"'}
stamp = probe["UNIX_EPOCH_FILETIME"] + 123450000


def observe(opcode, serial, **fields):
    return probe["observation"](opcode, stamp, base | fields, active, serial)


start = observe(1, 1)
assert (start["role"], start["pid"], start["parentPid"], start["atMs"]) == ("browser", 32, 16, 12345)
assert "private" not in json.dumps(start) and "0xa" not in json.dumps(start)
end = observe(2, 2, ImageFileName="msedgewebview2.exe"[:15], CommandLine="")
assert end == start | {"stage": "process-exit"}
renderer = observe(1, 3, UniqueProcessKey="0xb", CommandLine="msedgewebview2.exe --type=renderer")
assert renderer["instance"] != start["instance"] and renderer["role"] == "renderer"
assert observe(4, 4, UniqueProcessKey="0xb", ImageFileName="", CommandLine="") == renderer | {"stage": "process-live-at-stop"}
assert observe(1, 5, ImageFileName="unrelated.exe", CommandLine="") is None
assert observe(2, 6, ImageFileName="", CommandLine="") is None
