import json
import os
from pathlib import Path
from bridge_transport import WINDOWS
import queue
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
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
        self.env = {**os.environ, "HOME": self.temp.name, "XDG_RUNTIME_DIR": self.temp.name, "LOCALAPPDATA": self.temp.name}

    def cli(self, *args, **kwargs):
        return subprocess.run(
            [sys.executable, CLI, *args], env=self.env, capture_output=True, text=True, timeout=5, **kwargs
        )

    def browser(self):
        process = subprocess.Popen(
            [sys.executable, CLI, f"chrome-extension://{EXTENSION_ID}/"],
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

    def wait_for_bridge(self):
        deadline = time.monotonic() + 5
        if WINDOWS:
            from multiprocessing.connection import Client
            from bridge_transport import pipe_settings
            directory = self.root / "Browser Recipes"
            while time.monotonic() < deadline:
                if (directory / "pipe.key").is_file():
                    try:
                        with Client(**pipe_settings(directory)):
                            return None
                    except (FileNotFoundError, ConnectionRefusedError):
                        pass
                time.sleep(0.01)
        else:
            path = self.root / "tab-recipes" / "bridge.sock"
            while time.monotonic() < deadline:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    try:
                        client.connect(str(path))
                        return path
                    except (FileNotFoundError, ConnectionRefusedError):
                        time.sleep(0.01)
        self.fail("Native host did not start listening")

    def send_request(self, browser, *args, **kwargs):
        cli = subprocess.Popen([sys.executable, CLI, *args], env=self.env, stdout=subprocess.PIPE, text=True, **kwargs)
        self.addCleanup(cli.stdout.close)
        self.addCleanup(cli.wait, 5)
        from browser_recipes import receive
        frames = queue.Queue()
        threading.Thread(target=lambda: frames.put(receive(browser.stdout)), daemon=True).start()
        try:
            return cli, frames.get(timeout=5)
        except queue.Empty:
            self.fail("Native host did not relay the CLI request")

    def browser_reply(self, browser, reply):
        data = json.dumps(reply).encode()
        browser.stdin.write(HEADER.pack(len(data)) + data)
        browser.stdin.flush()

    @unittest.skipIf(WINDOWS, "Windows registration uses the installed executable in the browser test")
    def test_install_registers_only_the_selected_extension(self):
        installed = self.cli("install", EXTENSION_ID, "--browser", "chromium")
        self.assertEqual(installed.returncode, 0, installed.stderr)
        path = Path(installed.stdout.strip())
        directory = "Library/Application Support/Chromium" if sys.platform == "darwin" else ".config/chromium"
        self.assertEqual(path.parent, self.root / directory / "NativeMessagingHosts")
        manifest = json.loads(path.read_text())
        self.assertEqual(manifest["allowed_origins"], [f"chrome-extension://{EXTENSION_ID}/"])
        launcher = Path(manifest["path"])
        self.assertEqual(launcher, self.root / "tab-recipes/native-host" if sys.platform == "darwin" else CLI)
        self.assertTrue(launcher.is_file())
        self.assertEqual(self.cli("install", "not-an-extension-id").returncode, 1)

    def test_native_round_trip_and_concurrent_command(self):
        browser = self.browser()
        socket_path = self.wait_for_bridge()
        if socket_path:
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
        if socket_path:
            self.assertFalse(socket_path.exists())

    def test_browser_errors_survive_the_bridge(self):
        browser = self.browser()
        self.wait_for_bridge()
        cli, request = self.send_request(browser, "dev.failures")
        error = {"code": "DEV_DISABLED", "message": "Enable Developer Mode"}
        self.browser_reply(browser, {"id": request["id"], "error": error})
        output, _ = cli.communicate(timeout=5)
        self.assertEqual(cli.returncode, 1)
        self.assertEqual(json.loads(output), {"error": error})

    @unittest.skipIf(WINDOWS, "The private-directory permission check is for Unix")
    def test_refuses_a_shared_runtime_subdirectory(self):
        (self.root / "tab-recipes").mkdir(mode=0o755)
        result = self.cli("catalog")
        self.assertEqual(result.returncode, 1)
        self.assertIn("private directory", result.stderr)


if __name__ == "__main__":
    unittest.main()
