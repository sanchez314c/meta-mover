#!/bin/bash

# META Mover v3.0 - macOS Source Development Runner
# Professional development script with comprehensive environment setup
# Supports Metal GPU acceleration, advanced logging, and system requirements validation

set -euo pipefail

# ============================================================================
# CONFIGURATION & CONSTANTS
# ============================================================================

readonly SCRIPT_NAME="run-macos-source.sh"
readonly SCRIPT_VERSION="3.0.0"
readonly PROJECT_NAME="META Mover"
readonly MIN_MACOS_VERSION="12.0"
readonly MIN_NODE_VERSION="18.0.0"
readonly MIN_MEMORY_GB=8

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
readonly LOG_FILE="${LOG_DIR}/macos-source-$(date +%Y%m%d_%H%M%S).log"

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
    echo "║                          META Mover v3.0 - Development                      ║"
    echo "║                              macOS Source Runner                            ║"
    echo "╚══════════════════════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    log INFO "Starting $SCRIPT_NAME v$SCRIPT_VERSION"
}

cleanup_on_exit() {
    log INFO "Cleaning up development environment..."
    
    # Kill any remaining processes
    pkill -f "META Mover" 2>/dev/null || true
    pkill -f "electron" 2>/dev/null || true
    pkill -f "webpack" 2>/dev/null || true
    
    # Clean temporary files
    rm -rf .tmp-build 2>/dev/null || true
    
    log SUCCESS "Cleanup completed"
}

# ============================================================================
# SYSTEM REQUIREMENTS VALIDATION
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

check_node_version() {
    if ! command -v node >/dev/null 2>&1; then
        log ERROR "Node.js is not installed. Please install Node.js $MIN_NODE_VERSION or later"
        return 1
    fi
    
    local current_version
    current_version=$(node --version | sed 's/v//')
    
    log INFO "Checking Node.js version: $current_version (minimum: $MIN_NODE_VERSION)"
    
    if ! version_greater_equal "$current_version" "$MIN_NODE_VERSION"; then
        log ERROR "Node.js $MIN_NODE_VERSION or later is required. Current: $current_version"
        return 1
    fi
    
    log SUCCESS "Node.js version check passed"
}

check_system_resources() {
    local total_memory_gb
    total_memory_gb=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
    
    log INFO "Checking system memory: ${total_memory_gb}GB (minimum: ${MIN_MEMORY_GB}GB)"
    
    if [[ $total_memory_gb -lt $MIN_MEMORY_GB ]]; then
        log WARN "System has only ${total_memory_gb}GB memory. Recommended: ${MIN_MEMORY_GB}GB+"
        log WARN "Performance may be degraded with limited memory"
    else
        log SUCCESS "System memory check passed"
    fi
    
    # Check available disk space
    local available_space_gb
    available_space_gb=$(df -g . | awk 'NR==2 {print $4}')
    
    if [[ $available_space_gb -lt 10 ]]; then
        log WARN "Low disk space: ${available_space_gb}GB available. Consider freeing up space"
    fi
}

check_development_tools() {
    log INFO "Validating development tools..."
    
    local missing_tools=()
    
    command -v npm >/dev/null 2>&1 || missing_tools+=("npm")
    command -v git >/dev/null 2>&1 || missing_tools+=("git")
    command -v python3 >/dev/null 2>&1 || missing_tools+=("python3")
    
    if [[ ${#missing_tools[@]} -gt 0 ]]; then
        log ERROR "Missing required tools: ${missing_tools[*]}"
        log ERROR "Please install missing tools and try again"
        return 1
    fi
    
    log SUCCESS "Development tools validation passed"
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

# ============================================================================
# ENVIRONMENT SETUP
# ============================================================================

setup_development_environment() {
    log INFO "Setting up macOS development environment..."
    
    # Enable Metal GPU acceleration for Electron
    export ELECTRON_ENABLE_GPU=true
    export ELECTRON_ENABLE_METAL=true
    export ELECTRON_DISABLE_SECURITY_WARNINGS=false
    
    # Development optimization flags
    export NODE_ENV=development
    export ELECTRON_IS_DEV=true
    export ELECTRON_ENABLE_LOGGING=true
    export ELECTRON_ENABLE_STACK_DUMPING=true
    
    # Memory optimization for development
    export NODE_OPTIONS="--max-old-space-size=8192"
    export UV_THREADPOOL_SIZE=8
    
    # macOS specific optimizations
    export DYLD_LIBRARY_PATH="/usr/local/lib:$DYLD_LIBRARY_PATH"
    export LANG=en_US.UTF-8
    export LC_ALL=en_US.UTF-8
    
    # Webpack development server settings
    export WEBPACK_DEV_SERVER_HOST=localhost
    export WEBPACK_DEV_SERVER_PORT=3000
    export WEBPACK_HOT_RELOAD=true
    
    log SUCCESS "Development environment configured"
}

install_dependencies() {
    log INFO "Installing/updating dependencies..."
    
    if [[ ! -f package.json ]]; then
        log ERROR "package.json not found. Are you in the correct directory?"
        return 1
    fi
    
    # Clear npm cache if needed
    if [[ "$1" == "--clean" ]]; then
        log INFO "Clearing npm cache..."
        npm cache clean --force
        rm -rf node_modules package-lock.json
    fi
    
    # Install dependencies with timing
    local start_time=$(date +%s)
    
    npm install --verbose --no-fund --no-audit || {
        log ERROR "Failed to install dependencies"
        return 1
    }
    
    local end_time=$(date +%s)
    local duration=$((end_time - start_time))
    
    log SUCCESS "Dependencies installed in ${duration}s"
}

# ============================================================================
# BUILD PROCESS MANAGEMENT
# ============================================================================

run_development_build() {
    log INFO "Starting development build process..."
    
    # Create temporary build directory
    mkdir -p .tmp-build
    
    # Run linting first
    if npm run lint:check >/dev/null 2>&1; then
        log INFO "Running ESLint validation..."
        npm run lint:check || {
            log WARN "ESLint warnings detected. Continuing anyway..."
        }
    fi
    
    # Run TypeScript compilation check
    if npm run type:check >/dev/null 2>&1; then
        log INFO "Running TypeScript validation..."
        npm run type:check || {
            log WARN "TypeScript warnings detected. Continuing anyway..."
        }
    fi
    
    # Start the development server
    log INFO "Starting Electron in development mode..."
    log INFO "Application will open in a new window"
    log INFO "Press Ctrl+C to stop the development server"
    
    # Run with proper error handling
    npm run dev || {
        log ERROR "Development server failed to start"
        return 1
    }
}

# ============================================================================
# MONITORING & DIAGNOSTICS
# ============================================================================

monitor_process() {
    local process_name="$1"
    local timeout=${2:-30}
    local count=0
    
    log INFO "Monitoring $process_name startup (timeout: ${timeout}s)..."
    
    while [[ $count -lt $timeout ]]; do
        if pgrep -f "$process_name" >/dev/null 2>&1; then
            log SUCCESS "$process_name is running (PID: $(pgrep -f "$process_name"))"
            return 0
        fi
        
        sleep 1
        ((count++))
        
        if [[ $((count % 5)) -eq 0 ]]; then
            log INFO "Still waiting for $process_name... (${count}s elapsed)"
        fi
    done
    
    log WARN "$process_name did not start within ${timeout}s"
    return 1
}

print_system_info() {
    log INFO "System Information:"
    echo "  • macOS Version: $(sw_vers -productVersion) ($(sw_vers -buildVersion))"
    echo "  • Architecture: $(uname -m)"
    echo "  • Node.js: $(node --version)"
    echo "  • NPM: $(npm --version)"
    echo "  • Memory: $(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))GB"
    echo "  • CPU Cores: $(sysctl -n hw.ncpu)"
    echo "  • Available Disk: $(df -h . | awk 'NR==2 {print $4}')"
}

# ============================================================================
# COMMAND LINE ARGUMENT PROCESSING
# ============================================================================

show_help() {
    echo -e "${WHITE}$PROJECT_NAME v$SCRIPT_VERSION - macOS Development Runner${NC}"
    echo ""
    echo "USAGE:"
    echo "  $0 [OPTIONS]"
    echo ""
    echo "OPTIONS:"
    echo "  --clean          Clean install (remove node_modules and cache)"
    echo "  --skip-deps      Skip dependency installation"
    echo "  --skip-checks    Skip system requirement checks"
    echo "  --debug          Enable debug logging"
    echo "  --info           Show system information"
    echo "  --help           Show this help message"
    echo ""
    echo "EXAMPLES:"
    echo "  $0                    # Standard development run"
    echo "  $0 --clean           # Clean install and run"
    echo "  $0 --debug           # Run with debug logging"
    echo "  $0 --skip-deps       # Skip dependency installation"
    echo ""
    echo "ENVIRONMENT VARIABLES:"
    echo "  LOG_LEVEL            Set logging level (DEBUG, INFO, WARN, ERROR)"
    echo "  NODE_ENV             Node.js environment (defaults to development)"
    echo ""
}

# ============================================================================
# MAIN EXECUTION FLOW
# ============================================================================

main() {
    local clean_install=false
    local skip_deps=false
    local skip_checks=false
    local show_info=false
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --clean)
                clean_install=true
                shift
                ;;
            --skip-deps)
                skip_deps=true
                shift
                ;;
            --skip-checks)
                skip_checks=true
                shift
                ;;
            --debug)
                LOG_LEVEL="DEBUG"
                shift
                ;;
            --info)
                show_info=true
                shift
                ;;
            --help)
                show_help
                return 0
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
    
    # System validation (unless skipped)
    if [[ $skip_checks == false ]]; then
        check_macos_version || return 1
        check_node_version || return 1
        check_system_resources
        check_development_tools || return 1
    fi
    
    # Environment setup
    setup_development_environment
    
    # Dependency management (unless skipped)
    if [[ $skip_deps == false ]]; then
        if [[ $clean_install == true ]]; then
            install_dependencies --clean || return 1
        else
            install_dependencies || return 1
        fi
    fi
    
    # Start development build
    run_development_build || return 1
    
    log SUCCESS "Development session completed successfully"
}

# Execute main function with all arguments
main "$@"