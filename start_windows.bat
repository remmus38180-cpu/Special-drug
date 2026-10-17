@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo 找不到 Python。請先安裝 Python 3.12（https://www.python.org/downloads/windows/），安裝時勾選 Add python.exe to PATH。
  pause
  exit /b 1
)
if not exist ".venv\Scripts\pythonw.exe" (
  echo 第一次啟動：建立程式專用環境並下載 openpyxl、tzdata（需要可連到 pypi.org），約需1分鐘……
  %PY% -m venv .venv || goto fail
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check openpyxl==3.1.5 tzdata || goto fail
)
start "" ".venv\Scripts\pythonw.exe" run_app.py
exit /b 0
:fail
echo 啟動準備失敗，請把上面的訊息截圖給資訊單位。
pause
exit /b 1
