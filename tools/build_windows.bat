@echo off
REM 於開發機（Windows，已裝 Python 3.12）產生免安裝執行套件 dist\specdrug\specdrug.exe
REM 使用者電腦不需安裝 Python。
cd /d %~dp0\..
python -m venv .venv-build
call .venv-build\Scripts\activate
pip install -r requirements.txt
python -m pytest -q tests || exit /b 1
pyinstaller --noconfirm --clean --windowed --name specdrug ^
  --collect-data tzdata ^
  --add-data "config.example.json;." ^
  run_app.py
copy /Y README.md dist\specdrug\
echo 完成：dist\specdrug\specdrug.exe（整個資料夾複製到共用槽 app\版本號\ 發行）
