# Ready-to-install builds

The builds of Investment Tracker are published under the repository's
[Releases](https://github.com/doonsMonk/Project_TrackInvestment/releases), one release per version with the Windows
exe and the Android APK attached; the links below point there. This folder keeps a copy of the current version as
well.

| File | For | Version | Size | SHA-256 |
|---|---|---|---|---|
| [InvestmentTracker-0.16.0.exe](https://github.com/doonsMonk/Project_TrackInvestment/releases/download/v0.16.0/InvestmentTracker-0.16.0.exe) | Windows 10 / 11 PC | 0.16.0 | 42 MB | `e9cd7ee094214636ebeb1ae902c2cf1f9a266121fcacaa192b50b637ff7aaefe` |
| [InvestmentTracker-0.16.0.apk](https://github.com/doonsMonk/Project_TrackInvestment/releases/download/v0.16.0/InvestmentTracker-0.16.0.apk) | Android phone or tablet, Android 7.0 or later | 0.16.0 | 51 MB | `30916272f623f399d62519d8d37e9b12897ce1a9f180422cafbeed943bdbd63d` |

Both builds carry the published Google Drive sign-in: in the app, **Cloud** shows Google Drive as ready to connect,
with no set-up step.

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

1. Download the `.apk` on the phone or tablet, or download it on the PC and copy it over.
2. Open the downloaded file from the download notification or the Files app. When asked, allow that app to
   install unknown apps, then tap **Install**. The first start unpacks the app and takes a few seconds.
3. To upgrade, use **Updates** in the app's menu, or install the newer APK the same way; it goes over the old one
   and the vault stays in place. Builds up to 0.15.1 used another app id and signing key: version 0.16.0 installs
   beside them as a new app, so move the vault first (Save vault as… in the old app, Open vault file… in the new
   one, or the cloud backup) and then uninstall the old app.
4. Fingerprint or screen-lock unlock appears on the lock screen once the device has a screen lock and a
   fingerprint enrolled.

## Checking a download

On Windows, in PowerShell: `Get-FileHash .\InvestmentTracker-0.16.0.exe` and compare the hash with the table.
