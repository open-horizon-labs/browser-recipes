#!/usr/bin/env python3
"""Isolated native hosts with synthetic replies. No network or credentials."""
import base64
import json
import pathlib
import struct
import sys


stage = pathlib.Path(__file__).parent
scan = (stage / "invoice-scan.pdf").read_bytes()
record_id = "a" * 32
attachment_id = "b" * 32


def respond(value):
    body = json.dumps(value).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(body)) + body)
    sys.stdout.buffer.flush()


def log(event):
    with (stage / "events.log").open("a") as logfile:
        print(event, file=logfile)


def plan(args):
    prompt = args.get("prompt", "")
    files = args.get("attachments", [])
    if args.get("model") != "fixture-model":
        return None
    if files:
        if len(files) != 1 or files[0]["mimeType"] != "application/pdf" or base64.b64decode(files[0]["base64"]) != scan:
            return None
        assert files[0]["base64"] not in prompt
        log("plan:scan")
    elif '"kind":"markdown"' in prompt and "Invoice number" in prompt:
        log("plan:text")
    elif '"kind":"omitted-attachment"' in prompt:
        log("plan:omitted")
    else:
        return None
    return {"text": json.dumps({"fields": {
        "invoice-number": {"value": "INV-1042", "quote": "Invoice number: INV-1042", "format": "text", "page": 1},
        "total": {"value": 135, "raw": "135.00", "quote": "Grand total: 135.00", "format": "number", "page": 1},
        "invented": {"value": "PO-0000", "quote": "Purchase order: PO-0000", "page": 1},
    }})}


def source(request):
    op, args = request["operation"], request["args"]
    if args.get("source") != "fixture-records":
        return None
    log("source:" + op)
    if op == "records":
        return {"records": [{"id": record_id, "label": "Fixture record", "fields": {"number": "INV-1042"}}]}
    if args.get("record") != record_id:
        return None
    if op == "attachments":
        return {"attachments": [{
            "id": attachment_id, "name": "Invoice scan", "mimeType": "application/pdf", "bytes": len(scan), "available": True,
        }]}
    if op == "document" and args.get("attachment") == attachment_id:
        return {"document": {
            "kind": "file", "name": "invoice-scan.pdf", "mimeType": "application/pdf",
            "base64": base64.b64encode(scan).decode("ascii"),
        }}
    return None


header = sys.stdin.buffer.read(4)
size, = struct.unpack("=I", header)
request = json.loads(sys.stdin.buffer.read(size))
if pathlib.Path(__file__).name.startswith("source"):
    result = source(request)
    envelope = {"id": request["id"]}
else:
    command = request["command"]
    envelope = {}
    if command == "status":
        result = {"connected": True}
    elif command == "models":
        result = {"models": [{"id": "fixture-model", "name": "Fixture model"}]}
    elif command == "plan":
        result = plan(request["args"])
    else:
        result = None
envelope.update({"result": result} if result is not None else {"error": {"code": "FIXTURE_INVALID"}})
respond(envelope)
