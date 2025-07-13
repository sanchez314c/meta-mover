#!/bin/bash

####################################################################################
#
# META Mover - Temporary Files Cleanup Utility
#
# Author: @spacewelder314
# Date: 2025-09-11
# Version: 3.0.0
#
# Description: Clean up temporary files, caches, and build artifacts
#
# Usage: ./scripts/temp-cleanup.sh [--aggressive] [--dry-run] [--system]
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

# Cleanup statistics
FILES_REMOVED=0
DIRS_REMOVED=0
BYTES_FREED=0

# Function to log messages
log_message() {
    local level="$1"
    local message="$2"
    
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

# Function to convert bytes to human readable format
bytes_to_human() {
    local bytes=$1
    if [[ $bytes -gt 1073741824 ]]; then
        echo "$(echo "scale=1; $bytes / 1073741824" | bc 2>/dev/null || echo $((bytes / 1073741824)))GB"
    elif [[ $bytes -gt 1048576 ]]; then
        echo "$(echo "scale=1; $bytes / 1048576" | bc 2>/dev/null || echo $((bytes / 1048576)))MB"
    elif [[ $bytes -gt 1024 ]]; then
        echo "$(echo "scale=1; $bytes / 1024" | bc 2>/dev/null || echo $((bytes / 1024)))KB"
    else
        echo "${bytes}B"
    fi
}

# Function to remove file or directory
remove_item() {
    local item="$1"
    local dry_run="$2"
    
    if [[ ! -e "$item" ]]; then
        return
    fi
    
    local size=0
    if [[ -f "$item" ]]; then
        size=$(stat -f%z "$item" 2>/dev/null || stat -c%s "$item" 2>/dev/null || echo 0)
        if [[ "$dry_run" == "true" ]]; then
            echo "  Would remove file: ${item#$PROJECT_ROOT/} ($(bytes_to_human $size))"
        else
            rm -f "$item" && echo "  Removed file: ${item#$PROJECT_ROOT/} ($(bytes_to_human $size))"
            FILES_REMOVED=$((FILES_REMOVED + 1))
        fi
    elif [[ -d "$item" ]]; then
        size=$(du -sb "$item" 2>/dev/null | cut -f1 || echo 0)
        if [[ "$dry_run" == "true" ]]; then
            echo "  Would remove directory: ${item#$PROJECT_ROOT/} ($(bytes_to_human $size))"
        else
            rm -rf "$item" && echo "  Removed directory: ${item#$PROJECT_ROOT/} ($(bytes_to_human $size))"
            DIRS_REMOVED=$((DIRS_REMOVED + 1))
        fi
    fi
    
    BYTES_FREED=$((BYTES_FREED + size))
}

# Function to clean basic temporary files
clean_basic_temp() {
    local dry_run="$1"
    
    log_message "INFO" "Cleaning basic temporary files..."
    
    local temp_patterns=(
        "*.tmp"
        "*.temp"
        "*~"
        "*.bak"
        "*.orig"
        "*.rej"
        "*.swp"
        "*.swo"
        ".#*"
        "#*#"
    )
    
    echo "🗑️ Basic temporary files:"
    local found_any=false
    
    for pattern in "${temp_patterns[@]}"; do
        while IFS= read -r -d '' file; do
            found_any=true
            remove_item "$file" "$dry_run"
        done < <(find "$PROJECT_ROOT" -name "$pattern" -type f -print0 2>/dev/null)
    done
    
    if [[ "$found_any" == "false" ]]; then
        echo "  No basic temporary files found"
    fi
    echo ""
}

# Function to clean system-specific files
clean_system_files() {
    local dry_run="$1"
    
    log_message "INFO" "Cleaning system-specific files..."
    
    echo "💻 System-specific files:"
    local found_any=false
    
    # macOS files
    while IFS= read -r -d '' file; do
        found_any=true
        remove_item "$file" "$dry_run"
    done < <(find "$PROJECT_ROOT" -name ".DS_Store" -type f -print0 2>/dev/null)
    
    while IFS= read -r -d '' file; do
        found_any=true
        remove_item "$file" "$dry_run"
    done < <(find "$PROJECT_ROOT" -name "._*" -type f -print0 2>/dev/null)
    
    # Windows files
    while IFS= read -r -d '' file; do
        found_any=true
        remove_item "$file" "$dry_run"
    done < <(find "$PROJECT_ROOT" -name "Thumbs.db" -type f -print0 2>/dev/null)
    
    while IFS= read -r -d '' file; do
        found_any=true
        remove_item "$file" "$dry_run"
    done < <(find "$PROJECT_ROOT" -name "Desktop.ini" -type f -print0 2>/dev/null)
    
    if [[ "$found_any" == "false" ]]; then
        echo "  No system-specific files found"
    fi
    echo ""
}

# Function to clean IDE/editor files
clean_ide_files() {
    local dry_run="$1"
    
    log_message "INFO" "Cleaning IDE and editor files..."
    
    echo "📝 IDE and editor files:"
    local found_any=false
    
    # VSCode
    if [[ -d "$PROJECT_ROOT/.vscode" ]]; then
        # Keep .vscode but clean temp files inside
        while IFS= read -r -d '' file; do
            found_any=true
            remove_item "$file" "$dry_run"
        done < <(find "$PROJECT_ROOT/.vscode" -name "*.tmp" -o -name "*.log" -type f -print0 2>/dev/null)
    fi
    
    # IntelliJ IDEA
    if [[ -d "$PROJECT_ROOT/.idea" ]]; then
        found_any=true
        remove_item "$PROJECT_ROOT/.idea" "$dry_run"
    fi
    
    # Sublime Text
    while IFS= read -r -d '' file; do
        found_any=true
        remove_item "$file" "$dry_run"
    done < <(find "$PROJECT_ROOT" -name "*.sublime-workspace" -type f -print0 2>/dev/null)
    
    # Vim
    while IFS= read -r -d '' file; do
        found_any=true
        remove_item "$file" "$dry_run"
    done < <(find "$PROJECT_ROOT" -name ".*.swp" -o -name ".*.swo" -type f -print0 2>/dev/null)
    
    if [[ "$found_any" == "false" ]]; then
        echo "  No IDE/editor files found"
    fi
    echo ""
}

# Function to clean logs
clean_logs() {
    local dry_run="$1"
    local aggressive="$2"
    
    log_message "INFO" "Cleaning log files..."
    
    echo "📋 Log files:"
    local found_any=false
    
    # Clean old logs (keep recent ones unless aggressive)
    if [[ "$aggressive" == "true" ]]; then
        # Remove all logs in aggressive mode
        while IFS= read -r -d '' file; do
            found_any=true
            remove_item "$file" "$dry_run"
        done < <(find "$PROJECT_ROOT" -name "*.log" -type f -print0 2>/dev/null)
    else
        # Keep logs from last 7 days
        while IFS= read -r -d '' file; do
            if [[ $(find "$file" -mtime +7 2>/dev/null) ]]; then
                found_any=true
                remove_item "$file" "$dry_run"
            fi
        done < <(find "$PROJECT_ROOT" -name "*.log" -type f -print0 2>/dev/null)
    fi
    
    # Clean npm debug logs
    while IFS= read -r -d '' file; do
        found_any=true
        remove_item "$file" "$dry_run"
    done < <(find "$PROJECT_ROOT" -name "npm-debug.log*" -type f -print0 2>/dev/null)
    
    if [[ "$found_any" == "false" ]]; then
        echo "  No log files found to clean"
    fi
    echo ""
}

# Function to clean node.js specific files
clean_nodejs() {
    local dry_run="$1"
    local aggressive="$2"
    
    log_message "INFO" "Cleaning Node.js specific files..."
    
    echo "📦 Node.js files:"
    local found_any=false
    
    # Clean npm cache in project
    if [[ -d "$PROJECT_ROOT/.npm" ]]; then
        found_any=true
        remove_item "$PROJECT_ROOT/.npm" "$dry_run"
    fi
    
    # Clean yarn cache
    if [[ -d "$PROJECT_ROOT/.yarn/cache" ]]; then
        found_any=true
        remove_item "$PROJECT_ROOT/.yarn/cache" "$dry_run"
    fi
    
    # Clean node_modules cache directories
    while IFS= read -r -d '' dir; do
        found_any=true
        remove_item "$dir" "$dry_run"
    done < <(find "$PROJECT_ROOT" -path "*/node_modules/.cache" -type d -print0 2>/dev/null)
    
    # In aggressive mode, remove node_modules entirely
    if [[ "$aggressive" == "true" ]] && [[ -d "$PROJECT_ROOT/node_modules" ]]; then
        found_any=true
        remove_item "$PROJECT_ROOT/node_modules" "$dry_run"
    fi
    
    # Clean package-lock.json if requested
    if [[ "$aggressive" == "true" ]] && [[ -f "$PROJECT_ROOT/package-lock.json" ]]; then
        found_any=true
        remove_item "$PROJECT_ROOT/package-lock.json" "$dry_run"
    fi
    
    if [[ "$found_any" == "false" ]]; then
        echo "  No Node.js cache files found"
    fi
    echo ""
}

# Function to clean build artifacts
clean_build_artifacts() {
    local dry_run="$1"
    local aggressive="$2"
    
    log_message "INFO" "Cleaning build artifacts..."
    
    echo "🔨 Build artifacts:"
    local found_any=false
    
    # Clean dist directory
    if [[ -d "$PROJECT_ROOT/dist" ]]; then
        found_any=true
        remove_item "$PROJECT_ROOT/dist" "$dry_run"
    fi
    
    # Clean build directory
    if [[ -d "$PROJECT_ROOT/build" ]]; then
        found_any=true
        remove_item "$PROJECT_ROOT/build" "$dry_run"
    fi
    
    # Clean release directory (only in aggressive mode)
    if [[ "$aggressive" == "true" ]] && [[ -d "$PROJECT_ROOT/release" ]]; then
        found_any=true
        remove_item "$PROJECT_ROOT/release" "$dry_run"
    fi
    
    # Clean coverage reports
    if [[ -d "$PROJECT_ROOT/coverage" ]]; then
        found_any=true
        remove_item "$PROJECT_ROOT/coverage" "$dry_run"
    fi
    
    if [[ -d "$PROJECT_ROOT/.nyc_output" ]]; then
        found_any=true
        remove_item "$PROJECT_ROOT/.nyc_output" "$dry_run"
    fi
    
    # Clean webpack stats
    if [[ -f "$PROJECT_ROOT/webpack-stats.json" ]]; then
        found_any=true
        remove_item "$PROJECT_ROOT/webpack-stats.json" "$dry_run"
    fi
    
    if [[ "$found_any" == "false" ]]; then
        echo "  No build artifacts found"
    fi
    echo ""
}

# Function to clean test artifacts
clean_test_artifacts() {
    local dry_run="$1"
    
    log_message "INFO" "Cleaning test artifacts..."
    
    echo "🧪 Test artifacts:"
    local found_any=false
    
    # Clean Jest cache
    if [[ -d "$PROJECT_ROOT/.jest" ]]; then
        found_any=true
        remove_item "$PROJECT_ROOT/.jest" "$dry_run"
    fi
    
    # Clean pytest cache
    while IFS= read -r -d '' dir; do
        found_any=true
        remove_item "$dir" "$dry_run"
    done < <(find "$PROJECT_ROOT" -name ".pytest_cache" -type d -print0 2>/dev/null)
    
    while IFS= read -r -d '' dir; do
        found_any=true
        remove_item "$dir" "$dry_run"
    done < <(find "$PROJECT_ROOT" -name "__pycache__" -type d -print0 2>/dev/null)
    
    # Clean Python compiled files
    while IFS= read -r -d '' file; do
        found_any=true
        remove_item "$file" "$dry_run"
    done < <(find "$PROJECT_ROOT" -name "*.pyc" -type f -print0 2>/dev/null)
    
    if [[ "$found_any" == "false" ]]; then
        echo "  No test artifacts found"
    fi
    echo ""
}

# Function to clean system temp directories (requires elevated permissions)
clean_system_temp() {
    local dry_run="$1"
    
    log_message "INFO" "Cleaning system temporary directories..."
    
    echo "🖥️ System temporary directories:"
    
    # macOS specific temp cleanup
    if [[ "$OSTYPE" == "darwin"* ]]; then
        local temp_dirs=(
            "/tmp"
            "/private/tmp"
            "$HOME/Library/Caches"
            "/Library/Caches"
            "$HOME/.Trash"
        )
        
        for temp_dir in "${temp_dirs[@]}"; do
            if [[ -d "$temp_dir" ]]; then
                local old_files=$(find "$temp_dir" -name "*electron*" -o -name "*META*Mover*" -mtime +1 2>/dev/null)
                if [[ -n "$old_files" ]]; then
                    echo "  Found old files in $temp_dir"
                    if [[ "$dry_run" == "true" ]]; then
                        echo "$old_files" | while read -r file; do
                            echo "    Would remove: $file"
                        done
                    else
                        echo "$old_files" | while read -r file; do
                            sudo rm -rf "$file" 2>/dev/null && echo "    Removed: $file"
                        done
                    fi
                fi
            fi
        done
    fi
    
    # Linux specific temp cleanup
    if [[ "$OSTYPE" == "linux-gnu"* ]]; then
        local temp_dirs=(
            "/tmp"
            "/var/tmp"
            "$HOME/.cache"
        )
        
        for temp_dir in "${temp_dirs[@]}"; do
            if [[ -d "$temp_dir" ]]; then
                local old_files=$(find "$temp_dir" -name "*electron*" -o -name "*meta-mover*" -mtime +1 2>/dev/null)
                if [[ -n "$old_files" ]]; then
                    echo "  Found old files in $temp_dir"
                    if [[ "$dry_run" == "true" ]]; then
                        echo "$old_files" | while read -r file; do
                            echo "    Would remove: $file"
                        done
                    else
                        echo "$old_files" | while read -r file; do
                            sudo rm -rf "$file" 2>/dev/null && echo "    Removed: $file"
                        done
                    fi
                fi
            fi
        done
    fi
    
    echo ""
}

# Function to show cleanup summary
show_summary() {
    local dry_run="$1"
    
    echo "📊 CLEANUP SUMMARY"
    echo "=================="
    
    if [[ "$dry_run" == "true" ]]; then
        echo "DRY RUN RESULTS:"
        echo "  Files that would be removed: $FILES_REMOVED"
        echo "  Directories that would be removed: $DIRS_REMOVED"
        echo "  Space that would be freed: $(bytes_to_human $BYTES_FREED)"
    else
        echo "CLEANUP RESULTS:"
        echo "  Files removed: $FILES_REMOVED"
        echo "  Directories removed: $DIRS_REMOVED"
        echo "  Space freed: $(bytes_to_human $BYTES_FREED)"
    fi
    
    echo ""
    if [[ $BYTES_FREED -gt 0 ]]; then
        log_message "SUCCESS" "Cleanup completed successfully"
    else
        log_message "INFO" "No files needed cleaning"
    fi
}

# Function to show usage
show_usage() {
    echo "META Mover - Temporary Files Cleanup Utility"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --aggressive, -a  Remove more files (node_modules, release/, etc.)"
    echo "  --dry-run, -n     Show what would be removed without actually removing"
    echo "  --system, -s      Also clean system temporary directories (requires sudo)"
    echo "  --help, -h        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0                # Basic cleanup"
    echo "  $0 --dry-run      # Preview what would be cleaned"
    echo "  $0 --aggressive   # More thorough cleanup"
    echo "  $0 --system       # Include system temp directories"
}

# Main execution
main() {
    local aggressive=false
    local dry_run=false
    local system_cleanup=false
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --aggressive|-a)
                aggressive=true
                shift
                ;;
            --dry-run|-n)
                dry_run=true
                shift
                ;;
            --system|-s)
                system_cleanup=true
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
    echo "                            META Mover v3.0 - Temporary Files Cleanup"
    echo "==================================================================================="
    echo ""
    
    if [[ "$dry_run" == "true" ]]; then
        log_message "INFO" "DRY RUN MODE - No files will actually be removed"
    fi
    
    if [[ "$aggressive" == "true" ]]; then
        log_message "WARNING" "AGGRESSIVE MODE - More files will be removed"
    fi
    
    log_message "INFO" "Starting cleanup..."
    log_message "INFO" "Project directory: $PROJECT_ROOT"
    echo ""
    
    # Change to project directory
    cd "$PROJECT_ROOT" || {
        log_message "ERROR" "Failed to change to project directory: $PROJECT_ROOT"
        exit 1
    }
    
    # Run cleanup functions
    clean_basic_temp "$dry_run"
    clean_system_files "$dry_run"
    clean_ide_files "$dry_run"
    clean_logs "$dry_run" "$aggressive"
    clean_nodejs "$dry_run" "$aggressive"
    clean_build_artifacts "$dry_run" "$aggressive"
    clean_test_artifacts "$dry_run"
    
    if [[ "$system_cleanup" == "true" ]]; then
        clean_system_temp "$dry_run"
    fi
    
    show_summary "$dry_run"
    
    if [[ "$dry_run" == "true" ]]; then
        echo "To actually perform the cleanup, run without --dry-run"
    fi
}

# Make script executable on creation
chmod +x "$0" 2>/dev/null || true

# Run main function with all arguments
main "$@"