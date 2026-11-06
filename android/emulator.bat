@echo off
rem Create (once) and start an Android 15 virtual device for testing the app.
rem Needs a user-space SDK with the emulator and the API 35 x86_64 image:
rem   sdkmanager --sdk_root=%LOCALAPPDATA%\Android\Sdk "platform-tools" "emulator" "system-images;android-35;google_apis;x86_64"
setlocal
set "SDK=%LOCALAPPDATA%\Android\Sdk"
if not "%ANDROID_SDK_ROOT%"=="" set "SDK=%ANDROID_SDK_ROOT%"
set "ANDROID_SDK_ROOT=%SDK%"
set "ANDROID_HOME=%SDK%"
if "%JAVA_HOME%"=="" set "JAVA_HOME=C:\Program Files\Android\openjdk\jdk-21.0.8"
set "AVD=tracker"
if not exist "%SDK%\emulator\emulator.exe" (
  echo The emulator is not installed under %SDK%. See android\README.md.
  exit /b 1
)
if not exist "%USERPROFILE%\.android\avd\%AVD%.avd" (
  echo Creating the virtual device "%AVD%" ...
  echo no | call "%SDK%\cmdline-tools\latest\bin\avdmanager.bat" create avd -n %AVD% -k "system-images;android-35;google_apis;x86_64" -d pixel_6 --force
  if errorlevel 1 exit /b 1
)
echo Starting the emulator (first boot takes a minute or two)...
start "Android emulator" "%SDK%\emulator\emulator.exe" -avd %AVD% -no-snapshot-load -no-boot-anim -gpu auto
endlocal
