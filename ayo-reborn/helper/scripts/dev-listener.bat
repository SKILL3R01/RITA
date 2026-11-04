@echo off
:: Standalone dev run of the Rita listener (NOT the normal app path):
::   1. makes .dev-key once (32 random bytes)
::   2. points RITA_KEY_FILE at it so auth works without an fd-3 pipe
::   3. runs the helper; connect your own test client to ws://127.0.0.1:8771
setlocal
cd /d %~dp0..
if not exist .dev-key (
  python -c "import os; open('.dev-key','wb').write(os.urandom(32))"
  echo wrote .dev-key
)
set RITA_KEY_FILE=%~dp0..\.dev-key
echo [dev] RITA_KEY_FILE=%RITA_KEY_FILE%
python -m rita_listener
endlocal
