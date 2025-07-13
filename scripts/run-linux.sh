#!/bin/bash

####################################################################################
#
# META Mover - Linux Production Runner
#
# Author: @spacewelder314
# Date: 2025-09-11
# Version: 3.0.0
#
# Description: Run META Mover compiled binary on Linux with production settings
#
# Usage: ./scripts/run-linux.sh [--binary] [--appimage] [--deb] [--version]
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
LOG_FILE="$LOG_DIR/run-linux-$(date +%Y%m%d-%H%M%S).log"

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
    
    # Check display server
    if [[ -n "$DISPLAY" ]]; then
        log_message "INFO" "Display Server: X11 ($DISPLAY)"
    elif [[ -n "$WAYLAND_DISPLAY" ]]; then
        log_message "INFO" "Display Server: Wayland ($WAYLAND_DISPLAY)"
    else
        log_message "WARNING" "No display server detected - GUI may not work"
    fi
    
    log_message "SUCCESS" "System requirements check passed"
}

# Function to locate application binary
find_app_binary() {
    local binary_paths=(
        "$PROJECT_ROOT/release/META Mover-*.AppImage"
        "$PROJECT_ROOT/release/linux-unpacked/meta-mover"
        "$PROJECT_ROOT/dist/linux-unpacked/meta-mover"
        "$PROJECT_ROOT/release/META Mover-*-x86_64.AppImage"
        "/usr/local/bin/meta-mover"
        "/opt/META_Mover/meta-mover"
    )
    
    # Check for AppImage files
    for pattern in "${binary_paths[@]}"; do
        for path in $pattern; do
            if [[ -f "$path" ]]; then
                echo "$path"
                return 0
            fi
        done
    done
    
    return 1
}

# Function to run from built source
run_from_source() {
    log_message "INFO" "Running from built source..."
    
    cd "$PROJECT_ROOT" || {
        log_message "ERROR" "Failed to change to project directory: $PROJECT_ROOT"
        exit 1
    }
    
    # Check if package.json exists
    if [[ ! -f "package.json" ]]; then
        log_message "ERROR" "package.json not found in project root"
        exit 1
    fi
    
    # Check if Node.js is installed
    if ! command -v node &> /dev/null; then
        log_message "ERROR" "Node.js not found. Please install Node.js 18+:"
        local distro=$(detect_distro)
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
    
    # Install dependencies if needed
    if [[ ! -d "node_modules" ]]; then
        log_message "INFO" "Installing dependencies..."
        if ! npm ci; then
            log_message "WARNING" "npm ci failed, trying npm install..."
            if ! npm install; then
                log_message "ERROR" "Failed to install dependencies"
                exit 1
            fi
        fi
        log_message "SUCCESS" "Dependencies installed successfully"
    fi
    
    # Build if dist doesn't exist or is outdated
    if [[ ! -d "dist" ]] || [[ "package.json" -nt "dist" ]]; then
        log_message "INFO" "Building production version..."
        if ! npm run build; then
            log_message "ERROR" "Production build failed"
            exit 1
        fi
        log_message "SUCCESS" "Production build completed"
    fi
    
    # Set production environment variables
    export NODE_ENV=production
    export ELECTRON_DISABLE_GPU_SANDBOX=1  # Prevent GPU sandbox issues
    export ELECTRON_ARGS="--no-sandbox --disable-dev-shm-usage"
    
    # Handle common Linux display issues
    if [[ -z "$DISPLAY" ]] && [[ -z "$WAYLAND_DISPLAY" ]]; then
        log_message "WARNING" "No display server detected. Setting DISPLAY=:0"
        export DISPLAY=:0
    fi
    
    # Run the built application
    log_message "INFO" "Starting production application from source..."
    npm start
}

# Function to run binary application
run_binary() {
    local app_path=$(find_app_binary)
    
    if [[ -z "$app_path" ]]; then
        log_message "ERROR" "No compiled binary found. Available options:"
        log_message "INFO" "1. Run from source with: $0 --source"
        log_message "INFO" "2. Build binary with: ./scripts/compile-build-dist.sh"
        exit 1
    fi
    
    log_message "INFO" "Found application binary: $app_path"
    
    # Check if it's an AppImage
    if [[ "$app_path" == *.AppImage ]]; then
        # Make sure AppImage is executable
        if [[ ! -x "$app_path" ]]; then
            log_message "INFO" "Making AppImage executable..."
            chmod +x "$app_path"
        fi
        
        # Set environment variables for AppImage
        export APPIMAGE_EXTRACT_AND_RUN=1  # For systems without FUSE
        
        log_message "INFO" "Starting AppImage..."
        "$app_path" &
        
    else
        # Regular binary
        if [[ ! -x "$app_path" ]]; then
            log_message "ERROR" "Binary is not executable: $app_path"
            exit 1
        fi
        
        log_message "INFO" "Starting application binary..."
        "$app_path" &
    fi
    
    # Wait a moment and check if app started successfully
    sleep 2
    if pgrep -f "meta-mover\|META.Mover" > /dev/null; then
        log_message "SUCCESS" "META Mover started successfully"
    else
        log_message "WARNING" "Application may not have started properly"
    fi
}

# Function to show version information
show_version() {
    echo "META Mover v3.0 - Linux Production Runner"
    echo ""
    
    # Try to get version from package.json
    if [[ -f "$PROJECT_ROOT/package.json" ]]; then
        local pkg_version=$(grep '"version"' "$PROJECT_ROOT/package.json" | cut -d'"' -f4)
        echo "Package Version: $pkg_version"
    fi
    
    # Try to get binary version
    local app_path=$(find_app_binary)
    if [[ -n "$app_path" ]]; then
        echo "Binary Version: Available"
        echo "Binary Location: $app_path"
        echo "Binary Type: $(file "$app_path" | cut -d':' -f2)"
    else
        echo "Binary Version: Not built"
    fi
    
    echo ""
    echo "System Information:"
    echo "Linux Distribution: $(detect_distro)"
    echo "Kernel Version: $(uname -r)"
    
    if command -v node &> /dev/null; then
        echo "Node.js Version: $(node --version)"
    else
        echo "Node.js: Not installed"
    fi
    
    if [[ -n "$DISPLAY" ]]; then
        echo "Display Server: X11 ($DISPLAY)"
    elif [[ -n "$WAYLAND_DISPLAY" ]]; then
        echo "Display Server: Wayland ($WAYLAND_DISPLAY)"
    else
        echo "Display Server: Not detected"
    fi
}

# Function to show usage
show_usage() {
    echo "META Mover - Linux Production Runner"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --binary, -b      Run compiled binary (default)"
    echo "  --source, -s      Run from built source code"
    echo "  --appimage, -a    Run AppImage binary (alias for --binary)"
    echo "  --deb, -d         Run DEB package binary"
    echo "  --version, -v     Show version information"
    echo "  --help, -h        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                # Run compiled binary"
    echo "  $0 --binary       # Run compiled binary (explicit)"
    echo "  $0 --source       # Run from built source"
    echo "  $0 --version      # Show version info"
}

# Main execution
main() {
    local run_mode="binary"  # Default to binary
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --binary|-b|--appimage|-a|--deb|-d)
                run_mode="binary"
                shift
                ;;
            --source|-s)
                run_mode="source"
                shift
                ;;
            --version|-v)
                show_version
                exit 0
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
    echo "                           META Mover v3.0 - Linux Production Runner"
    echo "==================================================================================="
    echo ""
    
    log_message "INFO" "Starting META Mover in production mode on Linux..."
    log_message "INFO" "Run mode: $run_mode"
    log_message "INFO" "Log file: $LOG_FILE"
    
    # Check system requirements
    check_requirements
    
    # Run based on selected mode
    case $run_mode in
        "binary")
            run_binary
            ;;
        "source")
            run_from_source
            ;;
        *)
            log_message "ERROR" "Invalid run mode: $run_mode"
            exit 1
            ;;
    esac
}

# Trap to handle cleanup on exit
cleanup() {
    log_message "INFO" "Cleaning up..."
    exit 0
}

trap cleanup EXIT INT TERM

# Run main function with all arguments
main "$@"