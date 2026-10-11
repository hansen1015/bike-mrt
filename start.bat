@echo off
rem Runs Bike-MRT in your PC browser. Everything (routing included) runs inside the page, no server-side routing needed.
cd /d "%~dp0frontend"
echo Bike-MRT running at http://localhost:8000  (close this window to stop)
start "" http://localhost:8000
"%~dp0.venv\Scripts\python.exe" -m http.server 8000
