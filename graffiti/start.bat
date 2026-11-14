@echo off
cd /d "%~dp0"
where python >nul 2>nul && (python serve.py & goto :eof)
where py >nul 2>nul && (py serve.py & goto :eof)
echo Python 3 is needed: install it from https://www.python.org/downloads/ and run this again.
pause
