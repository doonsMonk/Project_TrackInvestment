"""Cloud backup of the vault file to the user's own Google Drive, OneDrive or Dropbox.

The app signs in once through the provider's normal consent page (OAuth 2.0 with PKCE, returning to the app's own
loopback address), then uploads portfolio.enc to a folder of its own after every change and can download it again
on another device. Access is limited to the app's own files or folder. Each provider needs an OAuth client that the
user creates in that provider's console; those ids live in settings.json ("cloud"), the tokens in
<data folder>/cloud_tokens.json. The file is encrypted before it leaves the machine, so the cloud only holds ciphertext.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from datetime import datetime, timezone

from . import db

FILE_NAME = "portfolio.enc"
FOLDER_NAME = "Investment Tracker"
HTTP_TIMEOUT = 60
BACKUP_DELAY = 5.0          # seconds after the last change before the upload starts (changes are batched)
FAKE = os.environ.get("INVESTMENT_TRACKER_CLOUD_FAKE", "").rstrip("/")  # tests: a stand-in for every provider

PROVIDERS = {
    "google": {
        "label": "Google Drive",
        "auth": "https://accounts.google.com/o/oauth2/v2/auth",
        "token": "https://oauth2.googleapis.com/token",
        "api": "https://www.googleapis.com",
        "scope": "https://www.googleapis.com/auth/drive.file",
        "needs_secret": True,
        "console": "https://console.cloud.google.com/apis/credentials",
        "setup": "Google Cloud Console: create a project, enable the Google Drive API, then under Credentials create an OAuth client ID "
                 "of type Desktop app and copy its client ID and client secret here. The first sign-in may warn that the app is "
                 "unverified, because it is your own; choose Continue.",
    },
    "onedrive": {
        "label": "OneDrive",
        "auth": "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
        "token": "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
        "api": "https://graph.microsoft.com/v1.0",
        "scope": "Files.ReadWrite.AppFolder offline_access",
        "needs_secret": False,
        "console": "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
        "setup": "Azure portal (sign in with your personal Microsoft account): App registrations, New registration, supported "
                 "account types 'Personal Microsoft accounts only', redirect URI of type 'Mobile and desktop applications' set to "
                 "http://127.0.0.1, then copy the Application (client) ID here.",
    },
    "dropbox": {
        "label": "Dropbox",
        "auth": "https://www.dropbox.com/oauth2/authorize",
        "token": "https://api.dropboxapi.com/oauth2/token",
        "api": "https://api.dropboxapi.com/2",
        "content": "https://content.dropboxapi.com/2",
        "scope": "",
        "needs_secret": False,
        "console": "https://www.dropbox.com/developers/apps",
        "setup": "Dropbox App Console: Create app, API 'Scoped access', access type 'App folder', any name; on the Settings tab add "
                 "the redirect URI http://127.0.0.1:8000/api/cloud/callback and copy the App key here. On the Permissions tab tick "
                 "files.content.write, files.content.read and files.metadata.read.",
    },
}

_pending: dict[str, dict] = {}          # OAuth state -> {provider, verifier, redirect_uri, at}
_tokens: dict[str, dict] | None = None  # provider -> tokens and bookkeeping, mirrored in cloud_tokens.json
_lock = threading.Lock()
_timer: threading.Timer | None = None
_remote_cache: dict[str, dict] = {}     # provider -> {"at": monotonic, "info": {...} | None, "error": str | None}


class CloudError(Exception):
    """A provider could not be reached, refused the request, or the setup is incomplete."""


def _ep(provider: str, key: str) -> str:
    """An endpoint of a provider, or its stand-in during tests."""
    if FAKE:
        return f"{FAKE}/{provider}/{key}"
    return PROVIDERS[provider][key]


def device_name() -> str:
    return os.environ.get("INVESTMENT_TRACKER_DEVICE") or socket.gethostname() or "this device"


# ---------------------------------------------------------------- settings and tokens

BUILTIN_NAME = "cloud_builtin.json"  # beside this module: the OAuth clients a build ships with, {provider: {client_id, client_secret}}


def _builtin_all() -> dict:
    """The clients built into this copy of the app, if the build carried the file (an env var overrides the path)."""
    override = os.environ.get("INVESTMENT_TRACKER_CLOUD_BUILTIN")
    candidates = [Path(override)] if override else []
    if not override:
        try:  # the package's own data file: a source checkout, a PyInstaller bundle, or the Android asset tree
            from importlib import resources
            text = resources.files(__package__).joinpath(BUILTIN_NAME).read_text(encoding="utf-8")
            return json.loads(text) if text.strip() else {}
        except (FileNotFoundError, OSError, ValueError, TypeError, AttributeError):
            pass
        candidates.append(Path(__file__).resolve().parent / BUILTIN_NAME)
    for p in candidates:
        try:
            return json.loads(p.read_text(encoding="utf-8")) or {}
        except (OSError, ValueError):
            continue
    return {}


def builtin_credentials(provider: str) -> dict:
    v = _builtin_all().get(provider)
    return dict(v) if isinstance(v, dict) and v.get("client_id") else {}


def custom_credentials(provider: str) -> dict:
    """The client the user pasted in the Cloud dialog (settings.json), if any."""
    return dict((db.read_settings().get("cloud") or {}).get(provider) or {})


def credentials(provider: str) -> dict:
    """The client to sign in with: the user's own when set, else the one built into the app."""
    return custom_credentials(provider) or builtin_credentials(provider)


def set_credentials(provider: str, client_id: str, client_secret: str | None) -> None:
    settings = db.read_settings()
    cloud = settings.setdefault("cloud", {})
    if client_id:
        cloud[provider] = {"client_id": client_id.strip(), **({"client_secret": client_secret.strip()} if client_secret else {})}
    else:
        cloud.pop(provider, None)
    db.write_settings(settings)


def _tokens_path():
    return db.DATA_DIR / "cloud_tokens.json"


def _load_tokens() -> dict[str, dict]:
    global _tokens
    if _tokens is None:
        try:
            _tokens = json.loads(_tokens_path().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            _tokens = {}
    return _tokens


def _save_tokens() -> None:
    path = _tokens_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(_tokens or {}, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def connected() -> list[str]:
    return [p for p in PROVIDERS if (_load_tokens().get(p) or {}).get("refresh_token")]


# ---------------------------------------------------------------- HTTP

def _request(method: str, url: str, headers: dict | None = None, data: bytes | None = None, follow: bool = True) -> tuple[int, bytes, dict]:
    req = urllib.request.Request(url, data=data, method=method, headers={"User-Agent": "InvestmentTracker", **(headers or {})})
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(_NoRedirect())
    try:
        with opener.open(req, timeout=HTTP_TIMEOUT) as resp:
            return resp.status, resp.read(), dict(resp.headers)
    except urllib.error.HTTPError as e:
        body = e.read()
        if e.code in (301, 302, 303, 307, 308) and not follow:
            return e.code, body, dict(e.headers)
        raise CloudError(_describe(e.code, body)) from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise CloudError(f"Could not reach the service: {e}") from e


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401 - urllib hook
        return None


def _describe(code: int, body: bytes) -> str:
    text = body.decode("utf-8", "replace")[:300]
    try:
        j = json.loads(text)
        err = j.get("error_description") or j.get("error_summary") or j.get("error")
        if isinstance(err, dict):
            err = err.get("message") or err.get("code")
        if err:
            return f"HTTP {code}: {err}"
    except ValueError:
        pass
    return f"HTTP {code}: {text or 'no details'}"


def _json(status_body) -> dict:
    status, body, _ = status_body
    try:
        return json.loads(body) if body else {}
    except ValueError as e:
        raise CloudError("The service returned something that is not JSON") from e


# ---------------------------------------------------------------- OAuth 2.0 with PKCE

def begin_connect(provider: str, redirect_uri: str) -> str:
    """The provider's sign-in URL for the browser; the provider sends the user back to `redirect_uri`."""
    if provider not in PROVIDERS:
        raise CloudError("Unknown provider")
    creds = credentials(provider)
    if not creds.get("client_id"):
        raise CloudError(f"{PROVIDERS[provider]['label']} is not set up yet: enter its client ID first")
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(48)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    state = secrets.token_urlsafe(24)
    now = time.time()
    for k in [k for k, v in _pending.items() if now - v["at"] > 900]:
        _pending.pop(k, None)
    _pending[state] = {"provider": provider, "verifier": verifier, "redirect_uri": redirect_uri, "at": now}
    params = {"client_id": creds["client_id"], "redirect_uri": redirect_uri, "response_type": "code", "state": state,
              "code_challenge": challenge, "code_challenge_method": "S256"}
    if provider == "google":
        params.update({"scope": PROVIDERS[provider]["scope"], "access_type": "offline", "prompt": "consent"})
    elif provider == "onedrive":
        params["scope"] = PROVIDERS[provider]["scope"]
    elif provider == "dropbox":
        params["token_access_type"] = "offline"
    return f"{_ep(provider, 'auth')}?{urllib.parse.urlencode(params)}"


def finish_connect(state: str, code: str) -> dict:
    """Exchange the code the provider sent back for tokens, remember them, and name the account."""
    pending = _pending.pop(state, None)
    if not pending:
        raise CloudError("This sign-in has expired or was not started by this app. Try Connect again.")
    provider = pending["provider"]
    creds = credentials(provider)
    form = {"client_id": creds["client_id"], "code": code, "code_verifier": pending["verifier"],
            "grant_type": "authorization_code", "redirect_uri": pending["redirect_uri"]}
    if creds.get("client_secret"):
        form["client_secret"] = creds["client_secret"]
    tok = _json(_request("POST", _ep(provider, "token"), {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
                         urllib.parse.urlencode(form).encode()))
    if not tok.get("access_token"):
        raise CloudError("The sign-in did not return a token")
    if not tok.get("refresh_token"):
        raise CloudError("The sign-in did not grant long-term access; for Google make sure the OAuth client is of type Desktop app")
    with _lock:
        entry = _load_tokens().setdefault(provider, {})
        entry.update({"access_token": tok["access_token"], "refresh_token": tok["refresh_token"],
                      "expires_at": time.time() + float(tok.get("expires_in") or 3600), "connected_at": _now_iso()})
        _save_tokens()
    try:
        entry["account"] = _account_name(provider)
    except CloudError as e:
        entry["account"] = f"(could not read the account name: {e})"
    with _lock:
        _save_tokens()
    _remote_cache.pop(provider, None)
    return {"provider": provider, "account": entry["account"]}


def _access_token(provider: str) -> str:
    entry = _load_tokens().get(provider) or {}
    if not entry.get("refresh_token"):
        raise CloudError(f"{PROVIDERS[provider]['label']} is not connected")
    if entry.get("access_token") and time.time() < float(entry.get("expires_at") or 0) - 60:
        return entry["access_token"]
    creds = credentials(provider)
    form = {"client_id": creds.get("client_id", ""), "refresh_token": entry["refresh_token"], "grant_type": "refresh_token"}
    if creds.get("client_secret"):
        form["client_secret"] = creds["client_secret"]
    if provider == "onedrive":
        form["scope"] = PROVIDERS[provider]["scope"]
    tok = _json(_request("POST", _ep(provider, "token"), {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
                         urllib.parse.urlencode(form).encode()))
    if not tok.get("access_token"):
        raise CloudError("The service refused to renew the sign-in; disconnect and connect again")
    with _lock:
        entry["access_token"] = tok["access_token"]
        entry["expires_at"] = time.time() + float(tok.get("expires_in") or 3600)
        if tok.get("refresh_token"):
            entry["refresh_token"] = tok["refresh_token"]
        _save_tokens()
    return entry["access_token"]


def disconnect(provider: str) -> None:
    with _lock:
        _load_tokens().pop(provider, None)
        _save_tokens()
    _remote_cache.pop(provider, None)


def _auth(provider: str) -> dict:
    return {"Authorization": f"Bearer {_access_token(provider)}"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ---------------------------------------------------------------- the file in each provider

def _account_name(provider: str) -> str:
    if provider == "google":
        j = _json(_request("GET", f"{_ep(provider, 'api')}/drive/v3/about?fields=user(emailAddress,displayName)", _auth(provider)))
        u = j.get("user") or {}
        return u.get("emailAddress") or u.get("displayName") or "Google account"
    if provider == "onedrive":
        j = _json(_request("GET", f"{_ep(provider, 'api')}/me", _auth(provider)))
        return j.get("userPrincipalName") or j.get("mail") or j.get("displayName") or "Microsoft account"
    j = _json(_request("POST", f"{_ep(provider, 'api')}/users/get_current_account", {**_auth(provider), "Content-Type": "application/json"}, b"null"))
    return j.get("email") or (j.get("name") or {}).get("display_name") or "Dropbox account"


def _google_folder(provider: str) -> str:
    api = _ep(provider, "api")
    q = urllib.parse.quote(f"name='{FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false")
    j = _json(_request("GET", f"{api}/drive/v3/files?q={q}&fields=files(id)&spaces=drive", _auth(provider)))
    files = j.get("files") or []
    if files:
        return files[0]["id"]
    body = json.dumps({"name": FOLDER_NAME, "mimeType": "application/vnd.google-apps.folder"}).encode()
    j = _json(_request("POST", f"{api}/drive/v3/files?fields=id", {**_auth(provider), "Content-Type": "application/json"}, body))
    return j["id"]


def _google_file(provider: str, folder: str) -> dict | None:
    api = _ep(provider, "api")
    q = urllib.parse.quote(f"name='{FILE_NAME}' and '{folder}' in parents and trashed=false")
    j = _json(_request("GET", f"{api}/drive/v3/files?q={q}&fields=files(id,modifiedTime,size,appProperties)", _auth(provider)))
    files = j.get("files") or []
    return files[0] if files else None


def upload(provider: str, data: bytes) -> dict:
    """Put the vault file in the provider; returns what the provider reports about it."""
    api = _ep(provider, "api")
    if provider == "google":
        folder = _google_folder(provider)
        existing = _google_file(provider, folder)
        meta = {"name": FILE_NAME, "appProperties": {"device": device_name(), "savedAt": _now_iso()}}
        boundary = "itvault" + secrets.token_hex(8)
        if existing:
            url = f"{api}/upload/drive/v3/files/{existing['id']}?uploadType=multipart&fields=id,modifiedTime,size"
            method = "PATCH"
        else:
            meta["parents"] = [folder]
            url = f"{api}/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime,size"
            method = "POST"
        body = (f"--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{json.dumps(meta)}\r\n"
                f"--{boundary}\r\nContent-Type: application/octet-stream\r\n\r\n").encode() + data + f"\r\n--{boundary}--".encode()
        j = _json(_request(method, url, {**_auth(provider), "Content-Type": f"multipart/related; boundary={boundary}"}, body))
        return {"modified": j.get("modifiedTime"), "size": int(j.get("size") or len(data))}
    if provider == "onedrive":
        if len(data) <= 4_000_000:
            j = _json(_request("PUT", f"{api}/me/drive/special/approot:/{FILE_NAME}:/content",
                               {**_auth(provider), "Content-Type": "application/octet-stream"}, data))
        else:
            sess = _json(_request("POST", f"{api}/me/drive/special/approot:/{FILE_NAME}:/createUploadSession",
                                  {**_auth(provider), "Content-Type": "application/json"}, b"{}"))
            j = _json(_request("PUT", sess["uploadUrl"], {"Content-Range": f"bytes 0-{len(data) - 1}/{len(data)}"}, data))
        return {"modified": j.get("lastModifiedDateTime"), "size": int(j.get("size") or len(data))}
    arg = json.dumps({"path": f"/{FILE_NAME}", "mode": "overwrite", "mute": True})
    j = _json(_request("POST", f"{_ep(provider, 'content')}/files/upload",
                       {**_auth(provider), "Dropbox-API-Arg": arg, "Content-Type": "application/octet-stream"}, data))
    return {"modified": j.get("server_modified"), "size": int(j.get("size") or len(data))}


def remote_info(provider: str) -> dict | None:
    """What the provider holds: {modified, size, device?}, or None when there is no backup there yet."""
    api = _ep(provider, "api")
    if provider == "google":
        f = _google_file(provider, _google_folder(provider))
        if not f:
            return None
        return {"modified": f.get("modifiedTime"), "size": int(f.get("size") or 0), "device": (f.get("appProperties") or {}).get("device")}
    if provider == "onedrive":
        try:
            j = _json(_request("GET", f"{api}/me/drive/special/approot:/{FILE_NAME}", _auth(provider)))
        except CloudError as e:
            if "HTTP 404" in str(e):
                return None
            raise
        return {"modified": j.get("lastModifiedDateTime"), "size": int(j.get("size") or 0), "device": None}
    try:
        j = _json(_request("POST", f"{api}/files/get_metadata", {**_auth(provider), "Content-Type": "application/json"},
                           json.dumps({"path": f"/{FILE_NAME}"}).encode()))
    except CloudError as e:
        if "not_found" in str(e) or "HTTP 409" in str(e):
            return None
        raise
    return {"modified": j.get("server_modified"), "size": int(j.get("size") or 0), "device": None}


def download(provider: str) -> bytes:
    api = _ep(provider, "api")
    if provider == "google":
        f = _google_file(provider, _google_folder(provider))
        if not f:
            raise CloudError("There is no backup in Google Drive yet")
        return _request("GET", f"{api}/drive/v3/files/{f['id']}?alt=media", _auth(provider))[1]
    if provider == "onedrive":
        status, body, headers = _request("GET", f"{api}/me/drive/special/approot:/{FILE_NAME}:/content", _auth(provider), follow=False)
        if status in (301, 302, 303, 307, 308):
            location = headers.get("Location") or headers.get("location")
            return _request("GET", location)[1]  # a pre-authenticated download link: no Authorization header
        return body
    arg = json.dumps({"path": f"/{FILE_NAME}"})
    return _request("POST", f"{_ep(provider, 'content')}/files/download", {**_auth(provider), "Dropbox-API-Arg": arg})[1]


# ---------------------------------------------------------------- backup after every change, restore on demand

def backup(provider: str) -> dict:
    """Upload the vault file now. Records the outcome; raises CloudError on failure."""
    try:
        data = db.VAULT_PATH.read_bytes()
    except OSError as e:
        raise CloudError(f"There is no vault file to back up yet ({e})") from e
    if not data.startswith(db.MAGIC):
        raise CloudError("The vault file is not in the expected format")
    entry = _load_tokens().setdefault(provider, {})
    try:
        info = upload(provider, data)
    except CloudError as e:
        with _lock:
            entry["last_error"] = str(e)
            entry["last_error_at"] = _now_iso()
            _save_tokens()
        raise
    with _lock:
        entry.update({"last_backup": _now_iso(), "last_size": len(data), "last_error": None, "last_error_at": None})
        _save_tokens()
    _remote_cache[provider] = {"at": time.monotonic(), "info": {**info, "device": device_name()}, "error": None}
    return {"provider": provider, "at": entry["last_backup"], "size": len(data)}


def backup_all() -> dict[str, str | None]:
    """Upload to every connected provider; {provider: error or None}."""
    results = {}
    for p in connected():
        try:
            backup(p)
            results[p] = None
        except CloudError as e:
            results[p] = str(e)
    return results


def schedule_backup(delay: float | None = None) -> None:
    """Called whenever the vault file was written: upload a little later, batching bursts of changes."""
    global _timer
    if not connected():
        return
    if delay is None:
        delay = BACKUP_DELAY
    with _lock:
        if _timer is not None:
            _timer.cancel()
        _timer = threading.Timer(delay, backup_all)
        _timer.daemon = True
        _timer.start()


def restore(provider: str) -> dict:
    """Replace the local vault file with the provider's copy. The vault is locked first; the previous local file is
    kept as portfolio.before-restore-<stamp>.enc; the user then unlocks with the restored file's password."""
    data = download(provider)
    if not data.startswith(db.MAGIC):
        raise CloudError("The file in the cloud is not an Investment Tracker vault")
    db.vault.lock()
    kept = None
    if db.VAULT_PATH.exists():
        kept = db.VAULT_PATH.with_name(f"portfolio.before-restore-{time.strftime('%Y%m%d-%H%M%S')}.enc")
        os.replace(db.VAULT_PATH, kept)
    db.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = db.VAULT_PATH.with_name(db.VAULT_PATH.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, db.VAULT_PATH)
    label = PROVIDERS[provider]["label"]
    db.vault.last_notice = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "message": f"The vault was restored from {label}. Unlock it with that file's password."
                   + (f" The previous file on this device was kept as {kept.name}." if kept else ""),
        "saved_aside": str(kept) if kept else None,
    }
    _remote_cache.pop(provider, None)
    return {"provider": provider, "size": len(data), "kept": str(kept) if kept else None}


def status(check_remote: bool = False) -> dict:
    """Per provider: setup, connection, last backup, and (cached) what the cloud holds versus the local file."""
    local = None
    try:
        st = db.VAULT_PATH.stat()
        local = {"modified": datetime.fromtimestamp(st.st_mtime, timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"), "size": st.st_size}
    except OSError:
        pass
    out = {"device": device_name(), "local": local, "providers": {}}
    tokens = _load_tokens()
    for p, cfg in PROVIDERS.items():
        creds = credentials(p)
        entry = tokens.get(p) or {}
        is_connected = bool(entry.get("refresh_token"))
        remote = None
        remote_error = None
        if is_connected:
            cached = _remote_cache.get(p)
            if check_remote:  # an explicit check always asks the provider; polling passes check_remote=False
                try:
                    cached = {"at": time.monotonic(), "info": remote_info(p), "error": None}
                except CloudError as e:
                    cached = {"at": time.monotonic(), "info": None, "error": str(e)}
                _remote_cache[p] = cached
            if cached:
                remote, remote_error = cached["info"], cached["error"]
        newer_remote = bool(remote and remote.get("modified") and local and remote["modified"] > local["modified"]
                            and (remote.get("device") or "") != device_name())
        custom = custom_credentials(p)
        out["providers"][p] = {
            "label": cfg["label"], "needs_secret": cfg["needs_secret"], "console": cfg["console"], "setup": cfg["setup"],
            "configured": bool(creds.get("client_id")), "client_id": custom.get("client_id"),
            "builtin": bool(builtin_credentials(p)), "custom": bool(custom.get("client_id")),
            "connected": is_connected, "account": entry.get("account"), "connected_at": entry.get("connected_at"),
            "last_backup": entry.get("last_backup"), "last_size": entry.get("last_size"),
            "last_error": entry.get("last_error"), "last_error_at": entry.get("last_error_at"),
            "remote": remote, "remote_error": remote_error, "newer_remote": newer_remote,
        }
    return out


# the vault tells us when it wrote its file; db must not import this module, so register from here
db.VAULT_WRITTEN_HOOKS.append(lambda: schedule_backup())
