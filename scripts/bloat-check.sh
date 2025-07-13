#!/bin/bash

####################################################################################
#
# META Mover - Bloat Check Utility
#
# Author: @spacewelder314
# Date: 2025-09-11
# Version: 3.0.0
#
# Description: Analyze build artifacts for bloat and unnecessary files
#
# Usage: ./scripts/bloat-check.sh [--detailed] [--fix] [--report]
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

# Analysis thresholds (in MB)
WARNING_SIZE=100
CRITICAL_SIZE=200
INDIVIDUAL_FILE_WARNING=10

# Report file
REPORT_FILE="$PROJECT_ROOT/logs/bloat-analysis-$(date +%Y%m%d-%H%M%S).json"

# Create logs directory if it doesn't exist
mkdir -p "$PROJECT_ROOT/logs"

# Function to log messages
log_message() {
    local level="$1"
    local message="$2"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
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
        echo "$(( bytes / 1073741824 ))GB"
    elif [[ $bytes -gt 1048576 ]]; then
        echo "$(( bytes / 1048576 ))MB"
    elif [[ $bytes -gt 1024 ]]; then
        echo "$(( bytes / 1024 ))KB"
    else
        echo "${bytes}B"
    fi
}

# Function to get directory size
get_dir_size() {
    local dir="$1"
    if [[ -d "$dir" ]]; then
        du -sb "$dir" 2>/dev/null | cut -f1 || echo 0
    else
        echo 0
    fi
}

# Function to analyze node_modules bloat
analyze_node_modules() {
    log_message "INFO" "Analyzing node_modules..."
    
    if [[ ! -d "$PROJECT_ROOT/node_modules" ]]; then
        log_message "INFO" "node_modules not found - skipping analysis"
        return
    fi
    
    local node_modules_size=$(get_dir_size "$PROJECT_ROOT/node_modules")
    local size_mb=$((node_modules_size / 1048576))
    
    echo "📦 NODE_MODULES ANALYSIS"
    echo "========================"
    echo "Total size: $(bytes_to_human $node_modules_size) (${size_mb}MB)"
    
    if [[ $size_mb -gt $CRITICAL_SIZE ]]; then
        log_message "ERROR" "node_modules size is critically large (${size_mb}MB > ${CRITICAL_SIZE}MB)"
    elif [[ $size_mb -gt $WARNING_SIZE ]]; then
        log_message "WARNING" "node_modules size is large (${size_mb}MB > ${WARNING_SIZE}MB)"
    else
        log_message "SUCCESS" "node_modules size is reasonable"
    fi
    
    # Find largest packages
    echo ""
    echo "🔍 Largest packages (top 10):"
    if command -v npx &> /dev/null && [[ -f "$PROJECT_ROOT/package.json" ]]; then
        cd "$PROJECT_ROOT"
        npx disk-usage --json 2>/dev/null | head -10 || {
            echo "  (Install disk-usage with: npm i -g disk-usage)"
            echo "  Manual analysis:"
            find node_modules -maxdepth 2 -type d -exec du -sh {} \; | sort -hr | head -10
        }
    else
        find "$PROJECT_ROOT/node_modules" -maxdepth 2 -type d -exec du -sh {} \; | sort -hr | head -10
    fi
    
    # Check for common bloat patterns
    echo ""
    echo "🚨 Bloat patterns detected:"
    
    local bloat_count=0
    
    # Check for typescript in production dependencies
    if [[ -f "$PROJECT_ROOT/node_modules/typescript/package.json" ]]; then
        log_message "WARNING" "TypeScript found in node_modules (should be devDependency)"
        bloat_count=$((bloat_count + 1))
    fi
    
    # Check for multiple versions of the same package
    local duplicates=$(find "$PROJECT_ROOT/node_modules" -name "package.json" -exec dirname {} \; | sed 's|.*/node_modules/||' | sort | uniq -c | sort -nr | head -5)
    if [[ $(echo "$duplicates" | head -1 | awk '{print $1}') -gt 1 ]]; then
        log_message "WARNING" "Duplicate packages detected"
        echo "$duplicates"
        bloat_count=$((bloat_count + 1))
    fi
    
    # Check for large individual files
    echo ""
    echo "📄 Large individual files (>$INDIVIDUAL_FILE_WARNING MB):"
    find "$PROJECT_ROOT/node_modules" -type f -size +${INDIVIDUAL_FILE_WARNING}M -exec ls -lh {} \; | awk '{print $5 " " $9}' | head -10
    
    if [[ $bloat_count -eq 0 ]]; then
        log_message "SUCCESS" "No major bloat patterns detected"
    fi
    
    echo ""
}

# Function to analyze build artifacts
analyze_build_artifacts() {
    log_message "INFO" "Analyzing build artifacts..."
    
    echo "🔨 BUILD ARTIFACTS ANALYSIS"
    echo "==========================="
    
    local total_build_size=0
    
    # Analyze dist directory
    if [[ -d "$PROJECT_ROOT/dist" ]]; then
        local dist_size=$(get_dir_size "$PROJECT_ROOT/dist")
        total_build_size=$((total_build_size + dist_size))
        echo "dist/ size: $(bytes_to_human $dist_size)"
        
        # Analyze dist contents
        echo "  Contents:"
        find "$PROJECT_ROOT/dist" -maxdepth 2 -type d -exec du -sh {} \; | sort -hr | head -5 | sed 's/^/    /'
    fi
    
    # Analyze release directory
    if [[ -d "$PROJECT_ROOT/release" ]]; then
        local release_size=$(get_dir_size "$PROJECT_ROOT/release")
        total_build_size=$((total_build_size + release_size))
        echo "release/ size: $(bytes_to_human $release_size)"
        
        # List release contents
        echo "  Contents:"
        ls -lah "$PROJECT_ROOT/release" | tail -n +2 | awk '{print "    " $5 " " $9}'
    fi
    
    echo "Total build artifacts: $(bytes_to_human $total_build_size)"
    
    local build_mb=$((total_build_size / 1048576))
    if [[ $build_mb -gt $CRITICAL_SIZE ]]; then
        log_message "ERROR" "Build artifacts are critically large (${build_mb}MB)"
    elif [[ $build_mb -gt $WARNING_SIZE ]]; then
        log_message "WARNING" "Build artifacts are large (${build_mb}MB)"
    else
        log_message "SUCCESS" "Build artifacts size is reasonable"
    fi
    
    echo ""
}

# Function to analyze temporary files
analyze_temp_files() {
    log_message "INFO" "Analyzing temporary files..."
    
    echo "🗂️ TEMPORARY FILES ANALYSIS"
    echo "==========================="
    
    local temp_patterns=(
        "*.log"
        "*.tmp"
        "*.temp"
        "*~"
        ".DS_Store"
        "Thumbs.db"
        "*.swp"
        "*.swo"
        ".vscode"
        ".idea"
        "*.pyc"
        "__pycache__"
        ".pytest_cache"
        ".coverage"
        "coverage/"
        ".nyc_output"
    )
    
    local temp_files_found=0
    local temp_size=0
    
    for pattern in "${temp_patterns[@]}"; do
        while IFS= read -r -d '' file; do
            if [[ -f "$file" ]]; then
                local file_size=$(stat -f%z "$file" 2>/dev/null || stat -c%s "$file" 2>/dev/null)
                temp_size=$((temp_size + file_size))
                temp_files_found=$((temp_files_found + 1))
                echo "  Found: ${file#$PROJECT_ROOT/} ($(bytes_to_human $file_size))"
            fi
        done < <(find "$PROJECT_ROOT" -name "$pattern" -type f -print0 2>/dev/null)
    done
    
    if [[ $temp_files_found -eq 0 ]]; then
        log_message "SUCCESS" "No temporary files found"
    else
        log_message "WARNING" "Found $temp_files_found temporary files ($(bytes_to_human $temp_size))"
    fi
    
    echo ""
}

# Function to analyze webpack bundle
analyze_webpack_bundle() {
    log_message "INFO" "Analyzing webpack bundles..."
    
    echo "📦 WEBPACK BUNDLE ANALYSIS"
    echo "=========================="
    
    # Look for webpack stats files
    local stats_files=(
        "$PROJECT_ROOT/dist/stats.json"
        "$PROJECT_ROOT/webpack-stats.json"
    )
    
    local stats_found=false
    for stats_file in "${stats_files[@]}"; do
        if [[ -f "$stats_file" ]]; then
            stats_found=true
            echo "Found webpack stats: $stats_file"
            # Basic stats analysis
            if command -v jq &> /dev/null; then
                local assets=$(jq -r '.assets[] | "\(.name) \(.size)"' "$stats_file" 2>/dev/null | head -10)
                echo "Top 10 assets:"
                echo "$assets" | while read -r name size; do
                    echo "  $name: $(bytes_to_human $size)"
                done
            fi
        fi
    done
    
    if [[ "$stats_found" == "false" ]]; then
        echo "No webpack stats found. To generate:"
        echo "  Add --json flag to webpack build in package.json"
        echo "  Or use webpack-bundle-analyzer for detailed analysis"
    fi
    
    # Check for common bundle issues
    echo ""
    echo "Bundle optimization checks:"
    
    # Look for source maps in production
    local sourcemap_count=$(find "$PROJECT_ROOT/dist" -name "*.map" -type f 2>/dev/null | wc -l)
    if [[ $sourcemap_count -gt 0 ]]; then
        log_message "WARNING" "Found $sourcemap_count source maps in dist/ (consider removing for production)"
    else
        log_message "SUCCESS" "No source maps found in production build"
    fi
    
    # Check for development dependencies in bundle
    if [[ -d "$PROJECT_ROOT/dist" ]]; then
        local dev_deps=$(grep -r "webpack-dev-server\|hot-module-replacement" "$PROJECT_ROOT/dist" 2>/dev/null | wc -l)
        if [[ $dev_deps -gt 0 ]]; then
            log_message "WARNING" "Development code detected in production bundle"
        fi
    fi
    
    echo ""
}

# Function to generate recommendations
generate_recommendations() {
    echo "💡 OPTIMIZATION RECOMMENDATIONS"
    echo "==============================="
    
    # Node modules recommendations
    echo "📦 Node Modules:"
    echo "  • Run 'npm audit' to check for security issues"
    echo "  • Use 'npm ci' instead of 'npm install' in production"
    echo "  • Consider using 'npm prune --production' to remove dev dependencies"
    echo "  • Use .npmrc with 'production=true' for production builds"
    
    # Build optimization recommendations
    echo ""
    echo "🔨 Build Optimization:"
    echo "  • Enable webpack tree shaking for unused code elimination"
    echo "  • Use webpack-bundle-analyzer to identify large dependencies"
    echo "  • Consider code splitting for large applications"
    echo "  • Compress assets with gzip/brotli compression"
    echo "  • Remove source maps from production builds"
    
    # Electron-specific recommendations
    echo ""
    echo "⚡ Electron Optimization:"
    echo "  • Use electron-builder's compression options"
    echo "  • Exclude unnecessary files in build.files configuration"
    echo "  • Consider using asar archives for faster loading"
    echo "  • Remove dev dependencies from final package"
    
    # General recommendations
    echo ""
    echo "🔧 General:"
    echo "  • Run bloat check before releases"
    echo "  • Set up automated size monitoring in CI/CD"
    echo "  • Use .gitignore to prevent committing build artifacts"
    echo "  • Regular dependency updates to get smaller/faster versions"
    
    echo ""
}

# Function to fix common bloat issues
fix_bloat_issues() {
    log_message "INFO" "Fixing common bloat issues..."
    
    echo "🔧 FIXING BLOAT ISSUES"
    echo "======================"
    
    local fixes_applied=0
    
    # Remove temporary files
    echo "Removing temporary files..."
    local temp_patterns=(
        "*.log"
        "*.tmp"
        "*~"
        ".DS_Store"
        "Thumbs.db"
        "*.swp"
        "*.swo"
    )
    
    for pattern in "${temp_patterns[@]}"; do
        while IFS= read -r -d '' file; do
            if [[ -f "$file" ]]; then
                rm -f "$file"
                echo "  Removed: ${file#$PROJECT_ROOT/}"
                fixes_applied=$((fixes_applied + 1))
            fi
        done < <(find "$PROJECT_ROOT" -name "$pattern" -type f -print0 2>/dev/null)
    done
    
    # Clean node_modules cache
    if [[ -d "$PROJECT_ROOT/node_modules/.cache" ]]; then
        echo "Cleaning node_modules cache..."
        rm -rf "$PROJECT_ROOT/node_modules/.cache"
        fixes_applied=$((fixes_applied + 1))
    fi
    
    # Remove source maps from dist
    if [[ -d "$PROJECT_ROOT/dist" ]]; then
        local sourcemaps=$(find "$PROJECT_ROOT/dist" -name "*.map" -type f)
        if [[ -n "$sourcemaps" ]]; then
            echo "Removing source maps from dist..."
            echo "$sourcemaps" | xargs rm -f
            fixes_applied=$((fixes_applied + 1))
        fi
    fi
    
    if [[ $fixes_applied -eq 0 ]]; then
        log_message "INFO" "No automatic fixes were needed"
    else
        log_message "SUCCESS" "Applied $fixes_applied fixes"
    fi
    
    echo ""
}

# Function to generate JSON report
generate_json_report() {
    log_message "INFO" "Generating JSON report..."
    
    local node_modules_size=$(get_dir_size "$PROJECT_ROOT/node_modules")
    local dist_size=$(get_dir_size "$PROJECT_ROOT/dist")
    local release_size=$(get_dir_size "$PROJECT_ROOT/release")
    local total_size=$((node_modules_size + dist_size + release_size))
    
    cat > "$REPORT_FILE" << EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "project": "META Mover v3.0",
  "analysis": {
    "node_modules": {
      "size_bytes": $node_modules_size,
      "size_human": "$(bytes_to_human $node_modules_size)"
    },
    "dist": {
      "size_bytes": $dist_size,
      "size_human": "$(bytes_to_human $dist_size)"
    },
    "release": {
      "size_bytes": $release_size,
      "size_human": "$(bytes_to_human $release_size)"
    },
    "total_size": {
      "size_bytes": $total_size,
      "size_human": "$(bytes_to_human $total_size)"
    }
  },
  "thresholds": {
    "warning_mb": $WARNING_SIZE,
    "critical_mb": $CRITICAL_SIZE
  },
  "recommendations": [
    "Run npm audit for security issues",
    "Use webpack-bundle-analyzer for detailed analysis",
    "Remove source maps from production builds",
    "Consider code splitting for large bundles"
  ]
}
EOF
    
    log_message "SUCCESS" "Report saved to: $REPORT_FILE"
}

# Function to show usage
show_usage() {
    echo "META Mover - Bloat Check Utility"
    echo ""
    echo "Usage: $0 [OPTIONS]"
    echo ""
    echo "Options:"
    echo "  --detailed, -d    Show detailed analysis"
    echo "  --fix, -f         Automatically fix common bloat issues"
    echo "  --report, -r      Generate JSON report"
    echo "  --help, -h        Show this help message"
    echo ""
    echo "Examples:"
    echo "  $0              # Basic bloat analysis"
    echo "  $0 --detailed   # Detailed analysis with recommendations"
    echo "  $0 --fix        # Fix common issues automatically"
    echo "  $0 --report     # Generate JSON report"
}

# Main execution
main() {
    local detailed=false
    local fix_issues=false
    local generate_report=false
    
    # Parse command line arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --detailed|-d)
                detailed=true
                shift
                ;;
            --fix|-f)
                fix_issues=true
                shift
                ;;
            --report|-r)
                generate_report=true
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
    echo "                            META Mover v3.0 - Bloat Analysis"
    echo "==================================================================================="
    echo ""
    
    log_message "INFO" "Starting bloat analysis..."
    log_message "INFO" "Project directory: $PROJECT_ROOT"
    
    # Change to project directory
    cd "$PROJECT_ROOT" || {
        log_message "ERROR" "Failed to change to project directory: $PROJECT_ROOT"
        exit 1
    }
    
    # Run analyses
    analyze_node_modules
    analyze_build_artifacts
    analyze_temp_files
    
    if [[ "$detailed" == "true" ]]; then
        analyze_webpack_bundle
        generate_recommendations
    fi
    
    if [[ "$fix_issues" == "true" ]]; then
        fix_bloat_issues
    fi
    
    if [[ "$generate_report" == "true" ]]; then
        generate_json_report
    fi
    
    echo "==================================================================================="
    log_message "SUCCESS" "Bloat analysis completed"
}

# Run main function with all arguments
main "$@"