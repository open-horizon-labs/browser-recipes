#!/usr/bin/env python3
"""Disposable Chromium test host with deterministic replies and no network."""
import json
import pathlib
import struct
import sys


def main():
    header = sys.stdin.buffer.read(4)
    if len(header) != 4:
        sys.exit(1)
    size, = struct.unpack("=I", header)
    request = json.loads(sys.stdin.buffer.read(size))
    command = request["command"]
    stage = pathlib.Path(__file__).parent
    with (stage / "native-requests.log").open("a") as log:
        print(command, file=log)
    if command == "status":
        result = {"connected": not (stage / "disconnected").exists()}
    elif command == "models":
        result = {"models": [{"id": "fixture-model", "name": "Fixture model"}]}
    elif command == "plan":
        args = request["args"]
        if args["model"] != "fixture-model" or "Reviewed workshop" not in args["prompt"] or "destination-1" not in args["prompt"]:
            result = None
        else:
            result = {"text": (stage / "normalized.json").read_text()}
    else:
        result = None
    reply = {"result": result} if result is not None else {"error": {"code": "TEST_REQUEST_REJECTED"}}
    raw = json.dumps(reply).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(raw)) + raw)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
