@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo 請先執行一次 start_windows.bat。
  pause
  exit /b 1
)
echo 將在離線原型資料庫（%%LOCALAPPDATA%%\specdrug\offline）加入模擬資料（非真實資料）。
echo 請先關閉系統視窗。
pause
".venv\Scripts\python.exe" tools\seed_demo.py "%LOCALAPPDATA%\specdrug\offline"
pause
