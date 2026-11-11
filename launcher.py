"""Desktop launcher: starts the local server and shows the app in its own window, with no console.

Entry point for InvestmentTracker.exe (built with --noconsole) and for run.bat (pythonw).

The window is Microsoft Edge or Google Chrome in "app" mode with a private browser profile kept
under the data folder, so it looks and behaves like a standalone application: no address bar, no
tabs, and closing the window stops the server. If no Chromium browser is installed, the default
browser is used instead and a small status window offers a Quit button.

Environment variables:
  INVESTMENT_TRACKER_NO_BROWSER=1   run the server only, no window (used by tests)
  INVESTMENT_TRACKER_DATA=<dir>     data folder (see backend/db.py)
  INVESTMENT_TRACKER_SETTINGS=<file> settings.json to use instead of the one next to the exe (tests)
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn

from backend import db
from backend.main import VERSION, app

HOST = "127.0.0.1"
PREFERRED_PORT = 8000
APP_TITLE = "Investment Tracker"
log = logging.getLogger("launcher")


def _bundle_root() -> Path:
    return Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))


def _setup_logging() -> None:
    """Log to data/app.log (there is no console in the packaged app); echo to stderr when there is one."""
    db.vault.prepare()
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        handler = RotatingFileHandler(db.DATA_DIR / "app.log", maxBytes=512_000, backupCount=1, encoding="utf-8")
        handler.setFormatter(fmt)
        root.addHandler(handler)
    except OSError:
        pass
    if sys.stderr is not None:
        stream = logging.StreamHandler(sys.stderr)
        stream.setFormatter(fmt)
        root.addHandler(stream)


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


def _existing_instance(port: int) -> dict | None:
    """The status of an Investment Tracker server already answering on this port, or None."""
    try:
        with urllib.request.urlopen(f"http://{HOST}:{port}/api/auth/status", timeout=1) as r:
            status = json.loads(r.read().decode("utf-8"))
            return status if isinstance(status, dict) and "state" in status else None
    except Exception:  # noqa: BLE001 - anything other than our JSON means "not ours"
        return None


def _replace_older_instance(port: int, status: dict) -> bool:
    """Ask an older running instance to quit so this (newer) one can take its port. True when the port is free."""
    old = status.get("version") or "unknown"
    log.info("version %s is running at port %s; asking it to quit so %s can start", old, port, VERSION)
    try:
        req = urllib.request.Request(f"http://{HOST}:{port}/api/quit", data=b"{}", method="POST", headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=3):
            pass
    except Exception as e:  # noqa: BLE001 - versions before 0.4.0 have no quit endpoint
        log.warning("old instance did not accept the quit request: %s", e)
        return False
    deadline = time.time() + 10
    while time.time() < deadline:
        if _existing_instance(port) is None:
            return True
        time.sleep(0.25)
    return False


def _clear_window_cache(profile: Path) -> None:
    """Drop the app window's cached pages and scripts so an upgrade is never shown through stale files."""
    for rel in (("Default", "Cache"), ("Default", "Code Cache"), ("Default", "Service Worker")):
        shutil.rmtree(profile.joinpath(*rel), ignore_errors=True)


def _find_chromium() -> Path | None:
    """Path to msedge.exe or chrome.exe, or None."""
    bases = [b for b in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), os.environ.get("LocalAppData")) if b]
    candidates: list[Path] = []
    # Edge first (present on every Windows 10/11 machine), then Chrome; well-known folders, then the registry.
    for rel in (("Microsoft", "Edge", "Application", "msedge.exe"), ("Google", "Chrome", "Application", "chrome.exe")):
        for base in bases:
            candidates.append(Path(base).joinpath(*rel))
        if os.name == "nt":
            try:
                import winreg

                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{rel[-1]}") as key:
                    candidates.append(Path(winreg.QueryValue(key, None)))
            except (ImportError, OSError):
                pass
    for c in candidates:
        if c.is_file():
            return c
    return None


def _open_app_window(url: str, extra_args: list[str] | None = None) -> subprocess.Popen | None:
    """Open `url` as a chromeless app window in its own browser profile. Returns the process, or None if no browser."""
    exe = _find_chromium()
    if exe is None:
        return None
    profile = db.DATA_DIR / "browser-profile"
    profile.mkdir(parents=True, exist_ok=True)
    _clear_window_cache(profile)
    args = [
        str(exe),
        f"--app={url}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--disable-background-networking",
        "--disable-features=Translate,msEdgeStartupBoost,msSleepingTabs",
        "--window-size=1280,900",
    ] + (extra_args or [])
    log.info("opening app window with %s", exe)
    return subprocess.Popen(args)


def _status_window(url: str) -> None:
    """Fallback when no Edge/Chrome exists: open the default browser and show a small window with Quit."""
    webbrowser.open(url)
    try:
        import tkinter as tk
    except ImportError:
        log.warning("tkinter unavailable; the server stays up until the process is ended")
        threading.Event().wait()
        return
    root = tk.Tk()
    root.title(APP_TITLE)
    root.resizable(False, False)
    try:
        root.iconbitmap(str(_bundle_root() / "assets" / "icon.ico"))
    except Exception:  # noqa: BLE001 - cosmetic
        pass
    tk.Label(root, text=f"{APP_TITLE} is running", font=("Segoe UI", 11, "bold")).pack(padx=24, pady=(18, 2))
    tk.Label(root, text=f"It is open in your browser at {url}").pack(padx=24)
    tk.Label(root, text="Close this window to quit.").pack(padx=24, pady=(2, 12))
    row = tk.Frame(root)
    row.pack(pady=(0, 16))
    tk.Button(row, text="Open again", width=12, command=lambda: webbrowser.open(url)).pack(side="left", padx=6)
    tk.Button(row, text="Quit", width=12, command=root.destroy).pack(side="left", padx=6)
    root.mainloop()


def _error_box(message: str) -> None:
    log.error(message)
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showerror(APP_TITLE, message)
        root.destroy()
    except Exception:  # noqa: BLE001 - no GUI available; the log has it
        pass


def main() -> int:
    _setup_logging()

    running = _existing_instance(PREFERRED_PORT)
    if running is not None:
        if running.get("version") == VERSION:
            url = f"http://{HOST}:{PREFERRED_PORT}/"
            log.info("already running at %s; opening another window", url)
            if _open_app_window(url) is None:
                webbrowser.open(url)
            return 0
        # A different (older) version is running: replace it rather than open a window on the old code.
        if not _replace_older_instance(PREFERRED_PORT, running):
            _error_box(
                f"An older version of {APP_TITLE} ({running.get('version') or 'unknown'}) is still running.\n\n"
                "Close its window (and any InvestmentTracker.exe in Task Manager), then start this version again."
            )
            return 1

    port = _free_port(PREFERRED_PORT)
    url = f"http://{HOST}:{port}/"
    config = uvicorn.Config(app, host=HOST, port=port, log_level="warning", access_log=False, log_config=None)
    server = uvicorn.Server(config)
    app.state.request_quit = lambda: setattr(server, "should_exit", True)  # lets a newer launcher replace this one
    thread = threading.Thread(target=server.run, name="uvicorn", daemon=True)
    thread.start()

    deadline = time.time() + 20
    while not server.started and thread.is_alive() and time.time() < deadline:
        time.sleep(0.05)
    if not server.started:
        _error_box(f"The server failed to start.\n\nDetails are in {db.DATA_DIR / 'app.log'}")
        return 1
    log.info("version %s running at %s; data file %s", VERSION, url, db.VAULT_PATH)

    if os.environ.get("INVESTMENT_TRACKER_NO_BROWSER"):
        try:
            while thread.is_alive():
                thread.join(0.5)
        except KeyboardInterrupt:
            pass
    else:
        proc = _open_app_window(url)
        if proc is None:
            log.warning("no Edge or Chrome found; using the default browser with a status window")
            _status_window(url)
        else:
            try:
                # Returns when the app window is closed, or when a newer launcher has asked this server to quit.
                while proc.poll() is None and thread.is_alive():
                    time.sleep(0.5)
                if proc.poll() is None:
                    log.info("server stopped by a newer version; closing this window")
                    proc.terminate()
            except KeyboardInterrupt:
                proc.terminate()
        log.info("window closed; stopping")

    server.should_exit = True
    thread.join(10)
    return 0


if __name__ == "__main__":
    sys.exit(main())
