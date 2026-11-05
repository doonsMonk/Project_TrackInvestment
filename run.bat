@echo off
rem Starts Investment Tracker from source in its own app window, with no console left open.
rem The first run creates the virtual environment and installs dependencies (needs internet once).
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
  echo Creating virtual environment and installing dependencies...
  py -3 -m venv .venv || python -m venv .venv || goto :fail
  .venv\Scripts\python.exe -m pip install -q -r requirements.txt || goto :fail
)
start "" ".venv\Scripts\pythonw.exe" launcher.py
exit /b 0

:fail
echo Setup failed. See the messages above.
pause
exit /b 1
