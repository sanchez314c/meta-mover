@echo off
echo === META Mover - Run from Source (Windows) ===

SET DEV_PORT=58594
SET HMR_PORT=62340
SET SPARE_PORT=63004

REM Kill any existing Electron processes
taskkill /F /IM electron.exe 2>NUL || echo No electron processes to kill

REM Release ports if occupied
for %%P in (%DEV_PORT% %HMR_PORT% %SPARE_PORT%) do (
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr "%%P" 2^>NUL') do (
        echo Releasing port %%P (PID: %%a)
        taskkill /F /PID %%a 2>NUL || echo Port %%P already free
    )
)

REM Install dependencies if needed
if not exist "node_modules" (
    echo Installing dependencies...
    call npm install
)

REM Export ports
SET PORT=%DEV_PORT%

echo Starting META Mover on port %DEV_PORT%...
call npm run dev
