"""Updates from the project's GitHub Releases.

`check()` asks GitHub for the latest release and compares its tag with this copy's version. `start_download()`
fetches the asset for this platform (the .exe on Windows, the .apk on Android) into `<data folder>/updates`, checking
the size and, when GitHub publishes one, the SHA-256 digest. Applying differs by platform:

  Windows  `apply_windows()` renames the running exe to `<name>.old` (Windows allows renaming a running program),
           puts the download in its place and starts it. The new launcher finds the older version on the port, asks
           it to quit and takes over, with the same data folder since that sits next to the exe. The `.old` file is
           removed on a later start (`cleanup()`).
  Android  the page hands the downloaded file to the app (`AndroidApp.installApk`), which opens Android's own
           installer; the new APK goes over the old one and keeps the vault.

Only release assets of this project's repository are ever downloaded. INVESTMENT_TRACKER_UPDATE_API points the check
at another address for tests, as does `update_api` in settings.json (downloads are then allowed from that
address's host as well).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from . import db

REPO = "doonsMonk/Project_TrackInvestment"
API_LATEST = f"https://api.github.com/repos/{REPO}/releases/latest"
RELEASES_PAGE = f"https://github.com/{REPO}/releases"
ASSET_PREFIX = f"https://github.com/{REPO}/releases/download/"
USER_AGENT = "InvestmentTracker-updater"

_lock = threading.Lock()
_state: dict = {"state": "idle"}


class UpdateError(Exception):
    pass


def platform() -> str:
    """windows = the packaged exe, android = the app, source = a development checkout (updated with git)."""
    forced = os.environ.get("INVESTMENT_TRACKER_UPDATE_PLATFORM")  # tests
    if forced in ("windows", "android", "source"):
        return forced
    if sys.platform == "android" or "ANDROID_ROOT" in os.environ:
        return "android"
    if getattr(sys, "frozen", False) and sys.platform == "win32":
        return "windows"
    return "source"


def parse_version(text: str) -> tuple[int, ...]:
    m = re.search(r"(\d+)\.(\d+)\.(\d+)", text or "")
    return tuple(int(x) for x in m.groups()) if m else ()


def _override() -> str | None:
    """Another address for the latest-release JSON: the environment variable, or `update_api` in settings.json
    (which is how a test reaches the app on a phone)."""
    return os.environ.get("INVESTMENT_TRACKER_UPDATE_API") or db.read_settings().get("update_api") or None


def _api_url() -> str:
    return _override() or API_LATEST


def _allowed(url: str) -> bool:
    if url.startswith(ASSET_PREFIX):
        return True
    override = _override()
    if override:
        a, b = urllib.parse.urlsplit(override), urllib.parse.urlsplit(url)
        return (a.scheme, a.netloc) == (b.scheme, b.netloc)
    return False


def _get(url: str, timeout: float = 20):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
    return urllib.request.urlopen(req, timeout=timeout)


def _asset_for(assets: list[dict], plat: str) -> dict | None:
    ext = {"windows": ".exe", "android": ".apk"}.get(plat)
    if not ext:
        return None
    for a in assets:
        name = str(a.get("name") or "")
        url = str(a.get("browser_download_url") or "")
        if name.lower().endswith(ext) and re.fullmatch(r"[A-Za-z0-9._-]+", name) and _allowed(url):
            digest = str(a.get("digest") or "")
            return {"name": name, "url": url, "size": int(a.get("size") or 0),
                    "sha256": digest.split(":", 1)[1].lower() if digest.lower().startswith("sha256:") else None}
    return None


def check(current: str) -> dict:
    """What GitHub's latest release is and whether it is newer than `current`."""
    plat = platform()
    try:
        with _get(_api_url()) as r:
            rel = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            raise UpdateError("GitHub is limiting requests from this network just now; try again in a little while.") from e
        if e.code == 404:
            raise UpdateError("No release has been published yet.") from e
        raise UpdateError(f"GitHub answered {e.code}.") from e
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise UpdateError("Could not reach GitHub to check for updates. Is the device online?") from e
    tag = str(rel.get("tag_name") or "")
    latest = ".".join(map(str, parse_version(tag)))
    if not latest:
        raise UpdateError("The latest release has no version number in its tag.")
    asset = _asset_for(rel.get("assets") or [], plat)
    return {
        "current": current, "latest": latest, "newer": parse_version(latest) > parse_version(current),
        "platform": plat, "published": rel.get("published_at"), "title": rel.get("name") or tag,
        "notes": str(rel.get("body") or "")[:6000], "page": rel.get("html_url") or RELEASES_PAGE,
        "asset": asset, "can_install": bool(asset) and plat in ("windows", "android"),
    }


def updates_dir() -> Path:
    d = db.DATA_DIR / "updates"
    d.mkdir(parents=True, exist_ok=True)
    return d


def status() -> dict:
    with _lock:
        return dict(_state)


def _set(**kw) -> None:
    with _lock:
        _state.update(kw)


def _download(asset: dict, version: str) -> None:
    target = updates_dir() / asset["name"]
    part = target.with_name(target.name + ".part")
    try:
        for old in updates_dir().iterdir():  # start clean: nothing from an earlier attempt can be mistaken for this one
            try:
                old.unlink()
            except OSError:
                pass
        h = hashlib.sha256()
        done = 0
        with _get(asset["url"], timeout=60) as r, open(part, "wb") as f:
            total = int(r.headers.get("Content-Length") or asset["size"] or 0)
            _set(total=total)
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                h.update(chunk)
                done += len(chunk)
                _set(done=done)
        if asset["size"] and done != asset["size"]:
            raise UpdateError(f"The download is incomplete ({done} of {asset['size']} bytes).")
        if asset["sha256"] and h.hexdigest() != asset["sha256"]:
            raise UpdateError("The downloaded file does not match the checksum GitHub publishes for it; it was discarded.")
        os.replace(part, target)
        _set(state="ready", path=str(target), sha256=h.hexdigest(), verified=bool(asset["sha256"]))
    except (UpdateError, urllib.error.URLError, OSError) as e:
        try:
            part.unlink()
        except OSError:
            pass
        _set(state="error", error=str(e) if isinstance(e, UpdateError) else f"The download failed: {e}")


def start_download(current: str) -> dict:
    """Check again and fetch this platform's file in the background; `status()` reports the progress."""
    info = check(current)
    if not info["can_install"]:
        raise UpdateError("This copy cannot install updates itself; get the new version from the releases page." if info["platform"] != "source"
                          else "This copy runs from source; update it with git pull.")
    if not info["newer"]:
        raise UpdateError("This is already the latest version.")
    with _lock:
        if _state.get("state") == "downloading":
            return dict(_state)
        _state.clear()
        _state.update({"state": "downloading", "version": info["latest"], "name": info["asset"]["name"], "done": 0,
                       "total": info["asset"]["size"], "platform": info["platform"]})
    threading.Thread(target=_download, args=(info["asset"], info["latest"]), name="update-download", daemon=True).start()
    return status()


def apply_windows() -> dict:
    """Swap the running exe for the downloaded one and start it; the new launcher replaces this instance."""
    st = status()
    if platform() != "windows":
        raise UpdateError("Only the Windows exe replaces itself; on Android the system installer does it.")
    if st.get("state") != "ready" or not st.get("path") or not Path(st["path"]).is_file():
        raise UpdateError("No downloaded update is ready.")
    exe = Path(sys.executable).resolve()
    new = Path(st["path"])
    old = exe.with_name(exe.name + ".old")
    try:
        if old.exists():
            old.unlink()
        os.replace(exe, old)
    except OSError as e:
        raise UpdateError(f"Could not move the running program aside ({e}). Is the folder writable?") from e
    try:
        shutil.move(str(new), str(exe))
    except OSError as e:
        os.replace(old, exe)  # put things back
        raise UpdateError(f"Could not put the new version in place ({e}).") from e
    env = {k: v for k, v in os.environ.items() if not k.startswith(("_PYI", "_MEI"))}
    env["PYINSTALLER_RESET_ENVIRONMENT"] = "1"  # the child is a new program, not a helper of this one
    flags = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    subprocess.Popen([str(exe)], cwd=str(exe.parent), env=env, creationflags=flags, close_fds=True)
    _set(state="applied")
    return {"ok": True, "version": st.get("version")}


def cleanup() -> None:
    """Remove what an earlier update left behind: the previous exe and finished downloads."""
    if platform() == "windows":
        old = Path(sys.executable).resolve()
        old = old.with_name(old.name + ".old")
        try:
            if old.exists():
                old.unlink()
        except OSError:
            pass  # still running for a moment; the next start removes it
    try:
        d = db.DATA_DIR / "updates"
        if d.is_dir() and status().get("state") in ("idle", "applied"):
            shutil.rmtree(d, ignore_errors=True)
    except OSError:
        pass
