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
