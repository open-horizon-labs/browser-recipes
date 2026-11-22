"""Local, account-scoped transport for the extension host and CLI."""

from contextlib import contextmanager
import hashlib
import os
from pathlib import Path
import socket
import stat
import sys
import tempfile

WINDOWS = sys.platform == "win32"


def private_directory():
    if WINDOWS:
        path = Path(os.environ["LOCALAPPDATA"]) / "Browser Recipes"
        path.mkdir(exist_ok=True)
        return path
    runtime = os.environ.get("XDG_RUNTIME_DIR")
    path = Path(runtime) / "tab-recipes" if runtime else Path("/tmp") / f"tab-recipes-{os.getuid()}"
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise PermissionError(f"Expected a private directory owned by the current user: {path}")
    return path


@contextmanager
def exclusive_lock(path, wait=False):
    with path.open("a+b") as lock:
        try:
            if WINDOWS:
                import msvcrt
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK if wait else msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock, fcntl.LOCK_EX | (0 if wait else fcntl.LOCK_NB))
        except OSError as error:
            raise RuntimeError("Another browser connection already owns the local bridge") from error
        yield


def pipe_settings(directory):
    # LocalAppData inherits the desktop account's Windows profile permissions.
    path = directory / "pipe.key"
    with exclusive_lock(directory / "key.lock", wait=True):
        if not path.exists():
            with tempfile.NamedTemporaryFile(dir=directory, delete=False) as temporary:
                temporary.write(os.urandom(32))
            try:
                Path(temporary.name).replace(path)
            finally:
                Path(temporary.name).unlink(missing_ok=True)
        key = path.read_bytes()
    if len(key) != 32:
        raise ValueError("Invalid local bridge key")
    name = r"\\.\pipe\browser-recipes-" + hashlib.sha256(b"pipe-address:" + key).hexdigest()
    return {"address": name, "family": "AF_PIPE", "authkey": key}


class PipeStream:
    def __init__(self, connection, timeout, max_frame):
        self.connection = connection
        self.timeout = timeout
        self.max_frame = max_frame
        self.buffer = b""

    def read(self, size):
        if not self.buffer:
            if not self.connection.poll(self.timeout):
                raise TimeoutError("The local bridge did not send a response before the deadline")
            self.buffer = self.connection.recv_bytes(self.max_frame)
        result, self.buffer = self.buffer[:size], self.buffer[size:]
        return result

    def write(self, data):
        self.connection.send_bytes(data)

    def flush(self):
        pass


@contextmanager
def listen():
    directory = private_directory()
    with exclusive_lock(directory / "host.lock"):
        if WINDOWS:
            from multiprocessing.connection import AuthenticationError, Listener
            with Listener(**pipe_settings(directory)) as listener:
                def accept():
                    while True:
                        try:
                            return listener.accept()
                        except (AuthenticationError, EOFError, BrokenPipeError):
                            continue
                yield accept
        else:
            path = directory / "bridge.sock"
            path.unlink(missing_ok=True)
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(str(path))
                try:
                    path.chmod(0o600)
                    listener.listen()
                    yield lambda: listener.accept()[0]
                finally:
                    path.unlink(missing_ok=True)


@contextmanager
def client_stream(client, timeout, max_frame):
    if WINDOWS:
        yield PipeStream(client, timeout, max_frame)
    else:
        client.settimeout(timeout)
        with client.makefile("rwb") as stream:
            yield stream


@contextmanager
def connect(timeout, max_frame):
    directory = private_directory()
    try:
        if WINDOWS:
            from multiprocessing.connection import Client
            client = Client(**pipe_settings(directory))
        else:
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                client.settimeout(timeout)
                client.connect(str(directory / "bridge.sock"))
            except BaseException:
                client.close()
                raise
    except (FileNotFoundError, ConnectionRefusedError) as error:
        raise RuntimeError("Bridge disconnected. Enable the local bridge in Browser Recipes settings.") from error
    with client, client_stream(client, timeout, max_frame) as stream:
        yield stream
