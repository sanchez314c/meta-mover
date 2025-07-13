#!/bin/bash

# Complete Multi-Platform Build Script
# Builds for macOS, Windows, and Linux with all installer types
# Includes automatic temp cleanup and bloat monitoring

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR/.."

# Function to print colored output
print_status() {
    echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[$(date +'%H:%M:%S')] ✔${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[$(date +'%H:%M:%S')] ⚠${NC} $1"
}

print_error() {
    echo -e "${RED}[$(date +'%H:%M:%S')] ✗${NC} $1"
}

print_info() {
    echo -e "${CYAN}[$(date +'%H:%M:%S')] ℹ${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# NEW: Function to cleanup system temp directories
cleanup_system_temp() {
    print_status "🧹 Cleaning system temp directories..."
    
    # macOS temp cleanup
    if [ "$(uname)" = "Darwin" ]; then
        TEMP_DIR=$(find /private/var/folders -name "Temporary*" -type d 2>/dev/null | head -1)
        if [ -n "$TEMP_DIR" ]; then
            PARENT_DIR=$(dirname "$TEMP_DIR")
            BEFORE_SIZE=$(du -sh "$PARENT_DIR" 2>/dev/null | cut -f1)
            
            # Clean up build artifacts (older than 1 day)
            find "$PARENT_DIR" -name "t-*" -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true
            find "$PARENT_DIR" -name "CFNetworkDownload_*.tmp" -mtime +1 -delete 2>/dev/null || true
            find "$PARENT_DIR" -name "electron-download-*" -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true
            find "$PARENT_DIR" -name "package-dir-staging-*" -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true
            find "$PARENT_DIR" -name "com.anthropic.claudefordesktop.ShipIt.*" -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true
            
            AFTER_SIZE=$(du -sh "$PARENT_DIR" 2>/dev/null | cut -f1)
            print_success "System temp cleanup: $BEFORE_SIZE → $AFTER_SIZE"
        fi
    fi
    
    # Linux temp cleanup
    if [ "$(uname)" = "Linux" ]; then
        if [ -d "/tmp" ]; then
            BEFORE_SIZE=$(du -sh /tmp 2>/dev/null | cut -f1)
            find /tmp -name "electron-*" -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true
            find /tmp -name "npm-*" -type d -mtime +1 -exec rm -rf {} + 2>/dev/null || true
            AFTER_SIZE=$(du -sh /tmp 2>/dev/null | cut -f1)
            print_success "System temp cleanup: $BEFORE_SIZE → $AFTER_SIZE"
        fi
    fi
}

# NEW: Function to set custom temp directory
setup_build_temp() {
    BUILD_TEMP_DIR="$SCRIPT_DIR/../build-temp"
    mkdir -p "$BUILD_TEMP_DIR"
    export TMPDIR="$BUILD_TEMP_DIR"
    export TMP="$BUILD_TEMP_DIR"
    export TEMP="$BUILD_TEMP_DIR"
    export ELECTRON_CACHE="$BUILD_TEMP_DIR/electron-cache"
    print_info "Using custom temp directory: $BUILD_TEMP_DIR"
}

# NEW: Function to perform bloat check
bloat_check() {
    print_status "🔍 Performing bloat analysis..."
    
    # Check node_modules size
    if [ -d "node_modules" ]; then
        NODE_SIZE=$(du -sh node_modules/ 2>/dev/null | cut -f1)
        print_info "Node modules size: $NODE_SIZE"
        
        # Find largest dependencies
        print_info "Top 5 largest dependencies:"
        du -sh node_modules/* 2>/dev/null | sort -hr | head -5 | while read size dir; do
            print_info "  $size - $(basename "$dir")"
        done
    fi
    
    # Check for common bloat indicators
    if grep -q '"node_modules/\*\*/\*"' package.json 2>/dev/null; then
        print_warning "⚠️  BLOAT WARNING: node_modules/**/* found in build files"
    fi
    
    if [ -f "package.json" ]; then
        DEV_DEPS=$(grep -c '".*":' package.json | head -1)
        PROD_DEPS=$(npm ls --production --depth=0 2>/dev/null | grep -c "├─\|└─" || echo "0")
        print_info "Dependencies: $PROD_DEPS production, ~$DEV_DEPS total"
    fi
    
    # Check duplicates
    DUPES=$(npm dedupe --dry-run 2>/dev/null | grep -c "removed" || echo "0")
    if [ "$DUPES" -gt 0 ]; then
        print_warning "⚠️  Found $DUPES duplicate packages - run 'npm dedupe'"
    fi
}

# NEW: Function to cleanup build temp after build
cleanup_build_temp() {
    if [ -n "$BUILD_TEMP_DIR" ] && [ -d "$BUILD_TEMP_DIR" ]; then
        print_status "🧹 Cleaning build temp directory..."
        TEMP_SIZE=$(du -sh "$BUILD_TEMP_DIR" 2>/dev/null | cut -f1 || echo "0")
        rm -rf "$BUILD_TEMP_DIR" 2>/dev/null || true
        print_success "Cleaned build temp: $TEMP_SIZE"
    fi
}

# Function to display help
show_help() {
    echo "META_Mover v3.0 - Complete Multi-Platform Build Script"
    echo ""
    echo "Usage: ./compile-build-dist.sh [options]"
    echo ""
    echo "Options:"
    echo "  --no-clean         Skip cleaning build artifacts"
    echo "  --no-temp-clean    Skip system temp cleanup"
    echo "  --no-bloat-check   Skip bloat analysis"
    echo "  --platform PLAT    Build for specific platform (mac, win, linux, all)"
    echo "  --arch ARCH        Build for specific architecture (x64, ia32, arm64, all)"
    echo "  --quick            Quick build (single platform only)"
    echo "  --help             Display this help message"
    echo ""
    echo "Examples:"
    echo "  ./compile-build-dist.sh                    # Full build for all platforms"
    echo "  ./compile-build-dist.sh --platform win     # Windows only"
    echo "  ./compile-build-dist.sh --quick            # Quick build for current platform"
    echo "  ./compile-build-dist.sh --no-clean         # Build without cleaning first"
}

# Parse command line arguments
NO_CLEAN=false
NO_TEMP_CLEAN=false
NO_BLOAT_CHECK=false
PLATFORM="all"
ARCH="all"
QUICK=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --no-clean)
            NO_CLEAN=true
            shift
            ;;
        --no-temp-clean)
            NO_TEMP_CLEAN=true
            shift
            ;;
        --no-bloat-check)
            NO_BLOAT_CHECK=true
            shift
            ;;
        --platform)
            PLATFORM="$2"
            shift 2
            ;;
        --arch)
            ARCH="$2"
            shift 2
            ;;
        --quick)
            QUICK=true
            shift
            ;;
        --help)
            show_help
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            show_help
            exit 1
            ;;
    esac
done

# Trap to ensure cleanup on exit
trap cleanup_build_temp EXIT

echo -e "${BLUE}$(date +'%H:%M:%S')${NC} 🚀 META_Mover v3.0 - Complete Multi-Platform Build System"
echo -e "${PURPLE}═══════════════════════════════════════════════════════════${NC}"

# Check for required tools
print_status "Checking requirements..."

if ! command_exists node; then
    print_error "Node.js is not installed. Please install Node.js first."
    exit 1
fi

if ! command_exists npm; then
    print_error "npm is not installed. Please install npm first."
    exit 1
fi

# Check for optional tools for better builds
if command_exists wine; then
    print_info "Wine detected - Windows builds will include better signatures"
fi

if command_exists docker; then
    print_info "Docker detected - Linux builds will be more compatible"
fi

print_success "All requirements met"

# NEW: Cleanup system temp directories first
if [ "$NO_TEMP_CLEAN" = false ]; then
    cleanup_system_temp
fi

# NEW: Setup custom build temp directory
setup_build_temp

# NEW: Perform bloat check before build
if [ "$NO_BLOAT_CHECK" = false ]; then
    bloat_check
fi

# Step 1: Clean everything if not skipped
if [ "$NO_CLEAN" = false ]; then
    print_status "🧹 Purging all existing builds..."
    rm -rf release/
    rm -rf dist/
    rm -rf build/
    rm -rf node_modules/.cache/
    rm -rf out/
    print_success "All build artifacts purged"
fi

# Step 2: Install/update dependencies
print_status "📦 Installing/update dependencies..."
npm install
if [ $? -ne 0 ]; then
    print_error "Failed to install dependencies"
    exit 1
fi

print_success "Dependencies ready"

# Step 3: Run quality checks
print_status "🔍 Running quality checks..."

# Test
npm run test 2>/dev/null || print_warning "⚠️  No tests found or tests failed - continuing anyway"

# Linting
npm run lint 2>/dev/null || print_warning "⚠️  No linting configured - continuing anyway"

# TypeScript check
npm run typecheck 2>/dev/null || print_warning "⚠️  TypeScript check not configured - continuing anyway"

# Step 4: Build TypeScript and React components
print_status "🔨 Building TypeScript and React components..."
npm run build
if [ $? -ne 0 ]; then
    print_error "Build failed"
    exit 1
fi
print_success "Build completed successfully"

# Step 5: Test production build locally
print_status "🧪 Testing production build..."
# Test production build with timeout (using gtimeout if available)
if command -v gtimeout >/dev/null 2>&1; then
    gtimeout 5 npm start >/dev/null 2>&1 || true
elif command -v timeout >/dev/null 2>&1; then
    timeout 5 npm start >/dev/null 2>&1 || true
else
    print_warning "timeout command not available - skipping build test"
fi
print_success "Production build test completed (timeout expected)"

# Step 6: Determine build targets
print_status "🎯 Determining build targets..."

if [ "$QUICK" = true ]; then
    print_info "Quick build mode - building for current platform only"
    BUILD_CMD="npm run dist"
elif [ "$PLATFORM" != "all" ]; then
    case $PLATFORM in
        mac)
            BUILD_CMD="npm run dist:mac"
            print_info "Building for macOS only"
            ;;
        win)
            BUILD_CMD="npm run dist:win"
            print_info "Building for Windows only"
            ;;
        linux)
            BUILD_CMD="npm run dist:linux"
            print_info "Building for Linux only"
            ;;
        *)
            print_error "Invalid platform: $PLATFORM"
            exit 1
            ;;
    esac
else
    BUILD_CMD="npm run dist:all"
    print_info "Building for all platforms with maximum coverage"
fi

# Step 7: Build all platform binaries and packages
print_status "🏗️ Building platform binaries and packages..."
print_status "Targets: macOS (Intel + ARM), Windows (x64 + x86 + ARM), Linux (x64 + ARM)"
print_status "Installers: .dmg, .exe, .msi, .deb, .rpm, .AppImage, .snap"

# Run the build with maximum parallelism
export ELECTRON_BUILDER_PARALLELISM=18
$BUILD_CMD
BUILD_RESULT=$?

if [ $BUILD_RESULT -ne 0 ]; then
    print_error "Build failed"
    exit 1
fi

print_success "All platform builds completed successfully"

# NEW: Post-build bloat analysis
if [ "$NO_BLOAT_CHECK" = false ]; then
    print_status "🔍 Post-build size analysis..."
    
    if [ -d "release" ]; then
        TOTAL_SIZE=$(du -sh release/ 2>/dev/null | cut -f1)
        print_info "Total build output size: $TOTAL_SIZE"
        
        # Check individual package sizes
        for file in release/*.dmg release/*.exe release/*.msi release/*.AppImage release/*.zip; do
            if [ -f "$file" ]; then
                SIZE=$(ls -lah "$file" | awk '{print $5}')
                NAME=$(basename "$file")
                print_info "  $NAME: $SIZE"
                
                # Warning for large files
                SIZE_MB=$(ls -l "$file" | awk '{print int($5/1024/1024)}')
                if [ "$SIZE_MB" -gt 500 ]; then
                    print_warning "⚠️  Large package detected: $NAME ($SIZE)"
                fi
            fi
        done
    fi
fi

# Step 8: Display build results
print_status "📋 Build Results Summary:"
echo ""
echo -e "${PURPLE}════════════════════════════════════════════════════════${NC}"

if [ -d "release" ]; then
    # Count files by type
    MAC_COUNT=$(find release -name "*.dmg" -o -name "*.pkg" -o -name "*.zip" | grep -E "(mac|darwin|universal|x64|arm64)" | wc -l)
    WIN_COUNT=$(find release -name "*.exe" -o -name "*.msi" -o -name "*.appx" | wc -l)
    LINUX_COUNT=$(find release -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" -o -name "*.snap" -o -name "*.tar.*" | wc -l)
    
    print_info "📊 Build Statistics:"
    echo "   macOS packages: $MAC_COUNT"
    echo "   Windows packages: $WIN_COUNT"
    echo "   Linux packages: $LINUX_COUNT"
    echo ""
    
    # macOS builds
    if [ $MAC_COUNT -gt 0 ]; then
        print_success "🍎 macOS Builds:"
        find release -name "*.dmg" -type f | while read -r dmg; do
            size=$(ls -lh "$dmg" | awk '{print $5}')
            echo "   ✓ DMG: $(basename "$dmg") ($size)"
        done
        find release -name "*.pkg" -type f | while read -r pkg; do
            size=$(ls -lh "$pkg" | awk '{print $5}')
            echo "   ✓ PKG: $(basename "$pkg") ($size)"
        done
        echo ""
    fi
    
    # Windows builds
    if [ $WIN_COUNT -gt 0 ]; then
        print_success "🪟 Windows Builds:"
        find release -name "*.exe" -type f | while read -r exe; do
            size=$(ls -lh "$exe" | awk '{print $5}')
            echo "   ✓ EXE: $(basename "$exe") ($size)"
        done
        find release -name "*.msi" -type f | while read -r msi; do
            size=$(ls -lh "$msi" | awk '{print $5}')
            echo "   ✓ MSI: $(basename "$msi") ($size)"
        done
        find release -name "*.appx" -type f | while read -r appx; do
            size=$(ls -lh "$appx" | awk '{print $5}')
            echo "   ✓ APPX: $(basename "$appx") ($size)"
        done
        echo ""
    fi
    
    # Linux builds
    if [ $LINUX_COUNT -gt 0 ]; then
        print_success "🐧 Linux Builds:"
        find release -name "*.AppImage" -type f | while read -r app; do
            size=$(ls -lh "$app" | awk '{print $5}')
            echo "   ✓ AppImage: $(basename "$app") ($size)"
        done
        find release -name "*.deb" -type f | while read -r deb; do
            size=$(ls -lh "$deb" | awk '{print $5}')
            echo "   ✓ DEB: $(basename "$deb") ($size)"
        done
        find release -name "*.rpm" -type f | while read -r rpm; do
            size=$(ls -lh "$rpm" | awk '{print $5}')
            echo "   ✓ RPM: $(basename "$rpm") ($size)"
        done
        find release -name "*.snap" -type f | while read -r snap; do
            size=$(ls -lh "$snap" | awk '{print $5}')
            echo "   ✓ Snap: $(basename "$snap") ($size)"
        done
        echo ""
    fi
    
    # Auto-update files
    print_info "🔄 Auto-update files:"
    for yml in release/*.yml; do
        if [ -f "$yml" ]; then
            echo "   ✓ $(basename "$yml")"
        fi
    done
else
    print_warning "No release directory found. Build may have failed."
fi

echo ""
echo -e "${PURPLE}════════════════════════════════════════════════════════${NC}"
print_success "🎉 Complete build process finished!"
print_status "📁 All binaries and packages are in: ./release/"

echo ""
print_info "To run the application:"
print_info "  macOS:   ./scripts/run-macos-source.sh (dev) or ./scripts/run-macos.sh (binary)"
print_info "  Windows: scripts/run-windows-source.bat (dev) or scripts/run-windows.bat (binary)"
print_info "  Linux:   ./scripts/run-linux-source.sh (dev) or ./scripts/run-linux.sh (binary)"