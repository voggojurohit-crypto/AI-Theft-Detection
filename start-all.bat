@echo off
set ROOT=%~dp0
start "Sentinel AI Backend" cmd /k "cd /d %ROOT% && call .venv\Scripts\activate && python ai_backend\app.py"
start "Sentinel AI Frontend" cmd /k "cd /d %ROOT%\frontend && npm run dev"
echo Backend: http://127.0.0.1:5000
 echo Frontend: http://127.0.0.1:5173
