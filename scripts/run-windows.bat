@echo off
setlocal enabledelayedexpansion

REM META Mover v3.0 - Windows Production Runner
REM Professional Windows production script with binary detection, installer integration
REM Process monitoring and comprehensive error handling

REM Colors for output (Windows 10+ with ANSI support)
set "RED=[31m"
set "GREEN=[32m"
set "YELLOW=[33m"
set "BLUE=[34m"
set "NC=[0m"

REM Get script directory and project root
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."

REM Logging setup
set "LOG_DIR=%PROJECT_ROOT%\logs"
set "LOG_FILE=%LOG_DIR%\run-windows-%DATE:~-4%-%DATE:~7,2%-%DATE:~4,2%-%TIME:~0,2%-%TIME:~3,2%-%TIME:~6,2%.log"

REM Create logs directory if it doesn't exist
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM Function to log messages
goto :main

:log_message
set "level=%~1"
set "message=%~2"
set "timestamp=%DATE% %TIME%"

REM Write to log file
echo [%timestamp%] [%level%] %message% >> "%LOG_FILE%"

REM Display colored output
if "%level%"=="ERROR" (
    echo %RED%[ERROR]%NC% %message%
) else if "%level%"=="SUCCESS" (
    echo %GREEN%[SUCCESS]%NC% %message%
) else if "%level%"=="WARNING" (
    echo %YELLOW%[WARNING]%NC% %message%
) else if "%level%"=="INFO" (
    echo %BLUE%[INFO]%NC% %message%
) else (
    echo [%level%] %message%
)
goto :eof

:check_requirements
call :log_message "INFO" "Checking system requirements..."

REM Check Windows version
for /f "tokens=4-5 delims=. " %%i in ('ver') do set VERSION=%%i.%%j
call :log_message "INFO" "Windows Version: %VERSION%"

REM Check for Windows 10+ (required for modern Electron)
for /f "tokens=1,2 delims=." %%a in ("%VERSION%") do (
    set "major=%%a"
    set "minor=%%b"
)
if %major% LSS 10 (
    call :log_message "ERROR" "Windows 10 or later required for Electron 27. Current: %VERSION%"
    goto :error_exit
)

call :log_message "SUCCESS" "System requirements check passed"
goto :eof

:find_app_binary
REM Look for binary in common locations
set "app_binary="

if exist "%PROJECT_ROOT%\release\META Mover Setup*.exe" (
    for %%i in ("%PROJECT_ROOT%\release\META Mover Setup*.exe") do set "app_binary=%%i"
    goto :found_binary
)

if exist "%PROJECT_ROOT%\release\win-unpacked\META Mover.exe" (
    set "app_binary=%PROJECT_ROOT%\release\win-unpacked\META Mover.exe"
    goto :found_binary
)

if exist "%PROJECT_ROOT%\dist\win-unpacked\META Mover.exe" (
    set "app_binary=%PROJECT_ROOT%\dist\win-unpacked\META Mover.exe"
    goto :found_binary
)

if exist "%PROGRAMFILES%\META Mover\META Mover.exe" (
    set "app_binary=%PROGRAMFILES%\META Mover\META Mover.exe"
    goto :found_binary
)

if exist "%PROGRAMFILES(X86)%\META Mover\META Mover.exe" (
    set "app_binary=%PROGRAMFILES(X86)%\META Mover\META Mover.exe"
    goto :found_binary
)

REM Binary not found
goto :eof

:found_binary
goto :eof

:run_from_source
call :log_message "INFO" "Running from built source..."

cd /d "%PROJECT_ROOT%"
if %ERRORLEVEL% NEQ 0 (
    call :log_message "ERROR" "Failed to change to project directory: %PROJECT_ROOT%"
    goto :error_exit
)

REM Check if package.json exists
if not exist "package.json" (
    call :log_message "ERROR" "package.json not found in project root"
    goto :error_exit
)

REM Check Node.js
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    call :log_message "ERROR" "Node.js not found. Please install Node.js 18+ from https://nodejs.org"
    goto :error_exit
)

REM Get Node.js version
for /f "delims=" %%i in ('node --version') do set NODE_VERSION=%%i
call :log_message "INFO" "Node.js Version: %NODE_VERSION%"

REM Extract major version number
set "node_major=%NODE_VERSION:v=%"
for /f "tokens=1 delims=." %%a in ("%node_major%") do set "node_major=%%a"
if %node_major% LSS 18 (
    call :log_message "ERROR" "Node.js 18+ required. Current: %NODE_VERSION%"
    goto :error_exit
)

REM Install dependencies if needed
if not exist "node_modules" (
    call :log_message "INFO" "Installing dependencies..."
    npm ci
    if %ERRORLEVEL% NEQ 0 (
        call :log_message "WARNING" "npm ci failed, trying npm install..."
        npm install
        if %ERRORLEVEL% NEQ 0 (
            call :log_message "ERROR" "Failed to install dependencies"
            goto :error_exit
        )
    )
    call :log_message "SUCCESS" "Dependencies installed successfully"
)

REM Build if dist doesn't exist or is outdated
if not exist "dist" (
    call :log_message "INFO" "Building production version..."
    npm run build
    if %ERRORLEVEL% NEQ 0 (
        call :log_message "ERROR" "Production build failed"
        goto :error_exit
    )
    call :log_message "SUCCESS" "Production build completed"
)

REM Set production environment variables
set NODE_ENV=production
set ELECTRON_ENABLE_LOGGING=1

REM Run the built application
call :log_message "INFO" "Starting production application from source..."
npm start
goto :eof

:run_binary
call :find_app_binary

if "%app_binary%"=="" (
    call :log_message "ERROR" "No compiled binary found. Available options:"
    call :log_message "INFO" "1. Run from source with: %~nx0 --source"
    call :log_message "INFO" "2. Build binary with: scripts\compile-build-dist.bat"
    goto :error_exit
)

call :log_message "INFO" "Found application binary: %app_binary%"

REM Check if it's an installer or executable
if "%app_binary:Setup=%" neq "%app_binary%" (
    call :log_message "INFO" "Found installer. Running installer..."
    start "" "%app_binary%"
) else (
    call :log_message "INFO" "Starting application binary..."
    start "" "%app_binary%"
    
    REM Wait a moment and check if app started successfully
    timeout /t 2 /nobreak >nul
    tasklist /fi "imagename eq META Mover.exe" | find /i "META Mover.exe" >nul
    if %ERRORLEVEL% EQU 0 (
        call :log_message "SUCCESS" "META Mover started successfully"
    ) else (
        call :log_message "WARNING" "Application may not have started properly"
    )
)
goto :eof

:show_version
echo META Mover v3.0 - Windows Production Runner
echo.

REM Try to get version from package.json
if exist "%PROJECT_ROOT%\package.json" (
    for /f "tokens=2 delims=:, " %%i in ('findstr /c:"version" "%PROJECT_ROOT%\package.json"') do (
        set "pkg_version=%%i"
        set "pkg_version=!pkg_version:"=!"
        echo Package Version: !pkg_version!
    )
)

REM Try to get binary version
call :find_app_binary
if not "%app_binary%"=="" (
    echo Binary Version: Available
    echo Binary Location: %app_binary%
    if "%app_binary:Setup=%" neq "%app_binary%" (
        echo Binary Type: Installer
    ) else (
        echo Binary Type: Executable
    )
) else (
    echo Binary Version: Not built
)

echo.
echo System Information:
for /f "tokens=4-5 delims=. " %%i in ('ver') do echo Windows Version: %%i.%%j
if exist "%ProgramFiles%\nodejs\node.exe" (
    for /f "delims=" %%i in ('node --version 2^>nul') do echo Node.js Version: %%i
) else (
    echo Node.js: Not installed
)
goto :eof

:show_usage
echo META Mover - Windows Production Runner
echo.
echo Usage: %~nx0 [OPTIONS]
echo.
echo Options:
echo   --binary, -b      Run compiled binary (default)
echo   --source, -s      Run from built source code  
echo   --exe, -e         Run executable binary (alias for --binary)
echo   --version, -v     Show version information
echo   --help, -h        Show this help message
echo.
echo Examples:
echo   %~nx0              # Run compiled binary
echo   %~nx0 --binary     # Run compiled binary (explicit)
echo   %~nx0 --source     # Run from built source
echo   %~nx0 --version    # Show version info
goto :eof

:error_exit
call :log_message "ERROR" "Exiting due to error"
echo.
echo Press any key to exit...
pause >nul
exit /b 1

:cleanup
call :log_message "INFO" "Cleaning up..."
goto :eof

:main
REM Parse command line arguments
set "run_mode=binary"

:parse_args
if "%~1"=="" goto :start_execution
if /i "%~1"=="--binary" set "run_mode=binary" & shift & goto :parse_args
if /i "%~1"=="-b" set "run_mode=binary" & shift & goto :parse_args
if /i "%~1"=="--exe" set "run_mode=binary" & shift & goto :parse_args
if /i "%~1"=="-e" set "run_mode=binary" & shift & goto :parse_args
if /i "%~1"=="--source" set "run_mode=source" & shift & goto :parse_args
if /i "%~1"=="-s" set "run_mode=source" & shift & goto :parse_args
if /i "%~1"=="--version" call :show_version & exit /b 0
if /i "%~1"=="-v" call :show_version & exit /b 0
if /i "%~1"=="--help" call :show_usage & exit /b 0
if /i "%~1"=="-h" call :show_usage & exit /b 0
call :log_message "ERROR" "Unknown option: %~1"
call :show_usage
exit /b 1

:start_execution
echo ===================================================================================
echo                           META Mover v3.0 - Windows Production Runner
echo ===================================================================================
echo.

call :log_message "INFO" "Starting META Mover in production mode on Windows..."
call :log_message "INFO" "Run mode: %run_mode%"
call :log_message "INFO" "Log file: %LOG_FILE%"

REM Check system requirements
call :check_requirements

REM Run based on selected mode
if "%run_mode%"=="binary" (
    call :run_binary
) else if "%run_mode%"=="source" (
    call :run_from_source
) else (
    call :log_message "ERROR" "Invalid run mode: %run_mode%"
    goto :error_exit
)

REM Cleanup on exit
call :cleanup

echo.
echo Press any key to exit...
pause >nul