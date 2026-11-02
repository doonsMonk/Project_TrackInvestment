@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Creating virtual environment and installing dependencies...
  py -3 -m venv .venv || python -m venv .venv
  .venv\Scripts\python.exe -m pip install -q -r requirements.txt
)
echo Starting Investment Tracker at http://127.0.0.1:8000  (Ctrl+C to stop)
start "" cmd /c "timeout /t 2 >nul && start http://127.0.0.1:8000"
.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
