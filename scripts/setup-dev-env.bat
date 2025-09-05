@echo off
REM META_Mover Development Environment Setup for Windows
REM Self-contained environment with Conda integration

echo 🚀 Setting up META_Mover development environment...

REM Check if conda is available
where conda >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Conda is not installed or not in PATH
    echo [ERROR] Please install Miniconda or Anaconda first
    echo [ERROR] Visit: https://docs.conda.io/en/latest/miniconda.html
    pause
    exit /b 1
)

echo [SUCCESS] Conda found
conda --version

REM Check if environment already exists
conda env list | findstr "metamover-dev" >nul
if %errorlevel% equ 0 (
    echo [WARNING] Environment 'metamover-dev' already exists
    set /p recreate="Do you want to remove and recreate it? [y/N]: "
    if /i "%recreate%"=="y" (
        echo [INFO] Removing existing environment...
        conda env remove -n metamover-dev -y
    ) else (
        echo [INFO] Using existing environment...
        conda activate metamover-dev
        exit /b 0
    )
)

REM Create conda environment from file
echo [INFO] Creating conda environment from environment.yml...
conda env create -f environment.yml

if %errorlevel% neq 0 (
    echo [ERROR] Failed to create conda environment
    pause
    exit /b 1
)

echo [SUCCESS] Conda environment 'metamover-dev' created successfully!

REM Activate environment
echo [INFO] Activating environment...
call conda activate metamover-dev

REM Verify Node.js installation
echo [INFO] Verifying Node.js installation...
node --version
npm --version

REM Set npm configuration for local environment
echo [INFO] Configuring npm for local environment...
npm config set prefix "%CONDA_PREFIX%"
npm config set cache "%CONDA_PREFIX%\.npm"
npm config set tmp "%CONDA_PREFIX%\tmp"

REM Create necessary directories
if not exist "%CONDA_PREFIX%\.npm" mkdir "%CONDA_PREFIX%\.npm"
if not exist "%CONDA_PREFIX%\tmp" mkdir "%CONDA_PREFIX%\tmp"

REM Install global development tools in conda environment
echo [INFO] Installing global development tools...
npm install -g electron@latest
npm install -g electron-builder@latest
npm install -g typescript@latest
npm install -g concurrently@latest

REM Install project dependencies
echo [INFO] Installing project dependencies...
npm install

if %errorlevel% neq 0 (
    echo [ERROR] Failed to install project dependencies
    pause
    exit /b 1
)

REM Create activation script for easy environment setup
echo @echo off > activate-dev.bat
echo REM Activate META_Mover development environment >> activate-dev.bat
echo. >> activate-dev.bat
echo echo 🚀 Activating META_Mover development environment... >> activate-dev.bat
echo. >> activate-dev.bat
echo REM Activate conda environment >> activate-dev.bat
echo call conda activate metamover-dev >> activate-dev.bat
echo. >> activate-dev.bat
echo if "%%CONDA_DEFAULT_ENV%%"=="metamover-dev" ^( >> activate-dev.bat
echo     echo ✅ Environment activated successfully! >> activate-dev.bat
echo     node --version >> activate-dev.bat
echo     npm --version >> activate-dev.bat
echo     echo. >> activate-dev.bat
echo     echo Available commands: >> activate-dev.bat
echo     echo   npm run dev          - Start development server >> activate-dev.bat
echo     echo   npm run build        - Build for production >> activate-dev.bat
echo     echo   npm run test         - Run test suite >> activate-dev.bat
echo     echo   npm run lint         - Run code linting >> activate-dev.bat
echo     echo   npm run typecheck    - Run TypeScript checking >> activate-dev.bat
echo     echo   npm run dist         - Create distributable packages >> activate-dev.bat
echo     echo. >> activate-dev.bat
echo ^) else ^( >> activate-dev.bat
echo     echo ❌ Failed to activate environment >> activate-dev.bat
echo     exit /b 1 >> activate-dev.bat
echo ^) >> activate-dev.bat

REM Create development configuration
echo # Development Environment Configuration > .env.development
echo NODE_ENV=development >> .env.development
echo ELECTRON_ENV=development >> .env.development
echo. >> .env.development
echo # Enable development features >> .env.development
echo ELECTRON_IS_DEV=true >> .env.development
echo DEBUG=metamover:* >> .env.development
echo. >> .env.development
echo # Hot reload settings >> .env.development
echo WEBPACK_DEV_SERVER_PORT=3000 >> .env.development
echo ELECTRON_RELOAD=true >> .env.development
echo. >> .env.development
echo # Logging >> .env.development
echo LOG_LEVEL=debug >> .env.development
echo LOG_TO_FILE=false >> .env.development
echo. >> .env.development
echo # Performance monitoring >> .env.development
echo ENABLE_PERFORMANCE_MONITORING=true >> .env.development

echo [SUCCESS] Development environment setup complete!
echo.
echo 🎉 Next steps:
echo 1. Run: activate-dev.bat
echo 2. Run: npm run dev
echo.
echo 📝 Available commands:
echo   npm run dev      - Start development server with hot reload
echo   npm run build    - Build for production
echo   npm run test     - Run comprehensive test suite
echo   npm run dist     - Create distributable packages
echo.
echo [WARNING] Note: Always activate the conda environment before working:
echo   conda activate metamover-dev
echo.

REM Final verification
echo [INFO] Environment verification:
echo   📁 Conda environment: %CONDA_DEFAULT_ENV%
node --version
npm --version

echo [SUCCESS] 🎉 META_Mover development environment is ready!
pause