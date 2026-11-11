# Investment Tracker for Android

The same app as on the PC, packaged for a phone: the Python backend runs inside the app (embedded with
[Chaquopy](https://chaquo.com/chaquopy/)), the web frontend runs in a WebView, and the data is the same
encrypted file, `portfolio.enc`, kept in the app's private storage.

Nothing is duplicated: at build time the `backend/` package and the `frontend/` folder are copied from this
repository into the APK, so the phone always ships the code the PC runs. The one difference is the Python
dependency set: pydantic v2 needs a compiled library with no Android build, so the phone runs FastAPI 0.115
with pydantic v1 (`backend/compat.py` makes the request models work on both).

## Build

Requirements: an Android SDK with `platforms;android-35` and `build-tools;35.0.0` (the copy Visual Studio's
Android workload installs under `C:\Program Files (x86)\Android\android-sdk` is enough, read-only), a JDK 17 or
newer, Python 3.13 reachable as `py -3.13` (Chaquopy needs the build-time Python to match the embedded one;
`winget install --id Python.Python.3.13 --scope user`), and internet access for Gradle, the Android libraries and
the Python packages on the first build.

```
cd android
copy local.properties.example local.properties   # edit sdk.dir if your SDK is elsewhere
set JAVA_HOME=C:\Program Files\Android\openjdk\jdk-21.0.8
gradlew.bat assembleDebug
```

The APK is written to `app\build\outputs\apk\debug\app-debug.apk`. Copy it to the phone and open it (allow
"install unknown apps" for the file manager you use), or install it over USB with
`adb install -r app\build\outputs\apk\debug\app-debug.apk`.

## Using the same data on the PC and the phone

The vault is one file. Copy it between devices deliberately, and keep only one device open at a time:

- On the phone, long-press anywhere on the page to get the menu: **Save vault as…** writes the phone's
  `portfolio.enc` to a location you pick (Google Drive, OneDrive, Dropbox and the Downloads folder all appear
  in the picker); **Open vault file…** replaces the phone's vault with a file you pick and asks for its password.
- On the PC the file lives in the `data` folder next to the exe (or the folder `INVESTMENT_TRACKER_DATA`
  points at). Close the PC app before copying a file over it.

The file is encrypted with your password before it is written, so a cloud folder only ever holds ciphertext.

## Fingerprint / screen-lock unlock

`MainActivity` keeps the vault password encrypted with an AES-GCM key from the Android Keystore that requires user
authentication for every use (`BIOMETRIC_STRONG` or `DEVICE_CREDENTIAL` on Android 11+, biometrics only below)
and is invalidated when fingerprints are enrolled. The page's lock screen calls `AndroidApp.enableBiometric` (one
prompt, then the ciphertext goes to the app's private preferences) and `AndroidApp.biometricUnlock` (prompt,
decrypt, POST to the backend's `/api/auth/unlock` from Kotlin, then `window.onBiometric('unlocked')`). Needs
`androidx.biometric`. Nothing is written to the vault file.

## Files from the page

`<input type="file">` (the CAS statement PDF) works because `MainActivity` implements `WebChromeClient.onShowFileChooser`
with the system document picker; the page reads the file itself and sends it to the backend inside the app. pdfminer.six
is a pure-Python package, so the same parser runs on the phone.

## Printing

The page's Print button calls `AndroidApp.print()`, a JavaScript interface on the WebView that hands the current
page to Android's print framework (`PrintManager` with the WebView's own print adapter, A4 by default). The system
print dialog offers any printer and Save as PDF; the page's print stylesheet applies.

The print adapter renders the live page, and printing switches the page's colour scheme to light while it renders.
The page's colour-scheme listener therefore ignores that change on the print route; before it did, the flip
re-rendered the report from scratch and the print preview showed its "Preparing the report…" placeholder.

## Cloud sign-in

The Cloud dialog's Connect button calls `AndroidApp.openUrl(url)`, which opens the provider's sign-in page in the
phone's browser (Google refuses sign-ins inside a WebView). The provider then sends the browser to the app's own
address, `http://127.0.0.1:8000/api/cloud/callback`, which the backend inside the app answers. Android freezes an
app within seconds of it leaving the screen (`dumpsys activity processes` shows `isFrozen=true`), so `openUrl` also
starts `SignInService`, a foreground service of type `dataSync` with a small "Finishing the cloud sign-in"
notification, which keeps the process running; `MainActivity.onResume` stops it when the user comes back, and it
stops itself after five minutes. Without a `POST_NOTIFICATIONS` grant (Android 13+) the notification stays hidden,
but the service still runs. The OAuth client itself comes from `backend/cloud_builtin.json` (git-ignored) when the
build carried it; see `docs/PUBLISHING.md`.

## Testing on a phone over Wi-Fi

When the PC's USB ports are blocked, Android 11+ can be debugged over Wi-Fi (phone and PC on the same network):

1. On the phone: Settings > About phone > tap Build number seven times, then Developer options > Wireless debugging
   (on). Open Wireless debugging, note its IP address & port, tap "Pair device with pairing code" and keep the
   dialog open.
2. On the PC, with adb from the SDK's `platform-tools`:
   `adb pair <pairing ip:port> <code>` then `adb connect <ip:port from the Wireless debugging screen>`. Pairing is
   remembered; the connect port changes between sessions.
3. `adb install -r dist/InvestmentTracker-<version>.apk` and `adb shell am start -n
   com.investmenttracker.app/.MainActivity`. `adb logcat -d | grep -i investmenttracker` shows the app's log lines.
4. The backend inside the phone listens on 127.0.0.1:8000; `adb forward tcp:8002 tcp:8000` lets scripts on the PC
   talk to it at http://127.0.0.1:8002 (the API suites take `TRACKER_BASE`).
5. The debug build's WebView is inspectable: `adb shell pidof com.investmenttracker.app`, then
   `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`; open chrome://inspect in Chrome or Edge on
   the PC, or talk to http://127.0.0.1:9333/json with the DevTools protocol directly (Playwright cannot attach to
   a WebView). `adb exec-out screencap -p > shot.png` takes a true device screenshot.
