@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment...
  py -3 -m venv .venv || python -m venv .venv || goto :fail
)

echo Installing dependencies and build tools...
.venv\Scripts\python.exe -m pip install -q -r requirements.txt pyinstaller pillow || goto :fail

if not exist "assets\icon.ico" (
  echo Generating icon...
  .venv\Scripts\python.exe tools\make_icon.py || goto :fail
)

echo Building dist\InvestmentTracker.exe ...
.venv\Scripts\python.exe -m PyInstaller --noconfirm --clean --onefile ^
  --name InvestmentTracker ^
  --icon assets\icon.ico ^
  --add-data "frontend;frontend" ^
  --collect-submodules uvicorn ^
  --collect-submodules anyio ^
  launcher.py || goto :fail

echo.
echo Done:  dist\InvestmentTracker.exe
echo Copy that single file anywhere. It keeps its database in a "data" folder next to itself.
exit /b 0

:fail
echo.
echo Build failed.
exit /b 1
