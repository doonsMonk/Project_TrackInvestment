Set-Location $PSScriptRoot
if (-not (Test-Path ".venv\Scripts\python.exe")) {
  Write-Host "Creating virtual environment and installing dependencies..."
  py -3 -m venv .venv
  .\.venv\Scripts\python.exe -m pip install -q -r requirements.txt
}
Write-Host "Starting Investment Tracker at http://127.0.0.1:8000  (Ctrl+C to stop)"
Start-Job { Start-Sleep -Seconds 2; Start-Process "http://127.0.0.1:8000" } | Out-Null
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
