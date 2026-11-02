"""Desktop launcher: starts the local server on a free port and opens the browser.

Entry point for the packaged InvestmentTracker.exe (see build_exe.bat).
Also works from a dev checkout:  .venv\\Scripts\\python launcher.py
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
import webbrowser

import uvicorn

from backend import db
from backend.main import app

HOST = "127.0.0.1"
PREFERRED_PORT = 8000


def _free_port(preferred: int) -> int:
    """Use the preferred port if available, otherwise let the OS pick one."""
    for port in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind((HOST, port))
                return s.getsockname()[1]
            except OSError:
                continue
    raise RuntimeError("No free TCP port available")


def _set_console_title(title: str) -> None:
    if os.name == "nt":
        try:
            import ctypes

            ctypes.windll.kernel32.SetConsoleTitleW(title)
        except Exception:  # noqa: BLE001 - cosmetic only
            pass


def main() -> int:
    _set_console_title("Investment Tracker")
    try:
        sys.stdout.reconfigure(line_buffering=True)  # banner shows immediately even when output is redirected
    except (AttributeError, ValueError):
        pass
    port = _free_port(PREFERRED_PORT)
    url = f"http://{HOST}:{port}/"

    config = uvicorn.Config(app, host=HOST, port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(config)
    thread = threading.Thread(target=server.run, name="uvicorn", daemon=True)
    thread.start()

    deadline = time.time() + 20
    while not server.started and thread.is_alive() and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        print("The server failed to start. See the messages above.")
        input("Press Enter to close.")
        return 1

    print("=" * 62)
    print("  Investment Tracker is running")
    print(f"  Open:  {url}")
    print(f"  Data:  {db.DB_PATH}")
    print()
    print("  Keep this window open while you use the app.")
    print("  Close it (or press Ctrl+C) to stop.")
    print("=" * 62)
    if not os.environ.get("INVESTMENT_TRACKER_NO_BROWSER"):
        webbrowser.open(url)

    try:
        while thread.is_alive():
            thread.join(0.5)
    except KeyboardInterrupt:
        print("\nStopping...")
        server.should_exit = True
        thread.join(10)
    return 0


if __name__ == "__main__":
    sys.exit(main())
