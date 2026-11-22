import json
import os
from pathlib import Path
import select
import socket
import stat
import struct
import subprocess
import tempfile
import time
import unittest


CLI = Path(__file__).with_name("browser-recipes").resolve()
EXTENSION_ID = "abcdefghijklmnop" * 2
HEADER = struct.Struct("=I")


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**os.environ, "HOME": self.temp.name, "XDG_RUNTIME_DIR": self.temp.name}

    def cli(self, *args, **kwargs):
        return subprocess.run(
            [CLI, *args], env=self.env, capture_output=True, text=True, timeout=5, **kwargs
        )

    def browser(self):
        process = subprocess.Popen(
            [CLI, f"chrome-extension://{EXTENSION_ID}/"],
            env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

        def cleanup():
            if not process.stdin.closed:
                process.stdin.close()
            try:
                process.wait(timeout=5)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                process.stdout.close()
                process.stderr.close()

        self.addCleanup(cleanup)
        return process

    def wait_for_socket(self):
        path = self.root / "tab-recipes" / "bridge.sock"
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                try:
                    client.connect(str(path))
                    return path
                except (FileNotFoundError, ConnectionRefusedError):
                    time.sleep(0.01)
        self.fail("Native host did not start listening on its socket")

    def send_request(self, browser, *args, **kwargs):
        cli = subprocess.Popen([CLI, *args], env=self.env, stdout=subprocess.PIPE, text=True, **kwargs)
        self.addCleanup(cli.stdout.close)
        self.addCleanup(cli.wait, 5)
        ready, _, _ = select.select([browser.stdout], [], [], 5)
        self.assertTrue(ready, "Native host did not relay the CLI request")
        size, = HEADER.unpack(browser.stdout.read(HEADER.size))
        request = json.loads(browser.stdout.read(size))
        return cli, request

    def browser_reply(self, browser, reply):
        data = json.dumps(reply).encode()
        browser.stdin.write(HEADER.pack(len(data)) + data)
        browser.stdin.flush()

    def test_install_registers_only_the_selected_extension(self):
        installed = self.cli("install", EXTENSION_ID, "--browser", "chromium")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        path = Path(installed.stdout.strip())
        self.assertEqual(path.parent, self.root / ".config/chromium/NativeMessagingHosts")
        manifest = json.loads(path.read_text())
        self.assertEqual(manifest["allowed_origins"], [f"chrome-extension://{EXTENSION_ID}/"])
        self.assertEqual(manifest["path"], str(CLI))
        self.assertEqual(self.cli("install", "not-an-extension-id").returncode, 1)

    def test_native_round_trip_and_concurrent_command(self):
        browser = self.browser()
        socket_path = self.wait_for_socket()
        self.assertEqual(stat.S_IMODE(socket_path.parent.stat().st_mode), 0o700)
        cli, request = self.send_request(browser, "dev.inspect", '{"tabId":25,"adapterId":"test"}')
        self.assertEqual(request["command"], "dev.inspect")
        self.assertEqual(request["args"], {"tabId": 25, "adapterId": "test"})
        concurrent = self.cli("tabs")
        self.assertEqual(concurrent.returncode, 1)
        self.assertEqual(json.loads(concurrent.stdout)["error"]["code"], "BUSY")
        self.browser_reply(browser, {"id": "foreign-id", "result": {"ignored": True}})
        self.browser_reply(browser, {"id": request["id"], "result": {"ready": True}})
        output, _ = cli.communicate(timeout=5)
        self.assertEqual(cli.returncode, 0)
        self.assertEqual(json.loads(output), {"ready": True})
        browser.stdin.close()
        self.assertEqual(browser.wait(timeout=5), 0)
        self.assertFalse(socket_path.exists())

    def test_browser_errors_survive_the_bridge(self):
        browser = self.browser()
        self.wait_for_socket()
        cli, request = self.send_request(browser, "dev.failures")
        error = {"code": "DEV_DISABLED", "message": "Enable Developer Mode"}
        self.browser_reply(browser, {"id": request["id"], "error": error})
        output, _ = cli.communicate(timeout=5)
        self.assertEqual(cli.returncode, 1)
        self.assertEqual(json.loads(output), {"error": error})

    def test_refuses_a_shared_runtime_subdirectory(self):
        (self.root / "tab-recipes").mkdir(mode=0o755)
        result = self.cli("catalog")
        self.assertEqual(result.returncode, 1)
        self.assertIn("private directory", result.stderr)


if __name__ == "__main__":
    unittest.main()
