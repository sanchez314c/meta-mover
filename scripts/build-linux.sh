#!/bin/bash
# Build script for META Mover - Linux
# Generated: 2026-01-30

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

echo "=== META MOVER - LINUX BUILD ==="
echo "Project: $PROJECT_DIR"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js is not installed"
    echo "Install with: sudo apt install nodejs npm"
    exit 1
fi

echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"
echo ""

# Step 1: Purge existing build artifacts
echo "=== PURGING EXISTING BUILD ARTIFACTS ==="
rm -rf dist/ build/ out/ 2>/dev/null || true
# Note: Not purging release/ as it contains pre-built binaries
echo "Purged development artifacts."

# Step 2: Install dependencies
echo ""
echo "=== INSTALLING DEPENDENCIES ==="
npm install

# Step 3: Build
echo ""
echo "=== BUILDING APPLICATION ==="
npm run build

# Step 4: Build Electron for Linux
echo ""
echo "=== BUILDING ELECTRON FOR LINUX ==="
npm run dist:linux

# Step 5: Verify output
echo ""
echo "=== BUILD COMPLETE ==="
if [ -d "release" ]; then
    echo "Build output in release/:"
    ls -la release/*.AppImage release/*.deb release/*.rpm release/*.tar.gz 2>/dev/null || ls -la release/ | head -20
fi

echo ""
echo "Build completed at: $(date)"
