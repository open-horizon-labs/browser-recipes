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
    error = {"code": "TEST_REQUEST_REJECTED", "message": "The fixture rejected this request."}
    if command == "status":
        result = {"connected": not (stage / "disconnected").exists()}
    elif command == "models":
        result = {"models": [{"id": "fixture-model", "name": "Fixture model"}]}
    elif command == "plan":
        args = request["args"]
        if args["model"] == "fixture-model" and "Check session recovery" in args["prompt"]:
            result = None
            error = {"code": "SESSION_EXPIRED", "message": "The ChatGPT session expired or was disconnected. Sign in again."}
        elif args["model"] == "fixture-model" and "Which tab should I select?" in args["prompt"]:
            result = {"text": json.dumps({"answer": "Choose the tab with the news page.", "actions": ["choose-tab"]})}
        elif "Remove the second fixture event and rename the first." in args["prompt"]:
            result = {"text": json.dumps([{"op":"remove","path":["events",1]}, {"op":"replace","path":["events",0,"text"],"value":"Edited fixture event"}])}
        elif "Change the fixture message to Edited." in args["prompt"]:
            result = {"text": json.dumps([{"op":"replace","path":["message"],"value":"Edited"}])}
        elif args["model"] != "fixture-model" or "Reviewed workshop" not in args["prompt"] or "destination-1" not in args["prompt"]:
            result = None
        else:
            result = {"text": (stage / "normalized.json").read_text()}
    else:
        result = None
    reply = {"result": result} if result is not None else {"error": error}
    raw = json.dumps(reply).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(raw)) + raw)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
