#!/bin/bash

####################################################################################
#
# Generate Placeholder Icons for META Mover
#
# Author: Build System
# Date: 2025-09-12
# Version: 1.0.0
#
# Description: Generate basic placeholder icons for development builds
#
####################################################################################

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ICONS_DIR="${SCRIPT_DIR}/icons"

log_message() {
    local level="$1"
    local message="$2"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    case "$level" in
        "ERROR")
            echo -e "${RED}[ERROR]${NC} $message" >&2
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

check_imagemagick() {
    if command -v magick >/dev/null 2>&1; then
        MAGICK_CMD="magick"
        return 0
    elif command -v convert >/dev/null 2>&1; then
        MAGICK_CMD="convert"
        return 0
    else
        return 1
    fi
}

create_placeholder_png() {
    local size="$1"
    local output_file="$2"
    
    if check_imagemagick; then
        log_message "INFO" "Creating ${size}x${size} PNG placeholder: $output_file"
        
        # Create a simple placeholder with META text
        $MAGICK_CMD -size "${size}x${size}" xc:"#2563EB" \
            -gravity center \
            -fill white \
            -font Arial-Bold \
            -pointsize $((size / 8)) \
            -annotate +0+$((size / -16)) "META" \
            -pointsize $((size / 12)) \
            -annotate +0+$((size / 8)) "Mover" \
            "$output_file" 2>/dev/null || {
            # Fallback: simple colored square
            $MAGICK_CMD -size "${size}x${size}" xc:"#2563EB" "$output_file"
        }
        
        return 0
    else
        return 1
    fi
}

create_ico_from_pngs() {
    local ico_file="$1"
    
    if check_imagemagick && [ -f "${ICONS_DIR}/256x256.png" ]; then
        log_message "INFO" "Creating Windows ICO file: $ico_file"
        
        # Create ICO from multiple PNG sizes
        $MAGICK_CMD \
            "${ICONS_DIR}/16x16.png" \
            "${ICONS_DIR}/32x32.png" \
            "${ICONS_DIR}/48x48.png" \
            "${ICONS_DIR}/64x64.png" \
            "${ICONS_DIR}/128x128.png" \
            "${ICONS_DIR}/256x256.png" \
            "$ico_file" 2>/dev/null && return 0
    fi
    
    return 1
}

create_icns_from_png() {
    local icns_file="$1"
    local source_png="$2"
    
    if command -v iconutil >/dev/null 2>&1 && [[ "$OSTYPE" == "darwin"* ]]; then
        log_message "INFO" "Creating macOS ICNS file using iconutil: $icns_file"
        
        # Create iconset directory
        local iconset_dir="${ICONS_DIR}/icon.iconset"
        mkdir -p "$iconset_dir"
        
        # Create all required sizes for iconset
        local sizes=(16 32 64 128 256 512 1024)
        for size in "${sizes[@]}"; do
            if check_imagemagick; then
                $MAGICK_CMD "$source_png" -resize "${size}x${size}" "${iconset_dir}/icon_${size}x${size}.png"
                # Create @2x versions for Retina
                if [ $size -le 512 ]; then
                    local size_2x=$((size * 2))
                    $MAGICK_CMD "$source_png" -resize "${size_2x}x${size_2x}" "${iconset_dir}/icon_${size}x${size}@2x.png"
                fi
            fi
        done
        
        # Convert iconset to icns
        iconutil -c icns "$iconset_dir" -o "$icns_file"
        
        # Cleanup iconset directory
        rm -rf "$iconset_dir"
        
        return 0
    elif check_imagemagick; then
        log_message "WARNING" "iconutil not available, creating simple ICNS with ImageMagick"
        $MAGICK_CMD "$source_png" "$icns_file" 2>/dev/null && return 0
    fi
    
    return 1
}

create_manual_instructions() {
    cat > "${ICONS_DIR}/MANUAL_CREATION.md" << 'EOF'
# Manual Icon Creation Instructions

ImageMagick is not available on this system. Please create icons manually:

## Required Files

### PNG Files (use any image editor)
- **16x16.png** - 16x16 pixels
- **32x32.png** - 32x32 pixels  
- **48x48.png** - 48x48 pixels
- **64x64.png** - 64x64 pixels
- **128x128.png** - 128x128 pixels
- **256x256.png** - 256x256 pixels
- **512x512.png** - 512x512 pixels
- **icon.png** - Copy of 512x512.png

### ICO File (Windows)
- **icon.ico** - Multi-resolution ICO file
- Use tools like IcoFX, GIMP with ICO plugin, or online converters
- Include sizes: 16, 32, 48, 64, 128, 256

### ICNS File (macOS)
- **icon.icns** - macOS icon bundle
- Use Image2icon, IconFly, or online converters  
- Include all standard macOS icon sizes

## Design Guidelines
- Use professional blue color (#2563EB)
- Include "META" or "M" branding
- Ensure clarity at small sizes (16x16, 32x32)
- Use transparent background where appropriate
- Test on both light and dark backgrounds

## Quick Creation Steps
1. Create source PNG at 1024x1024 resolution
2. Resize to create all required PNG sizes
3. Convert to ICO and ICNS using appropriate tools
4. Replace placeholder files in this directory
EOF

    log_message "WARNING" "Created manual creation instructions: ${ICONS_DIR}/MANUAL_CREATION.md"
}

main() {
    echo "==================================================================================="
    echo "                         META Mover Icon Generation"
    echo "==================================================================================="
    echo
    
    log_message "INFO" "Generating placeholder icons for META Mover..."
    log_message "INFO" "Icons directory: $ICONS_DIR"
    
    # Ensure icons directory exists
    mkdir -p "$ICONS_DIR"
    
    # Check if ImageMagick is available
    if check_imagemagick; then
        log_message "SUCCESS" "ImageMagick detected: $MAGICK_CMD"
        
        # PNG sizes needed
        local png_sizes=(16 32 48 64 128 256 512)
        local png_success=true
        
        # Create PNG placeholders
        for size in "${png_sizes[@]}"; do
            local png_file="${ICONS_DIR}/${size}x${size}.png"
            if ! create_placeholder_png "$size" "$png_file"; then
                log_message "ERROR" "Failed to create ${size}x${size} PNG"
                png_success=false
            fi
        done
        
        # Create main icon.png (copy of 512x512)
        if [ -f "${ICONS_DIR}/512x512.png" ]; then
            cp "${ICONS_DIR}/512x512.png" "${ICONS_DIR}/icon.png"
            log_message "SUCCESS" "Created icon.png (512x512)"
        fi
        
        # Create Windows ICO file
        if $png_success && create_ico_from_pngs "${ICONS_DIR}/icon.ico"; then
            log_message "SUCCESS" "Created Windows ICO file"
        else
            log_message "WARNING" "Could not create Windows ICO file"
        fi
        
        # Create macOS ICNS file
        if [ -f "${ICONS_DIR}/512x512.png" ] && create_icns_from_png "${ICONS_DIR}/icon.icns" "${ICONS_DIR}/512x512.png"; then
            log_message "SUCCESS" "Created macOS ICNS file"
        else
            log_message "WARNING" "Could not create macOS ICNS file"
        fi
        
        log_message "SUCCESS" "Placeholder icon generation completed!"
        log_message "INFO" "Replace these placeholders with professional META Mover icons before production build"
        
    else
        log_message "ERROR" "ImageMagick not found (magick or convert command)"
        log_message "INFO" "Installing ImageMagick:"
        log_message "INFO" "  macOS: brew install imagemagick"
        log_message "INFO" "  Ubuntu/Debian: sudo apt install imagemagick"  
        log_message "INFO" "  Windows: Download from https://imagemagick.org"
        
        create_manual_instructions
    fi
    
    # List created files
    echo
    log_message "INFO" "Created files in ${ICONS_DIR}:"
    ls -la "$ICONS_DIR" 2>/dev/null || log_message "WARNING" "Could not list icons directory"
    
    echo
    log_message "INFO" "To replace placeholders with actual icons:"
    log_message "INFO" "1. Create professional META Mover icon artwork"
    log_message "INFO" "2. Generate all required formats and sizes"
    log_message "INFO" "3. Replace files in build-resources/icons/"
    log_message "INFO" "4. Test build process to ensure icons are integrated"
}

# Run main function
main "$@"