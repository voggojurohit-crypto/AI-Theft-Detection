@echo off
set ROOT=%~dp0
cd /d %ROOT%
where py >nul 2>nul || (echo Python launcher not found. Install Python 3.11 first.& pause & exit /b 1)
where node >nul 2>nul || (echo Node.js not found. Install Node.js 18+ first.& pause & exit /b 1)
py -3.11 -m venv .venv
call .venv\Scripts\activate
python -m pip install --upgrade pip
pip install -r ai_backend\requirements.txt
cd frontend
npm install
cd ..
echo Setup complete. Run start-all.bat to launch the project.
pause
