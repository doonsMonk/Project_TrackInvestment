@echo off
rem Install the debug APK on the connected device or running emulator (adb must see it: adb devices).
setlocal
set "ADB=%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe"
if not exist "%ADB%" set "ADB=C:\Program Files (x86)\Android\android-sdk\platform-tools\adb.exe"
set "APK=%~dp0app\build\outputs\apk\debug\app-debug.apk"
if not exist "%APK%" (
  echo No APK yet. Build it first: gradlew.bat assembleDebug
  exit /b 1
)
"%ADB%" wait-for-device
"%ADB%" install -r "%APK%"
if errorlevel 1 exit /b 1
"%ADB%" shell am start -n com.investmenttracker.app/.MainActivity
endlocal
