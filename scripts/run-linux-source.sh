#!/bin/bash

####################################################################################
#
# META Mover - Linux Source Runner
#
# Author: @spacewelder314
# Date: 2025-09-11
# Version: 3.0.0
#
# Description: Run META Mover from source code on Linux with environment setup
#
# Usage: ./scripts/run-linux-source.sh [--dev]
#
####################################################################################

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Logging setup
LOG_DIR="$PROJECT_ROOT/logs"
LOG_FILE="$LOG_DIR/run-linux-source-$(date +%Y%m%d-%H%M%S).log"

# Create logs directory if it doesn't exist
mkdir -p "$LOG_DIR"

# Function to log messages
log_message() {
    local level="$1"
    local message="$2"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[$timestamp] [$level] $message" >> "$LOG_FILE"
    
    case $level in
        "ERROR")
            echo -e "${RED}[ERROR]${NC} $message"
            ;;
        "SUCCESS")
            echo -e "${GREEN}[SUCCESS]${NC} $message"
            ;;
        "WARNING")
            echo -e "${YELLOW}[WARNING]${NC} $message"
            ;;
        "INFO")
            echo -e "${BLUE}[INFO]${NC} $message"
            ;;
        *)
            echo "[$level] $message"
            ;;
    esac
}

# Function to detect Linux distribution
detect_distro() {
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        echo "$ID"
    elif [[ -f /etc/redhat-release ]]; then
        echo "rhel"
    elif [[ -f /etc/debian_version ]]; then
        echo "debian"
    else
        echo "unknown"
    fi
}

# Function to check system requirements
check_requirements() {
    log_message "INFO" "Checking system requirements..."
    
    # Detect Linux distribution
    local distro=$(detect_distro)
    log_message "INFO" "Linux Distribution: $distro"
    
    # Check kernel version
    local kernel_version=$(uname -r)
    log_message "INFO" "Kernel Version: $kernel_version"
    
    # Check for required libraries
    local missing_libs=()
    
    # Check for X11 libraries (required for Electron on Linux)
    if ! ldconfig -p | grep -q libX11; then
        missing_libs+=("libx11-dev")
    fi
    
    if ! ldconfig -p | grep -q libXtst; then
        missing_libs+=("libxtst6")
    fi
    
    if ! ldconfig -p | grep -q libnss; then
        missing_libs+=("libnss3")
    fi
    
    if ! ldconfig -p | grep -q libgconf; then
        missing_libs+=("libgconf-2-4")
    fi
    
    if [[ ${#missing_libs[@]} -gt 0 ]]; then
        log_message "WARNING" "Missing system libraries detected: ${missing_libs[*]}"
        case $distro in
            "ubuntu"|"debian")
                log_message "INFO" "Install with: sudo apt-get install ${missing_libs[*]}"
                ;;
            "rhel"|"centos"|"fedora")
                log_message "INFO" "Install with: sudo yum install ${missing_libs[*]}"
                ;;
        esac
    fi
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_message "ERROR" "Node.js not found. Please install Node.js 18+:"
        case $distro in
            "ubuntu"|"debian")
                log_message "INFO" "sudo apt install nodejs npm"
                ;;
            "rhel"|"centos"|"fedora")
                log_message "INFO" "sudo yum install nodejs npm"
                ;;
        esac
        exit 1
    fi
    
    local node_version=$(node --version)
    local node_major=$(echo $node_version | cut -d'v' -f2 | cut -d'.' -f1)
    log_message "INFO" "Node.js Version: $node_version"
    
    if [[ $node_major -lt 18 ]]; then
        log_message "ERROR" "Node.js 18+ required. Current: $node_version"
        exit 1
    fi
    
    # Check npm
    if ! command -v npm &> /dev/null; then
        log_message "ERROR" "npm not found. Please install npm"
        exit 1
    fi
    
    local npm_version=$(npm --version)
    log_message "INFO" "npm Version: $npm_version"
    
    # Check display server
    if [[ -n "$DISPLAY" ]]; then
        log_message "INFO" "Display Server: X11 ($DISPLAY)"
    elif [[ -n "$WAYLAND_DISPLAY" ]]; then
        log_message "INFO" "Display Server: Wayland ($WAYLAND_DISPLAY)"
    else
        log_message "WARNING" "No display server detected - GUI may not work"
    fi
    
    log_message "SUCCESS" "System requirements check completed"
}

# Function to setup environment
setup_environment() {
    log_message "INFO" "Setting up development environment..."
    
    # Change to project directory
    cd "$PROJECT_ROOT" || {
        log_message "ERROR" "Failed to change to project directory: $PROJECT_ROOT"
        exit 1
    }
    
    # Check if package.json exists
    if [[ ! -f "package.json" ]]; then
        log_message "ERROR" "package.json not found in project root"
        exit 1
    fi
    
    # Install dependencies if node_modules doesn't exist or if package-lock.json is newer
    if [[ ! -d "node_modules" ]] || [[ "package-lock.json" -nt "node_modules" ]]; then
        log_message "INFO" "Installing dependencies..."
        if ! npm ci; then
            log_message "WARNING" "npm ci failed, trying npm install..."
            if ! npm install; then
                log_message "ERROR" "Failed to install dependencies"
                exit 1
            fi
        fi
        log_message "SUCCESS" "Dependencies installed successfully"
    else
        log_message "INFO" "Dependencies are up to date"
    fi
    
    # Set environment variables
    export NODE_ENV=development
    export ELECTRON_IS_DEV=1
    export FORCE_COLOR=1
    
    # Linux-specific environment variables
    export ELECTRON_DISABLE_GPU_SANDBOX=1  # Prevent GPU sandbox issues
    export ELECTRON_ENABLE_LOGGING=1       # Enable detailed logging
    
    # Handle common Linux display issues
    if [[ -z "$DISPLAY" ]] && [[ -z "$WAYLAND_DISPLAY" ]]; then
        log_message "WARNING" "No display server detected. Setting DISPLAY=:0"
        export DISPLAY=:0
    fi
    
    # Activate development environment if available
    if [[ -f "./scripts/activate-dev.sh" ]]; then
        log_message "INFO" "Activating development environment..."
        source "./scripts/activate-dev.sh"
    fi
    
    log_message "SUCCESS" "Environment setup completed"
}

# Function to build development version
build_dev() {
    log_message "INFO" "Building development version..."
    
    # Clean previous builds
    if [[ -d "dist" ]]; then
        log_message "INFO" "Cleaning previous build..."
        rm -rf dist
    fi
    
    # Build development version
    log_message "INFO" "Running webpack build:dev..."
    if npm run build:dev; then
        log_message "SUCCESS" "Development build completed"
    else
        log_message "ERROR" "Development build failed"
        exit 1
    fi
}

# Function to start application
start_application() {
    local dev_mode="$1"
    
    log_message "INFO" "Starting META Mover from source..."
    
    # Set additional Linux-specific flags for Electron
    export ELECTRON_ARGS="--no-sandbox --disable-dev-shm-usage"
    
    if [[ "$dev_mode" == "true" ]]; then
        log_message "INFO" "Running in development mode with auto-reload..."
        # Start with development server
        npm run dev
    else
        log_message "INFO" "Running built application..."
        # Start built application
        npm start
    fi
}

# Function to show usage
show_usage() {
    echo "META Mover - Linux Source Runner"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --dev, -d     Run in development mode with auto-reload"
    echo "  --help, -h    Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0              # Run from built source"
    echo "  $0 --dev       # Run in development mode"
}

# Main execution
main() {
    local dev_mode="false"
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --dev|-d)
                dev_mode="true"
                shift
                ;;
            --help|-h)
                show_usage
                exit 0
                ;;
            *)
                log_message "ERROR" "Unknown option: $1"
                show_usage
                exit 1
                ;;
        esac
    done
    
    echo "==================================================================================="
    echo "                            META Mover v3.0 - Linux Source Runner"
    echo "==================================================================================="
    echo ""
    
    log_message "INFO" "Starting META Mover from source on Linux..."
    log_message "INFO" "Log file: $LOG_FILE"
    
    # Check system requirements
    check_requirements
    
    # Setup environment
    setup_environment
    
    # Build if not in dev mode
    if [[ "$dev_mode" != "true" ]]; then
        build_dev
    fi
    
    # Start application
    start_application "$dev_mode"
}

# Trap to handle cleanup on exit
cleanup() {
    log_message "INFO" "Cleaning up..."
    # Kill any remaining processes if needed
    pkill -f "electron.*META.*Mover" || true
    exit 0
}

trap cleanup EXIT INT TERM

# Run main function with all arguments
main "$@"