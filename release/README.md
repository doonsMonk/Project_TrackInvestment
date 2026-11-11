# Ready-to-install builds

The latest build of Investment Tracker for each kind of device. Open a file here on GitHub and use its **Download**
button (the repository is private, so sign in first). Only the current version is kept in this folder; earlier
versions remain in the folder's history on GitHub.

| File | For | Version | Size | SHA-256 |
|---|---|---|---|---|
| `InvestmentTracker-0.15.0.exe` | Windows 10 / 11 PC | 0.15.0 | 44 MB | `4e21a9da0268354c438cd6c9eca4be4357f2d1f753b8b98fe902b55afb09293c` |
| `InvestmentTracker-0.15.0.apk` | Android phone or tablet, Android 7.0 or later | 0.15.0 | 54 MB | `88759bef36f2df22fce1e11b8201adfb2bdb20a5b1918341653be94a10930345` |

Both are built from the same source: the Windows exe by `build_exe.bat`, the APK by the Gradle project under
`android/`. The version is shown in the app's top bar.

## Windows

1. Download the `.exe` into a folder of your own, for example `Documents\Investment Tracker`. The app keeps its
   encrypted data in a `data` folder next to the exe, so keep the exe where you want that data to live.
2. Double-click it. The first time, Windows SmartScreen may say "Windows protected your PC" because the exe is not
   signed: click **More info**, then **Run anyway**. The app opens in its own window after a few seconds.
3. To upgrade, put the newer exe in the same folder and start it: it replaces the older instance if that is
   running, and keeps the `data` folder. The old exe can then be deleted.

## Android

1. Download the `.apk` on the phone or tablet (sign in to GitHub in the browser), or download it on the PC and copy
   it over.
2. Open the downloaded file from the download notification or the Files app. When asked, allow that app to
   install unknown apps, then tap **Install**. The first start unpacks the app and takes a few seconds.
3. To upgrade, install the newer APK the same way; it goes over the old one and the vault stays in place. The APK
   carries this project's own signing key, so it installs over earlier builds from this folder only.
4. Fingerprint or screen-lock unlock appears on the lock screen once the device has a screen lock and a
   fingerprint enrolled.

## Checking a download

On Windows, in PowerShell: `Get-FileHash .\InvestmentTracker-0.15.0.exe` and compare the hash with the table.
