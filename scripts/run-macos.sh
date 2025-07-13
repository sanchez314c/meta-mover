#!/bin/bash

# META Mover v3.0 - macOS Production Runner
# Professional production script with binary detection, app bundle validation, and version reporting
# Supports both source and binary execution modes with comprehensive error handling

set -euo pipefail

# ============================================================================
# CONFIGURATION & CONSTANTS
# ============================================================================

readonly SCRIPT_NAME="run-macos.sh"
readonly SCRIPT_VERSION="3.0.0"
readonly PROJECT_NAME="META Mover"
readonly MIN_MACOS_VERSION="12.0"

# Color definitions for professional output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly PURPLE='\033[0;35m'
readonly CYAN='\033[0;36m'
readonly WHITE='\033[1;37m'
readonly GRAY='\033[0;90m'
readonly NC='\033[0m' # No Color

# Logging configuration
LOG_LEVEL=${LOG_LEVEL:-"INFO"}
readonly LOG_DIR="logs"
readonly LOG_FILE="${LOG_DIR}/macos-production-$(date +%Y%m%d_%H%M%S).log"

# Binary search paths (ordered by preference)
readonly BINARY_SEARCH_PATHS=(
    "./release/mac/META\ Mover.app"
    "./dist/mac/META\ Mover.app"
    "./dist/mac/META\ Mover-darwin-x64/META\ Mover.app"
    "./dist/mac/META\ Mover-darwin-arm64/META\ Mover.app"
    "./release/META\ Mover-darwin-x64/META\ Mover.app"
    "./release/META\ Mover-darwin-arm64/META\ Mover.app"
    "/Applications/META\ Mover.app"
)

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

log() {
    local level=$1
    shift
    local message="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    # Console output with colors
    case $level in
        ERROR)   echo -e "${RED}[ERROR]${NC} ${message}" >&2 ;;
        WARN)    echo -e "${YELLOW}[WARN]${NC} ${message}" ;;
        SUCCESS) echo -e "${GREEN}[SUCCESS]${NC} ${message}" ;;
        INFO)    echo -e "${BLUE}[INFO]${NC} ${message}" ;;
        DEBUG)   [[ $LOG_LEVEL == "DEBUG" ]] && echo -e "${GRAY}[DEBUG]${NC} ${message}" ;;
    esac
    
    # Log file output (ensure directory exists)
    mkdir -p "$LOG_DIR"
    echo "[$timestamp] [$level] $message" >> "$LOG_FILE"
}

print_header() {
    echo -e "${PURPLE}"
    echo "╔══════════════════════════════════════════════════════════════════════════════╗"
    echo "║                          META Mover v3.0 - Production                      ║"
    echo "║                               macOS Binary Runner                           ║"
    echo "╚══════════════════════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    log INFO "Starting $SCRIPT_NAME v$SCRIPT_VERSION"
}

cleanup_on_exit() {
    log INFO "Cleaning up production environment..."
    
    # Kill any remaining processes
    pkill -f "META Mover" 2>/dev/null || true
    
    log SUCCESS "Cleanup completed"
}

# ============================================================================
# SYSTEM VALIDATION
# ============================================================================

check_macos_version() {
    local current_version
    current_version=$(sw_vers -productVersion)
    
    log INFO "Checking macOS version: $current_version (minimum: $MIN_MACOS_VERSION)"
    
    if ! version_greater_equal "$current_version" "$MIN_MACOS_VERSION"; then
        log ERROR "macOS $MIN_MACOS_VERSION or later is required. Current: $current_version"
        return 1
    fi
    
    log SUCCESS "macOS version check passed"
}

version_greater_equal() {
    local version1=$1
    local version2=$2
    
    # Convert versions to comparable numbers
    local v1_num v2_num
    v1_num=$(echo "$version1" | awk -F. '{printf "%d%03d%03d", $1, $2, $3}')
    v2_num=$(echo "$version2" | awk -F. '{printf "%d%03d%03d", $1, $2, $3}')
    
    [[ $v1_num -ge $v2_num ]]
}

check_app_bundle_validity() {
    local app_path="$1"
    
    log INFO "Validating app bundle: $app_path"
    
    # Check if app bundle exists
    if [[ ! -d "$app_path" ]]; then
        log ERROR "App bundle not found: $app_path"
        return 1
    fi
    
    # Check for executable
    local executable="$app_path/Contents/MacOS/META Mover"
    if [[ ! -f "$executable" ]]; then
        log ERROR "Missing executable in app bundle: $executable"
        return 1
    fi
    
    # Check if executable is actually executable
    if [[ ! -x "$executable" ]]; then
        log ERROR "Executable is not executable: $executable"
        return 1
    fi
    
    # Check for Info.plist
    local info_plist="$app_path/Contents/Info.plist"
    if [[ ! -f "$info_plist" ]]; then
        log WARN "Missing Info.plist: $info_plist"
    fi
    
    log SUCCESS "App bundle validation passed"
    return 0
}

# ============================================================================
# BINARY DETECTION & MANAGEMENT
# ============================================================================

find_app_binary() {
    log INFO "Searching for META Mover binary..."
    
    # Search in order of preference
    for search_path in "${BINARY_SEARCH_PATHS[@]}"; do
        # Expand path to handle spaces and variables
        local expanded_path
        expanded_path=$(eval echo "$search_path")
        
        if [[ -d "$expanded_path" ]]; then
            log SUCCESS "Found binary at: $expanded_path"
            
            # Validate the app bundle
            if check_app_bundle_validity "$expanded_path"; then
                echo "$expanded_path"
                return 0
            else
                log WARN "Invalid app bundle at: $expanded_path"
            fi
        fi
    done
    
    log ERROR "No valid META Mover binary found in search paths:"
    for path in "${BINARY_SEARCH_PATHS[@]}"; do
        log ERROR "  - $(eval echo "$path")"
    done
    
    return 1
}

get_app_version() {
    local app_path="$1"
    local info_plist="$app_path/Contents/Info.plist"
    
    if [[ -f "$info_plist" ]]; then
        # Try multiple version keys
        local version
        version=$(plutil -p "$info_plist" 2>/dev/null | grep -E '"CFBundleShortVersionString"\s*=>' | cut -d'"' -f4 2>/dev/null) ||
        version=$(plutil -p "$info_plist" 2>/dev/null | grep -E '"CFBundleVersion"\s*=>' | cut -d'"' -f4 2>/dev/null) ||
        version="Unknown"
        
        echo "$version"
    else
        echo "Unknown"
    fi
}

get_app_architecture() {
    local app_path="$1"
    local executable="$app_path/Contents/MacOS/META Mover"
    
    if [[ -f "$executable" ]]; then
        local arch
        arch=$(lipo -archs "$executable" 2>/dev/null || echo "Unknown")
        echo "$arch"
    else
        echo "Unknown"
    fi
}

# ============================================================================
# SOURCE EXECUTION MODE
# ============================================================================

run_from_source() {
    log INFO "Attempting to run from source code..."
    
    # Check Node.js availability
    if ! command -v node >/dev/null 2>&1; then
        log ERROR "Node.js not found. Source mode requires Node.js 18+"
        log INFO "Install Node.js from: https://nodejs.org"
        return 1
    fi
    
    local node_version
    node_version=$(node --version | sed 's/v//')
    log INFO "Node.js version: $node_version"
    
    # Validate Node.js version
    if ! version_greater_equal "$node_version" "18.0.0"; then
        log ERROR "Node.js 18.0.0 or later required. Current: $node_version"
        return 1
    fi
    
    # Check for package.json
    if [[ ! -f "package.json" ]]; then
        log ERROR "package.json not found. Cannot run from source"
        return 1
    fi
    
    # Setup production environment
    setup_production_environment
    
    # Install dependencies if needed
    if [[ ! -d "node_modules" ]]; then
        log INFO "Installing dependencies..."
        npm ci || npm install || {
            log ERROR "Failed to install dependencies"
            return 1
        }
        log SUCCESS "Dependencies installed"
    fi
    
    # Build if needed
    if [[ ! -d "dist" ]] || [[ "package.json" -nt "dist" ]]; then
        log INFO "Building production version..."
        npm run build || {
            log ERROR "Production build failed"
            return 1
        }
        log SUCCESS "Production build completed"
    fi
    
    log INFO "Starting application from source..."
    npm start
}

setup_production_environment() {
    log DEBUG "Setting up production environment..."
    
    # Production environment variables
    export NODE_ENV=production
    export ELECTRON_IS_DEV=false
    export ELECTRON_ENABLE_LOGGING=false
    
    # macOS optimizations
    export ELECTRON_ENABLE_GPU=true
    export ELECTRON_ENABLE_METAL=true
    export METAL_DEVICE_WRAPPER_TYPE=1
    
    # Performance settings
    export NODE_OPTIONS="--max-old-space-size=4096"
    
    log DEBUG "Production environment configured"
}

# ============================================================================
# BINARY EXECUTION MODE
# ============================================================================

run_binary() {
    log INFO "Starting binary execution mode..."
    
    local app_path
    app_path=$(find_app_binary)
    
    if [[ -z "$app_path" ]]; then
        log ERROR "No compiled binary found. Available options:"
        log INFO "1. Build binary: ./scripts/compile-build-dist.sh"
        log INFO "2. Run from source: $0 --source"
        return 1
    fi
    
    # Get application metadata
    local app_version arch
    app_version=$(get_app_version "$app_path")
    arch=$(get_app_architecture "$app_path")
    
    log INFO "Application version: $app_version"
    log INFO "Architecture: $arch"
    log INFO "Bundle path: $app_path"
    
    # Launch application
    log INFO "Launching META Mover..."
    
    # Use open command with specific app
    if ! open "$app_path"; then
        log ERROR "Failed to launch application"
        return 1
    fi
    
    # Monitor startup
    monitor_app_startup "META Mover"
}

monitor_app_startup() {
    local app_name="$1"
    local timeout=10
    local count=0
    
    log INFO "Monitoring application startup..."
    
    while [[ $count -lt $timeout ]]; do
        if pgrep -f "$app_name" >/dev/null 2>&1; then
            local pid
            pid=$(pgrep -f "$app_name")
            log SUCCESS "$app_name started successfully (PID: $pid)"
            return 0
        fi
        
        sleep 1
        ((count++))
        
        if [[ $((count % 3)) -eq 0 ]]; then
            log INFO "Still waiting for startup... (${count}s elapsed)"
        fi
    done
    
    log WARN "Application startup monitoring timed out after ${timeout}s"
    log WARN "Application may have started but is not responding to process checks"
    return 1
}

# ============================================================================
# INFORMATION & DIAGNOSTICS
# ============================================================================

show_version() {
    print_header
    
    echo -e "${WHITE}VERSION INFORMATION${NC}"
    echo "═══════════════════════════════════════════════════════════════════════════════"
    
    # Package version
    if [[ -f "package.json" ]]; then
        local pkg_version
        pkg_version=$(grep '"version"' "package.json" | cut -d'"' -f4 2>/dev/null || echo "Unknown")
        echo "📦 Package Version: $pkg_version"
    else
        echo "📦 Package Version: Not available (package.json not found)"
    fi
    
    # Binary information
    local app_path
    if app_path=$(find_app_binary 2>/dev/null); then
        local app_version arch
        app_version=$(get_app_version "$app_path")
        arch=$(get_app_architecture "$app_path")
        
        echo "🚀 Binary Version: $app_version"
        echo "🏗️  Binary Architecture: $arch"
        echo "📍 Binary Location: $app_path"
        
        # Binary size
        if [[ -d "$app_path" ]]; then
            local size
            size=$(du -sh "$app_path" 2>/dev/null | cut -f1 || echo "Unknown")
            echo "📏 Binary Size: $size"
        fi
    else
        echo "🚀 Binary Version: Not built"
        echo "💡 Build binary with: ./scripts/compile-build-dist.sh"
    fi
    
    echo ""
    echo -e "${WHITE}SYSTEM INFORMATION${NC}"
    echo "═══════════════════════════════════════════════════════════════════════════════"
    echo "🖥️  macOS Version: $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
    echo "⚙️  Architecture: $(uname -m)"
    echo "💾 Memory: $(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))GB"
    echo "🖥️  CPU Cores: $(sysctl -n hw.ncpu)"
    
    if command -v node >/dev/null 2>&1; then
        echo "📗 Node.js: $(node --version)"
        echo "📘 NPM: $(npm --version 2>/dev/null || echo 'Not available')"
    else
        echo "📗 Node.js: Not installed"
    fi
    
    echo "📄 Script Version: $SCRIPT_VERSION"
    echo ""
}

show_help() {
    echo -e "${WHITE}$PROJECT_NAME v$SCRIPT_VERSION - macOS Production Runner${NC}"
    echo ""
    echo "USAGE:"
    echo "  $0 [OPTIONS]"
    echo ""
    echo "OPTIONS:"
    echo "  --binary, -b     Run compiled binary (default)"
    echo "  --source, -s     Run from built source code"
    echo "  --app, -a        Run application (alias for --binary)"
    echo "  --version, -v    Show detailed version information"
    echo "  --help, -h       Show this help message"
    echo "  --debug          Enable debug logging"
    echo "  --info           Show system information only"
    echo ""
    echo "EXAMPLES:"
    echo "  $0                    # Run compiled binary (default)"
    echo "  $0 --binary          # Run compiled binary (explicit)"
    echo "  $0 --source          # Run from built source code"
    echo "  $0 --version         # Show version and system info"
    echo "  $0 --debug --source  # Run from source with debug logging"
    echo ""
    echo "NOTES:"
    echo "  • Binary mode requires a compiled application"
    echo "  • Source mode requires Node.js 18+ and dependencies"
    echo "  • Build binary with: ./scripts/compile-build-dist.sh"
    echo ""
}

print_system_info() {
    log INFO "System Information:"
    echo "  • macOS Version: $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
    echo "  • Architecture: $(uname -m)"
    echo "  • Memory: $(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))GB"
    echo "  • CPU Cores: $(sysctl -n hw.ncpu)"
    echo "  • Available Disk: $(df -h . | awk 'NR==2 {print $4}')"
    
    if command -v node >/dev/null 2>&1; then
        echo "  • Node.js: $(node --version)"
        echo "  • NPM: $(npm --version 2>/dev/null || echo 'Not available')"
    else
        echo "  • Node.js: Not installed"
    fi
}

# ============================================================================
# MAIN EXECUTION FLOW
# ============================================================================

main() {
    local run_mode="binary"  # Default to binary
    local show_info=false
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --binary|-b|--app|-a)
                run_mode="binary"
                shift
                ;;
            --source|-s)
                run_mode="source"
                shift
                ;;
            --version|-v)
                show_version
                return 0
                ;;
            --help|-h)
                show_help
                return 0
                ;;
            --debug)
                LOG_LEVEL="DEBUG"
                shift
                ;;
            --info)
                show_info=true
                shift
                ;;
            *)
                log ERROR "Unknown option: $1"
                show_help
                return 1
                ;;
        esac
    done
    
    # Set up signal handlers
    trap cleanup_on_exit EXIT INT TERM
    
    # Print header
    print_header
    
    # Show system info if requested
    if [[ $show_info == true ]]; then
        print_system_info
        return 0
    fi
    
    log INFO "Run mode: $run_mode"
    log INFO "Log file: $LOG_FILE"
    
    # Check system requirements
    check_macos_version || return 1
    
    # Run based on selected mode
    case $run_mode in
        "binary")
            run_binary || {
                log WARN "Binary execution failed. Try --source mode or build binary first"
                log INFO "Build binary with: ./scripts/compile-build-dist.sh"
                return 1
            }
            ;;
        "source")
            run_from_source || {
                log ERROR "Source execution failed"
                return 1
            }
            ;;
        *)
            log ERROR "Invalid run mode: $run_mode"
            return 1
            ;;
    esac
    
    log SUCCESS "Application launched successfully"
}

# Execute main function with all arguments
main "$@"