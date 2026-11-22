import json
from pathlib import Path
import runpy
from types import SimpleNamespace
import unittest

preview = runpy.run_path(str(Path(__file__).with_name("browser-recipes")))["workflow_preview"]


class PreviewTests(unittest.TestCase):
    def run_preview(self, tag, attachments=False, deny_model=False, text='{"tickets":[]}'):
        calls = []
        options = SimpleNamespace(workflow_id="sample", account=["source=work"], input=["enabled=false"],
                                  prompt="Skip archived tickets", model="model")
        definition = {"id": "sample", "inputs": {"enabled": {"type": "checkbox"}}}
        action = {"id": "internal-action", "tag": tag}
        waiting = {"status": "waiting", "runId": "internal-run", "pending": action}

        def send(command, encoded):
            args = json.loads(encoded)
            calls.append(command)
            if command == "definitions.list":
                data = {"workflows": [definition]}
            elif command == "runs.start":
                self.assertEqual(args["accounts"], {"source": "work"})
                self.assertEqual(args["inputs"], {"enabled": False})
                data = waiting
            elif command == "runs.get":
                data = {**waiting, "context": {"instruction": "List tickets", "choices": []}}
            elif command == "runs.agentReview":
                data = {"inputs": {"rows": []}, "attachments": ["file"] if attachments else []}
            elif command == "runs.agent":
                self.assertIn(options.prompt, args["prompt"])
                if deny_model:
                    return {"error": {"code": "MODEL_BLOCKED"}}
                data = {"text": text}
            elif command == "runs.resume":
                self.assertEqual(args["answer"], {"value": {"tickets": []}})
                action["tag"] = "selection"
                data = waiting
            else:
                self.fail(command)
            return {"result": data}

        response = preview(options, send)
        return response.get("result", response), calls

    def test_stops_before_write_auth_and_handoff(self):
        for tag in ["write", "uncertain-write", "auth", "handoff"]:
            result, calls = self.run_preview(tag)
            self.assertEqual(result["pending"]["tag"], tag)
            self.assertNotIn("runs.resume", calls)

    def test_custom_prompt_reaches_model_and_selection_is_never_answered(self):
        result, calls = self.run_preview("agent")
        self.assertEqual(result["status"], "preview")
        self.assertEqual(calls.count("runs.resume"), 1)

    def test_attachment_needs_review(self):
        result, calls = self.run_preview("agent", attachments=True)
        self.assertEqual(result["status"], "waiting")
        self.assertNotIn("runs.agent", calls)

    def test_denied_or_invalid_reply_never_advances(self):
        for options, code in [({"deny_model": True}, "MODEL_BLOCKED"), ({"text": "broken"}, "INVALID_MODEL_REPLY")]:
            result, calls = self.run_preview("agent", **options)
            self.assertEqual(result["error"]["code"], code)
            self.assertNotIn("runs.resume", calls)
