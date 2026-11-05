# Starts Investment Tracker from source in its own app window, with no console left open.
Set-Location $PSScriptRoot
if (-not (Test-Path ".venv\Scripts\pythonw.exe")) {
  Write-Host "Creating virtual environment and installing dependencies..."
  py -3 -m venv .venv
  .\.venv\Scripts\python.exe -m pip install -q -r requirements.txt
}
Start-Process -FilePath ".\.venv\Scripts\pythonw.exe" -ArgumentList "launcher.py" -WorkingDirectory $PSScriptRoot
