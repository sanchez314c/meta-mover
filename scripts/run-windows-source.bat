@echo off
setlocal enabledelayedexpansion

REM META Mover v3.0 - Windows Source Development Runner
REM Professional Windows batch script with colored output, Windows 10+ validation
REM Complete argument parsing and environment setup for development mode

REM ============================================================================
REM CONFIGURATION & CONSTANTS
REM ============================================================================

set "SCRIPT_NAME=run-windows-source.bat"
set "SCRIPT_VERSION=3.0.0"
set "PROJECT_NAME=META Mover"
set "MIN_WINDOWS_VERSION=10.0"
set "MIN_NODE_VERSION=18.0.0"
set "MIN_MEMORY_GB=8"

REM Color definitions for professional output (Windows 10+ ANSI support)
set "RED=[91m"
set "GREEN=[92m"
set "YELLOW=[93m"
set "BLUE=[94m"
set "PURPLE=[95m"
set "CYAN=[96m"
set "WHITE=[97m"
set "GRAY=[90m"
set "NC=[0m"

REM Enable ANSI colors for Windows 10+
reg add HKCU\Console /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >nul 2>&1

REM Logging configuration
set "LOG_LEVEL=INFO"
set "LOG_DIR=logs"
for /f "tokens=1-3 delims=/" %%a in ('%date%') do set "DATE_STAMP=%%c%%a%%b"
for /f "tokens=1-3 delims=:." %%a in ('%time%') do set "TIME_STAMP=%%a%%b%%c"
set "LOG_FILE=%LOG_DIR%\windows-source-%DATE_STAMP%_%TIME_STAMP%.log"

REM Create logs directory
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

REM ============================================================================
REM UTILITY FUNCTIONS
REM ============================================================================

goto :main

:log
set "level=%~1"
set "message=%~2"
set "timestamp=%DATE% %TIME%"

REM Console output with colors
if "%level%"=="ERROR" (
    echo %RED%[ERROR]%NC% %message% 1>&2
) else if "%level%"=="WARN" (
    echo %YELLOW%[WARN]%NC% %message%
) else if "%level%"=="SUCCESS" (
    echo %GREEN%[SUCCESS]%NC% %message%
) else if "%level%"=="INFO" (
    echo %BLUE%[INFO]%NC% %message%
) else if "%level%"=="DEBUG" (
    if "%LOG_LEVEL%"=="DEBUG" echo %GRAY%[DEBUG]%NC% %message%
)

REM Log file output
echo [%timestamp%] [%level%] %message% >> "%LOG_FILE%"
goto :eof

:print_header
echo %PURPLE%
echo =====================================================================
echo                  META Mover v3.0 - Development
echo                    Windows Source Runner
echo =====================================================================
echo %NC%
call :log "INFO" "Starting %SCRIPT_NAME% v%SCRIPT_VERSION%"
goto :eof

:cleanup_on_exit
call :log "INFO" "Cleaning up development environment..."

REM Kill any remaining processes
taskkill /f /im "META Mover.exe" >nul 2>&1
taskkill /f /im "electron.exe" >nul 2>&1
taskkill /f /im "node.exe" >nul 2>&1

REM Clean temporary files
if exist ".tmp-build" rmdir /s /q ".tmp-build" >nul 2>&1

call :log "SUCCESS" "Cleanup completed"
goto :eof

REM ============================================================================
REM SYSTEM REQUIREMENTS VALIDATION
REM ============================================================================

:check_windows_version
for /f "tokens=4-5 delims=. " %%i in ('ver') do set "CURRENT_VERSION=%%i.%%j"
call :log "INFO" "Checking Windows version: %CURRENT_VERSION% (minimum: %MIN_WINDOWS_VERSION%)"

REM Parse version numbers for comparison
for /f "tokens=1,2 delims=." %%a in ("%CURRENT_VERSION%") do (
    set "major=%%a"
    set "minor=%%b"
)
for /f "tokens=1,2 delims=." %%a in ("%MIN_WINDOWS_VERSION%") do (
    set "min_major=%%a"
    set "min_minor=%%b"
)

if %major% LSS %min_major% (
    call :log "ERROR" "Windows %MIN_WINDOWS_VERSION% or later is required. Current: %CURRENT_VERSION%"
    goto :error_exit
) else if %major% EQU %min_major% (
    if %minor% LSS %min_minor% (
        call :log "ERROR" "Windows %MIN_WINDOWS_VERSION% or later is required. Current: %CURRENT_VERSION%"
        goto :error_exit
    )
)

call :log "SUCCESS" "Windows version check passed"
goto :eof

:check_node_version
node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    call :log "ERROR" "Node.js is not installed. Please install Node.js %MIN_NODE_VERSION% or later"
    goto :error_exit
)

for /f "delims=" %%i in ('node --version') do set "CURRENT_NODE_VERSION=%%i"
set "CURRENT_NODE_VERSION=%CURRENT_NODE_VERSION:v=%"

call :log "INFO" "Checking Node.js version: %CURRENT_NODE_VERSION% (minimum: %MIN_NODE_VERSION%)"

REM Simple version comparison for Node.js
for /f "tokens=1 delims=." %%a in ("%CURRENT_NODE_VERSION%") do set "node_major=%%a"
if %node_major% LSS 18 (
    call :log "ERROR" "Node.js %MIN_NODE_VERSION% or later is required. Current: v%CURRENT_NODE_VERSION%"
    goto :error_exit
)

call :log "SUCCESS" "Node.js version check passed"
goto :eof

:check_system_resources
REM Get system memory in MB
for /f "skip=1 tokens=4" %%a in ('wmic computersystem get TotalPhysicalMemory') do (
    if not "%%a"=="" (
        set /a "total_memory_gb=%%a / 1024 / 1024 / 1024"
        goto :memory_done
    )
)
:memory_done

call :log "INFO" "Checking system memory: %total_memory_gb%GB (minimum: %MIN_MEMORY_GB%GB)"

if %total_memory_gb% LSS %MIN_MEMORY_GB% (
    call :log "WARN" "System has only %total_memory_gb%GB memory. Recommended: %MIN_MEMORY_GB%GB+"
    call :log "WARN" "Performance may be degraded with limited memory"
) else (
    call :log "SUCCESS" "System memory check passed"
)

REM Check available disk space (simplified)
for /f "tokens=3" %%a in ('dir /-c ^| find "bytes free"') do set "free_space=%%a"
call :log "INFO" "Available disk space check completed"
goto :eof

:check_development_tools
call :log "INFO" "Validating development tools..."

set "missing_tools="

node --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 set "missing_tools=%missing_tools% node"

npm --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 set "missing_tools=%missing_tools% npm"

git --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 set "missing_tools=%missing_tools% git"

python --version >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    python3 --version >nul 2>&1
    if %ERRORLEVEL% NEQ 0 set "missing_tools=%missing_tools% python"
)

if not "%missing_tools%"=="" (
    call :log "ERROR" "Missing required tools:%missing_tools%"
    call :log "ERROR" "Please install missing tools and try again"
    goto :error_exit
)

call :log "SUCCESS" "Development tools validation passed"
goto :eof

REM ============================================================================
REM ENVIRONMENT SETUP
REM ============================================================================

:setup_development_environment
call :log "INFO" "Setting up Windows development environment..."

REM Enable Windows development features
set "ELECTRON_ENABLE_GPU=true"
set "ELECTRON_DISABLE_SECURITY_WARNINGS=false"

REM Development optimization flags
set "NODE_ENV=development"
set "ELECTRON_IS_DEV=true"
set "ELECTRON_ENABLE_LOGGING=true"
set "ELECTRON_ENABLE_STACK_DUMPING=true"

REM Memory optimization for development
set "NODE_OPTIONS=--max-old-space-size=8192"
set "UV_THREADPOOL_SIZE=8"

REM Windows specific optimizations
set "FORCE_COLOR=1"
set "COLORTERM=truecolor"

REM Webpack development server settings
set "WEBPACK_DEV_SERVER_HOST=localhost"
set "WEBPACK_DEV_SERVER_PORT=3000"
set "WEBPACK_HOT_RELOAD=true"

call :log "SUCCESS" "Development environment configured"
goto :eof

:install_dependencies
set "clean_flag=%~1"
call :log "INFO" "Installing/updating dependencies..."

if not exist "package.json" (
    call :log "ERROR" "package.json not found. Are you in the correct directory?"
    goto :error_exit
)

REM Clear npm cache if needed
if "%clean_flag%"=="--clean" (
    call :log "INFO" "Clearing npm cache..."
    npm cache clean --force
    if exist "node_modules" rmdir /s /q "node_modules"
    if exist "package-lock.json" del "package-lock.json"
)

REM Install dependencies with timing
set "start_time=%TIME%"

npm install --verbose --no-fund --no-audit
if %ERRORLEVEL% NEQ 0 (
    call :log "ERROR" "Failed to install dependencies"
    goto :error_exit
)

set "end_time=%TIME%"
call :log "SUCCESS" "Dependencies installed successfully"
goto :eof

REM ============================================================================
REM BUILD PROCESS MANAGEMENT
REM ============================================================================

:run_development_build
call :log "INFO" "Starting development build process..."

REM Create temporary build directory
if not exist ".tmp-build" mkdir ".tmp-build"

REM Run linting first
npm run lint:check >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    call :log "INFO" "Running ESLint validation..."
    npm run lint:check
    if %ERRORLEVEL% NEQ 0 (
        call :log "WARN" "ESLint warnings detected. Continuing anyway..."
    )
)

REM Run TypeScript compilation check
npm run type:check >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    call :log "INFO" "Running TypeScript validation..."
    npm run type:check
    if %ERRORLEVEL% NEQ 0 (
        call :log "WARN" "TypeScript warnings detected. Continuing anyway..."
    )
)

REM Start the development server
call :log "INFO" "Starting Electron in development mode..."
call :log "INFO" "Application will open in a new window"
call :log "INFO" "Press Ctrl+C to stop the development server"

REM Run with proper error handling
npm run dev
if %ERRORLEVEL% NEQ 0 (
    call :log "ERROR" "Development server failed to start"
    goto :error_exit
)

goto :eof

REM ============================================================================
REM MONITORING & DIAGNOSTICS
REM ============================================================================

:monitor_process
set "process_name=%~1"
set "timeout=%~2"
if "%timeout%"=="" set "timeout=30"
set "count=0"

call :log "INFO" "Monitoring %process_name% startup (timeout: %timeout%s)..."

:monitor_loop
if %count% GEQ %timeout% goto :monitor_timeout

tasklist /FI "IMAGENAME eq %process_name%" 2>nul | find /I "%process_name%" >nul
if %ERRORLEVEL% EQU 0 (
    for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq %process_name%" ^| find /I "%process_name%"') do (
        call :log "SUCCESS" "%process_name% is running (PID: %%a)"
        goto :eof
    )
)

timeout /t 1 /nobreak >nul
set /a count+=1

set /a remainder=%count% %% 5
if %remainder% EQU 0 (
    call :log "INFO" "Still waiting for %process_name%... (%count%s elapsed)"
)

goto :monitor_loop

:monitor_timeout
call :log "WARN" "%process_name% did not start within %timeout%s"
goto :eof

:print_system_info
call :log "INFO" "System Information:"
echo   ^• Windows Version: %CURRENT_VERSION%
echo   ^• Architecture: %PROCESSOR_ARCHITECTURE%
if defined CURRENT_NODE_VERSION echo   ^• Node.js: v%CURRENT_NODE_VERSION%
if defined NPM_VERSION echo   ^• NPM: %NPM_VERSION%
echo   ^• Memory: %total_memory_gb%GB
echo   ^• CPU Cores: %NUMBER_OF_PROCESSORS%
goto :eof

REM ============================================================================
REM COMMAND LINE ARGUMENT PROCESSING
REM ============================================================================

:show_help
echo %WHITE%%PROJECT_NAME% v%SCRIPT_VERSION% - Windows Development Runner%NC%
echo.
echo USAGE:
echo   %~nx0 [OPTIONS]
echo.
echo OPTIONS:
echo   --clean          Clean install (remove node_modules and cache)
echo   --skip-deps      Skip dependency installation
echo   --skip-checks    Skip system requirement checks
echo   --debug          Enable debug logging
echo   --info           Show system information
echo   --help           Show this help message
echo.
echo EXAMPLES:
echo   %~nx0                    # Standard development run
echo   %~nx0 --clean           # Clean install and run
echo   %~nx0 --debug           # Run with debug logging
echo   %~nx0 --skip-deps       # Skip dependency installation
echo.
echo ENVIRONMENT VARIABLES:
echo   LOG_LEVEL            Set logging level (DEBUG, INFO, WARN, ERROR)
echo   NODE_ENV             Node.js environment (defaults to development)
echo.
goto :eof

REM ============================================================================
REM MAIN EXECUTION FLOW
REM ============================================================================

:error_exit
call :log "ERROR" "Script execution failed"
echo.
echo Press any key to exit...
pause >nul
exit /b 1

:main
set "clean_install=false"
set "skip_deps=false"
set "skip_checks=false"
set "show_info=false"

REM Parse command line arguments
:parse_args
if "%~1"=="" goto :start_execution

if /i "%~1"=="--clean" (
    set "clean_install=true"
    shift
    goto :parse_args
)
if /i "%~1"=="--skip-deps" (
    set "skip_deps=true"
    shift
    goto :parse_args
)
if /i "%~1"=="--skip-checks" (
    set "skip_checks=true"
    shift
    goto :parse_args
)
if /i "%~1"=="--debug" (
    set "LOG_LEVEL=DEBUG"
    shift
    goto :parse_args
)
if /i "%~1"=="--info" (
    set "show_info=true"
    shift
    goto :parse_args
)
if /i "%~1"=="--help" (
    call :show_help
    exit /b 0
)
if /i "%~1"=="-h" (
    call :show_help
    exit /b 0
)

call :log "ERROR" "Unknown option: %~1"
call :show_help
exit /b 1

:start_execution
REM Print header
call :print_header

REM Show system info if requested
if "%show_info%"=="true" (
    call :print_system_info
    exit /b 0
)

REM System validation (unless skipped)
if "%skip_checks%"=="false" (
    call :check_windows_version
    if %ERRORLEVEL% NEQ 0 goto :error_exit
    
    call :check_node_version
    if %ERRORLEVEL% NEQ 0 goto :error_exit
    
    call :check_system_resources
    call :check_development_tools
    if %ERRORLEVEL% NEQ 0 goto :error_exit
)

REM Environment setup
call :setup_development_environment

REM Dependency management (unless skipped)
if "%skip_deps%"=="false" (
    if "%clean_install%"=="true" (
        call :install_dependencies "--clean"
        if %ERRORLEVEL% NEQ 0 goto :error_exit
    ) else (
        call :install_dependencies
        if %ERRORLEVEL% NEQ 0 goto :error_exit
    )
)

REM Start development build
call :run_development_build
if %ERRORLEVEL% NEQ 0 goto :error_exit

call :log "SUCCESS" "Development session completed successfully"

REM Cleanup on exit
call :cleanup_on_exit

echo.
echo Press any key to exit...
pause >nul