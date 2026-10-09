@echo off
setlocal
cd /d "%~dp0"

echo ============================================================
echo   SAP Code Reviewer - Claude Code Workspace
echo ============================================================
echo.

REM Check Node
where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org
  pause
  exit /b 1
)

REM Check Claude Code CLI
where claude >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Claude Code CLI not found. Install with:
  echo   npm install -g @anthropic-ai/claude-code
  pause
  exit /b 1
)

REM Install deps if needed
if not exist node_modules (
  echo Installing Node dependencies...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Available agents:
echo   /sap-code-reviewer         - Auto-detect tech and review the upload
echo   /sap-ui5-reviewer          - Deep UI5/Fiori review
echo   /sap-capm-reviewer         - Deep CAP review
echo   /sap-rap-reviewer          - Deep RAP review
echo   /sap-abap-cloud-reviewer   - Deep ABAP Cloud review
echo.

REM ── Check if the server is already running on port 5757 ─────────────────────
REM netstat -ano finds the TCP listener; if found, just open the browser and exit.
netstat -ano | find "0.0.0.0:5757" >nul 2>&1
if not errorlevel 1 (
  echo Server is already running on http://localhost:5757/
  echo Opening browser tab...
  start "" "http://localhost:5757/"
  echo.
  echo TIP: Keep the existing browser tab open - just refresh it for new reviews.
  echo      Close the SAP Reviewer Server window to stop the server.
  echo.
  exit /b 0
)

REM ── First launch: start the server, then open the browser ───────────────────
echo Starting review server on http://localhost:5757/ ...
start "SAP Reviewer Server" cmd /k "node scripts\server.js"

REM Wait for the server to bind the port before opening the browser.
timeout /t 2 /nobreak >nul

echo Opening upload UI...
start "" "http://localhost:5757/"

echo.
echo ============================================================
echo   Server is running.  Keep this window open.
echo   Next time you double-click the shortcut the browser will
echo   open automatically - no need to start the server again.
echo ============================================================
echo.
endlocal
