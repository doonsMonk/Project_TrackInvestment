"""Entry point of the Android app's embedded backend.

Called from Kotlin once Python is up: points the backend at the app's private data folder and at the frontend files
unpacked from the APK, starts the same FastAPI app the PC runs on a free loopback port, and returns the port once it
answers. Everything else (the vault, prices, calculations) is the shared backend package.
"""
import os
import socket
import threading
import time
import urllib.request


def _free_port(preferred: int = 8000) -> int:
    """Port 8000 when free (the cloud sign-in return address is registered with that port), else any free port."""
    with socket.socket() as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            pass
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def start(data_dir: str, frontend_dir: str) -> int:
    os.makedirs(data_dir, exist_ok=True)
    os.environ["INVESTMENT_TRACKER_DATA"] = data_dir
    os.environ["INVESTMENT_TRACKER_FRONTEND"] = frontend_dir
    os.environ.setdefault("INVESTMENT_TRACKER_NO_BROWSER", "1")
    os.environ.setdefault("INVESTMENT_TRACKER_DEVICE", "Android phone")
    try:  # HTTPS to the price sources: trust certifi's bundle, since the Windows store does not exist here
        import certifi
        os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    except ImportError:
        pass
    import uvicorn
    from backend.main import app

    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False, log_config=None)
    server = uvicorn.Server(config)
    app.state.request_quit = lambda: setattr(server, "should_exit", True)
    threading.Thread(target=server.run, name="uvicorn", daemon=True).start()
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/auth/status", timeout=2):
                return port
        except Exception:  # noqa: BLE001 - not up yet
            time.sleep(0.2)
    raise RuntimeError("the backend did not start in time")


def lock() -> None:
    """Lock the vault (forget the key); used before the vault file is replaced or the app goes away."""
    from backend import db
    db.vault.lock()


def state() -> str:
    from backend import db
    return db.vault.state()
