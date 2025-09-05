# UNIFIED PROJECT STANDARDIZATION PROMPT

## Quick Usage
Paste this entire document to Claude when in any project folder to standardize it according to best practices.

---

## INSTRUCTION TO CLAUDE

You are about to standardize a project folder structure. Create a task for each item in this document and then begin. Follow these steps EXACTLY:

### PHASE 0: PROJECT-LEVEL ARCHIVING

# ⚠️ ABSOLUTELY CRITICAL ⚠️
# NEVER SKIP THIS PHASE - NO EXCEPTIONS
# CREATE ARCHIVE BEFORE ANY MODIFICATION
# IF YOU FORGET THIS EVEN ONCE, STOP IMMEDIATELY

#### 0.1 Local Archive Protocol
**🚨 CRITICAL REQUIREMENT 🚨**: Before ANY modification to the project, create a local archive if one exists purge any backups present
**🚨 NO EXCEPTIONS 🚨**: Even if the project is empty, broken, or tiny - ARCHIVE IT FIRST  
**🚨 VERIFICATION REQUIRED 🚨**: Must verify archive exists before proceeding

**Archive Structure**:
```
project-root/
├── archive/                      # Backup folder
│   └── original_backup.zip     # Complete zipped archive of original state
└── [working files]              # Files we'll be modifying
```

#### 0.2 Archive Creation Process

#### 🛑 STOP AND READ 🛑
**YOU MUST DO THIS BEFORE ANY MODIFICATIONS**  
**DO NOT PROCEED WITHOUT ARCHIVING**  
**THIS IS NOT OPTIONAL**

```bash
# Navigate to the project directory
cd project-root

# 1. Create backup folder
mkdir -p backup

# 2. Create timestamped zip archive of EVERYTHING except the backup folder itself
zip -r "backup/original_backup_$(date +%Y%m%d_%H%M%S).zip" . -x "backup/*" "*.DS_Store"

# Alternative if the project is large or has many files:
tar -czf "backup/original_backup_$(date +%Y%m%d_%H%M%S).tar.gz" --exclude="backup" --exclude=".DS_Store" .

# 3. Verify the backup was created
ls -la backup/

# 4. Verify the backup contains files (quick check)
unzip -l backup/original_backup_*.zip | head -20
# or for tar:
tar -tzf backup/original_backup_*.tar.gz | head -20
```

#### 0.3 Archive Verification
Before proceeding with ANY modifications:
1. Verify backup folder exists: `archive/`
2. Verify zip file exists: `archive/original_backup_*.zip`
3. Verify zip is not empty (has actual content)

#### 0.5 Archive .gitignore Addition
Add to .gitignore:
```gitignore
# Local backup archives
backup/
*.zip
*.tar.gz
```

#### 0.6 Simple Restoration Process
If you need to restore:
```bash
# 1. Navigate to project
cd project-root

# 2. Remove current files (except backup folder)
find . -maxdepth 1 ! -name 'backup' ! -name '.' -exec rm -rf {} \;

# 3. Unzip the backup
unzip backup/original_backup_*.zip

# 4. Remove the backup folder if desired
rm -rf backup/
```

---

### PHASE 1: DISCOVERY (Do First)
1. Run `pwd` to confirm current directory
2. Run `ls -la` to see current structure
3. Check for existing config files to identify tech stack:
   - `package.json` → Node/JavaScript/TypeScript project
   - `requirements.txt` or `pyproject.toml` → Python project
   - `Package.swift` → Swift project
   - `Cargo.toml` → Rust project
   - `pom.xml` or `build.gradle` → Java project
   - Look for framework indicators (next.config.js, vite.config.ts, etc.)
4. Create `/tech-stack.md` with discovered information

### PHASE 2: UNIVERSAL STRUCTURE (Apply to ALL Projects)

```
project-root/
├── .github/
│   ├── workflows/
│   │   └── ci.yml
│   ├── ISSUE_TEMPLATE/
│   └── PULL_REQUEST_TEMPLATE.md
├── archive/              # Old versions, deprecated code
├── assets/               # Images, icons, media files
│   ├── icons/
│   ├── images/
│   └── screenshots/
├── config/               # Configuration files
├── dev/                  # Development resources
│   ├── PRDs/            # Product requirement docs
│   ├── specs/           # Technical specifications
│   ├── notes/           # Development notes
│   └── research/        # Research materials
├── docs/                 # User-facing documentation
│   ├── API.md
│   ├── ARCHITECTURE.md
│   └── SETUP.md
├── examples/             # Example usage, demos
├── scripts/              # Build, deploy, utility scripts
├── src/                  # Source code (structure varies by stack)
├── tests/                # Test files
│   ├── unit/
│   ├── integration/
│   └── e2e/
├── .env.example          # Environment variables template
├── .gitignore           # Git ignore rules
├── CHANGELOG.md         # Version history
├── CONTRIBUTING.md      # Contribution guidelines
├── LICENSE              # License file
├── README.md            # Project overview
├── SECURITY.md          # Security policy
├── claude.md            # Claude-specific instructions (create after organizing)
├── tech-stack.md        # Technology stack overview (create first)
├── PRD.md               # Product Requirements Document
├── LEARNINGS.md         # What I learned building this
├── TODO.md              # Future enhancements
├── icon.png             # 512x512 project icon
├── favicon.ico          # For web projects
├── screenshot.png       # Main screenshot
└── backup/              # Local archives (from Phase 0)
```

For multi-version projects within the single project:
```
project-root/
├── README.md                    # Master documentation
├── VERSION_MAP.md               # Explains all versions
├── PRD.md                       # Product vision
├── EVOLUTION.md                 # Project evolution
├── CHANGELOG.md                 # Version history
├── LICENSE                      # License file
├── icon.png                     # Project icon
├── screenshots/                 # All screenshots
│   ├── main.png
│   ├── v00_screenshot.png
│   └── latest_demo.png
├── compile-build-dist.sh       # Main build script
├── run-macos.sh                # macOS run
├── run-windows.bat             # Windows run
├── run-linux.sh                # Linux run
├── run-macos-source.sh         # macOS source run
├── run-windows-source.bat      # Windows source run
├── run-linux-source.sh         # Linux source run
├── runProject.sh                # Version selector
├── setup.sh                    # Setup script
├── [CURRENT VERSION FILES]     # Latest version in root
├── src/                        # Current source
├── config/                     # Current config
├── versions/                   # Older versions
│   ├── v00/                   # Oldest version
│   │   ├── README.md
│   │   ├── CHANGES.md
│   │   └── [v00 code]
│   └── v01/                   # Next version
└── shared/                     # Shared resources
    ├── assets/
    ├── docs/
    └── config/
```

**VERSION ORGANIZATION RULES**:
1. MAIN/CURRENT version in root
2. Older versions in `versions/` 
3. Numbering starts at v00 (oldest)
4. Each version self-contained
5. Build/run scripts at root
6. Screenshots in root `screenshots/`

### PHASE 3: NAMING CONVENTIONS

**Universal Rules:**
- **Folders**: kebab-case (e.g., `user-auth`, `api-routes`)
- **Config files**: kebab-case with appropriate extension (e.g., `jest.config.js`)
- **Documentation**: UPPERCASE.md for root docs, kebab-case.md for others
- **Environment files**: .env.{environment} (e.g., `.env.local`, `.env.production`)

**Tech-Specific:**
- **JavaScript/TypeScript**: camelCase for files (e.g., `userController.js`)
- **Python**: snake_case for files (e.g., `user_controller.py`)
- **React Components**: PascalCase (e.g., `UserProfile.jsx`)
- **Swift**: PascalCase (e.g., `UserViewController.swift`)

### PHASE 4: TECH-SPECIFIC ADAPTATIONS

#### IF ELECTRON PROJECT
```
src/
├── main/                # Main process
│   ├── main.js
│   ├── preload.js
│   └── ipc-handlers/
├── renderer/            # Renderer process
│   ├── index.html
│   ├── renderer.js
│   └── components/
└── shared/              # Shared utilities
```
Add to package.json scripts:
- `"start": "electron ."`
- `"dev": "electron . --dev"`
- `"build": "electron-builder"`

#### IF REACT/NEXT.JS PROJECT
```
src/
├── app/ (or pages/)     # Next.js routes
├── components/
│   ├── common/
│   ├── features/
│   └── layouts/
├── hooks/               # Custom React hooks
├── lib/                 # Utilities, helpers
├── services/            # API services
├── stores/              # State management
├── styles/              # Global styles
└── types/               # TypeScript types
```

#### IF PYTHON PROJECT
```
src/ (or project_name/)
├── __init__.py
├── api/                 # API endpoints
├── core/                # Core business logic
├── models/              # Data models
├── services/            # Business services
├── utils/               # Utility functions
└── main.py             # Entry point
```
Add files:
- `requirements.txt` or `pyproject.toml`
- `setup.py` if library
- `.python-version`

#### IF SWIFT PROJECT
```
Sources/
├── App/
│   ├── AppDelegate.swift
│   └── SceneDelegate.swift
├── Models/
├── Views/
├── Controllers/
├── Services/
├── Extensions/
└── Resources/
```

#### IF VITE PROJECT
Add/update `vite.config.ts`:
```typescript
import { defineConfig } from 'vite'
export default defineConfig({
  // Project-specific config
})
```

### PHASE 5: STANDARD FILES CONTENT

#### tech-stack.md (CREATE FIRST)
```markdown
# Technology Stack

## Core Technologies
- **Language**: [Detected language]
- **Framework**: [Detected framework]
- **Runtime**: [Node.js/Python/etc version]
- **Package Manager**: [npm/yarn/pip/etc]

## Key Dependencies
[List main dependencies found]

## Development Tools
- **Linter**: [ESLint/Pylint/etc]
- **Formatter**: [Prettier/Black/etc]
- **Testing**: [Jest/Pytest/etc]
- **Build Tool**: [Webpack/Vite/etc]

## Project Type
[Web App/Desktop App/CLI Tool/Library/etc]
```

#### .gitignore (UNIVERSAL BASE)
```
# Dependencies
node_modules/
venv/
.env
*.pyc
__pycache__/

# Build outputs
dist/
build/
out/
*.egg-info/

# IDE
.vscode/
.idea/
*.swp
.DS_Store

# Logs
*.log
logs/

# Testing
coverage/
.coverage
.pytest_cache/

# OS
Thumbs.db
```

#### README.md (TEMPLATE)
```markdown
# Project Name

## Overview
[Brief description]

## Tech Stack
See [tech-stack.md](tech-stack.md) for details.

## Quick Start
```bash
# Installation
[package manager] install

# Development
[run command]

# Testing
[test command]

# Build
[build command]
```

## Project Structure
[Brief explanation of folder structure]

## Documentation
- [API Documentation](docs/API.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Setup Guide](docs/SETUP.md)

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md)

## License
[License type]
```

#### claude.md (CREATE LAST)
```markdown
# Claude Instructions for [Project Name]

## Project Overview
[Auto-generated summary of project]

## Technology Stack
[Reference to tech-stack.md]

## Key Conventions
- File naming: [Detected convention]
- Code style: [Detected style]
- Testing approach: [Detected approach]

## Important Paths
- Source code: `src/`
- Tests: `tests/`
- Documentation: `docs/`
- Configuration: `config/`

## Common Tasks
- To run development: `[command]`
- To run tests: `[command]`
- To build: `[command]`

## Project-Specific Notes
[Any special considerations discovered]

## Recent Changes
Project standardized on [current date]
- Reorganized folder structure
- Added standard documentation
- Configured development environment
```

#### PRD.md (TEMPLATE)
```markdown
# Product Requirements Document

## Overview
### Vision
What this project could become

### Current State
Where the project stands today

### Target Users
Who would benefit from this

## Core Requirements
### Functional Requirements
1. Requirement 1
2. Requirement 2

### Non-Functional Requirements
- Performance expectations
- Security considerations
- Scalability needs

## User Stories
- As a [user type], I want to [action] so that [benefit]

## Technical Specifications
### Architecture
High-level architecture description

### Data Models
Key data structures

### API Design
Endpoint specifications

## Success Metrics
How we measure if this project succeeds

## Constraints & Assumptions
- Time constraints
- Technical constraints
- Resource constraints

## Future Considerations
What could be added in v2
```

#### LEARNINGS.md (TEMPLATE)
```markdown
# Learning Journey: [Project Name]

## 🎯 What I Set Out to Learn
- Objective 1
- Objective 2

## 💡 Key Discoveries
### Technical Insights
- Discovery about [technology]
- Unexpected behavior in [feature]

### Architecture Decisions
- Why I chose [pattern]
- Trade-offs I considered

## 🚧 Challenges Faced
### Challenge 1: [Name]
**Problem**: Description
**Solution**: How I solved it
**Time Spent**: X hours

## 📚 Resources That Helped
- [Resource 1](link) - Why it was useful
- [Resource 2](link) - Key takeaway

## 🔄 What I'd Do Differently
- Decision 1 and why
- Decision 2 and why

## 🎓 Skills Developed
- [ ] Skill 1
- [ ] Skill 2

## 📈 Next Steps for Learning
Where this knowledge leads next
```

#### TODO.md (TEMPLATE)
```markdown
# Project Roadmap

## 🔥 High Priority
- [ ] Task 1
- [ ] Task 2

## 📦 Features to Add
- [ ] Feature 1
  - Sub-task 1
  - Sub-task 2
- [ ] Feature 2

## 🐛 Known Issues
- [ ] Bug 1: Description
- [ ] Bug 2: Description

## 💡 Ideas for Enhancement
- Idea 1: Description
- Idea 2: Description

## 🔧 Technical Debt
- [ ] Refactor [component]
- [ ] Add tests for [feature]
- [ ] Optimize [process]

## 📖 Documentation Needs
- [ ] Document API endpoints
- [ ] Add inline code comments
- [ ] Create user guide

## 🚀 Dream Features (v2.0)
Features for when the basics are complete
```

#### VERSION_MAP.md (TEMPLATE for multi-version)
```markdown
# Version Map - [Project Name]

## Overview
This project has evolved through multiple iterations.

## Version Timeline

### v00_original (Date)
**Purpose**: Initial implementation
**Status**: Archived but functional
**Key Features**:
- Basic functionality

**Run**: `./runProject.sh` → Option 1

### v01_refactor (Date)
**Purpose**: Clean up code
**What Changed**:
- Reorganized structure

**Run**: `./runProject.sh` → Option 2

## Experimental Branches

### CLI_version
**Purpose**: Command-line implementation

## How to Navigate Versions
1. Use `./runProject.sh` for selection
2. Navigate to `versions/vXX_name/`

## Lessons Learned Across Versions
- v00 taught: [lesson]
- v01 taught: [lesson]
```

### PHASE 6: EXECUTION CHECKLIST

1. ✅ Identify tech stack
2. ✅ Create tech-stack.md
3. ✅ Create missing folders
4. ✅ Move files to appropriate locations
5. ✅ Rename files to match conventions
6. ✅ Create missing standard files
7. ✅ Update .gitignore
8. ✅ Update README.md
9. ✅ Add/update configuration files
10. ✅ Create claude.md with project summary

### PHASE 7: VALIDATION

After reorganization, run:
```bash
# Show new structure
tree -L 3 -I 'node_modules|venv|__pycache__|.git'

# Verify project still works
[appropriate run command for the stack]

# Check for any broken imports
[appropriate lint command]
```

### PHASE 8: BUILD-COMPILE-DIST.sh

1. ✅ Purge existing /dist folder
2. ✅ Purge existing build and run scripts
3. ✅ Create new build-compile-dist.sh (ref below)
4. ✅ Create new run and run from source scripts for MacOS, Linux and Windows
5. ✅ Compile new binaries and packages and installers for MacOS, and Windows

BEFORE BUILDING AND COMPILING YOU MUST CHECK ALL SOURCE CODE FOR BUGS OR ERRORS AND THEN VERIFY IT RUNS FROM SOURCE.

## Complete Multi-Platform Electron Build System (For Electron Projects)

## AMMENDMENTS:

Run and run from source scripts for Windows, Mac and Linux should be created and stored in the /scripts folder. When running build-compile-dist.sh be sure to purge the contents of the /dist folder. And look for and use icon from within /assets or /resources folder. Copy icon.png to icon.ico and resized to 256x256.

Changelog.md and Techstack.md and similar files into the /dev folder.

This build system provides comprehensive support for building Electron applications for macOS, Windows, and Linux with all major installer formats. You are to build for ALL OSes.

## Build System Requirements

1. **Remove existing build scripts**: Delete any existing build, compile, or dist scripts
2. **Create new scripts**: Implement all scripts below with proper permissions
3. **Platform coverage**: Full support for macOS (Intel + ARM), Windows (x64 + x86), Linux (x64)
4. **Installer types**: All major formats including .msi, .exe, .deb, .rpm, .AppImage, .dmg, etc.

## Required /dist Folder Structure

After running `compile-build-dist.sh`, the `/dist` folder should contain:

```
dist/
├── linux-unpacked/          # Unpacked Linux application files
├── mac/                     # macOS Intel build
│   └── [AppName].app        # Intel .app bundle
├── mac-arm64/              # macOS ARM64 build
│   └── [AppName].app        # ARM64 .app bundle
├── win-unpacked/           # Unpacked Windows application files
├── win-ia32-unpacked/      # Unpacked Windows 32-bit files
├── builder-debug.yml       # Electron-builder debug info
├── latest-linux.yml        # Linux update info
├── latest-mac.yml          # macOS update info
├── latest.yml              # General update info
├── [AppName] Setup [version].exe              # Windows NSIS installer
├── [AppName] Setup [version].exe.blockmap     # Windows blockmap
├── [AppName] Setup [version].msi              # Windows MSI installer
├── [AppName]-[version]-arm64.dmg              # macOS ARM64 DMG
├── [AppName]-[version]-arm64.dmg.blockmap     # macOS ARM64 blockmap
├── [AppName]-[version]-win.zip                # Windows portable
├── [AppName]-[version]-ia32-win.zip           # Windows 32-bit portable
├── [AppName]-[version].AppImage               # Linux AppImage
├── [AppName]-[version].deb                    # Debian/Ubuntu package
├── [AppName]-[version].rpm                    # RedHat/Fedora package
├── [AppName]-[version].snap                   # Snap package
├── [AppName]-[version].dmg                    # macOS Intel DMG
├── [AppName]-[version].dmg.blockmap           # macOS Intel blockmap
└── [AppName]-[version].zip                    # macOS portable
```

## Script 1: compile-build-dist.sh
Main build script for all platforms:

```bash
#!/bin/bash

# Complete Multi-Platform Build Script
# Builds for macOS, Windows, and Linux with all installer types

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
cd "$SCRIPT_DIR"

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

# Function to display help
show_help() {
    echo "Complete Multi-Platform Build Script"
    echo ""
    echo "Usage: ./compile-build-dist.sh [options]"
    echo ""
    echo "Options:"
    echo "  --no-clean         Skip cleaning build artifacts"
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
PLATFORM="all"
ARCH="all"
QUICK=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --no-clean)
            NO_CLEAN=true
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

# Step 1: Clean everything if not skipped
if [ "$NO_CLEAN" = false ]; then
    print_status "🧹 Purging all existing builds..."
    rm -rf dist/
    rm -rf build/
    rm -rf node_modules/.cache/
    rm -rf out/
    print_success "All build artifacts purged"
fi

# Step 2: Install/update dependencies
print_status "📦 Installing/updating dependencies..."
npm install
if [ $? -ne 0 ]; then
    print_error "Failed to install dependencies"
    exit 1
fi

# Install electron-builder if not present
if ! npm list electron-builder >/dev/null 2>&1; then
    print_status "Installing electron-builder..."
    npm install --save-dev electron-builder
fi

print_success "Dependencies ready"

# Step 3: Determine build targets
print_status "🎯 Determining build targets..."
BUILD_CMD="npm run dist"

if [ "$QUICK" = true ]; then
    print_info "Quick build mode - building for current platform only"
    BUILD_CMD="npm run dist:current"
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
    print_info "Building for all platforms"
fi

# Step 4: Build all platform binaries and packages
print_status "🏗️ Building platform binaries and packages..."
print_status "Targets: macOS (Intel + ARM), Windows (x64 + x86), Linux (x64)"
print_status "Installers: .dmg, .exe, .msi, .deb, .rpm, .AppImage, .snap"

# Run the build
$BUILD_CMD
BUILD_RESULT=$?

if [ $BUILD_RESULT -ne 0 ]; then
    print_error "Build failed"
    exit 1
fi

print_success "All platform builds completed successfully"

# Step 5: Generate additional installer types if needed
if [ "$PLATFORM" = "all" ] || [ "$PLATFORM" = "win" ]; then
    if [ -f "dist/*.exe" ] && [ ! -f "dist/*.msi" ]; then
        print_status "Generating MSI installer..."
        npm run dist:win:msi 2>/dev/null || print_warning "MSI generation requires additional setup"
    fi
fi

# Step 6: Display build results
print_status "📋 Build Results Summary:"
echo ""
echo -e "${PURPLE}════════════════════════════════════════════════════════${NC}"

if [ -d "dist" ]; then
    # Count files by type
    MAC_COUNT=$(find dist -name "*.dmg" -o -name "*.zip" | grep -E "(mac|darwin)" | wc -l)
    WIN_COUNT=$(find dist -name "*.exe" -o -name "*.msi" -o -name "*-win.zip" | wc -l)
    LINUX_COUNT=$(find dist -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" -o -name "*.snap" | wc -l)
    
    print_info "📊 Build Statistics:"
    echo "   macOS packages: $MAC_COUNT"
    echo "   Windows packages: $WIN_COUNT"
    echo "   Linux packages: $LINUX_COUNT"
    echo ""
    
    # macOS builds
    if [ $MAC_COUNT -gt 0 ]; then
        print_success "🍎 macOS Builds:"
        [ -d "dist/mac" ] && echo "   ✓ Intel: dist/mac/*.app"
        [ -d "dist/mac-arm64" ] && echo "   ✓ ARM64: dist/mac-arm64/*.app"
        find dist -name "*.dmg" -type f | while read -r dmg; do
            size=$(ls -lh "$dmg" | awk '{print $5}')
            echo "   ✓ DMG: $(basename "$dmg") ($size)"
        done
        echo ""
    fi
    
    # Windows builds
    if [ $WIN_COUNT -gt 0 ]; then
        print_success "🪟 Windows Builds:"
        [ -d "dist/win-unpacked" ] && echo "   ✓ x64 Unpacked: dist/win-unpacked/"
        [ -d "dist/win-ia32-unpacked" ] && echo "   ✓ x86 Unpacked: dist/win-ia32-unpacked/"
        find dist -name "*.exe" -type f | while read -r exe; do
            size=$(ls -lh "$exe" | awk '{print $5}')
            echo "   ✓ EXE: $(basename "$exe") ($size)"
        done
        find dist -name "*.msi" -type f | while read -r msi; do
            size=$(ls -lh "$msi" | awk '{print $5}')
            echo "   ✓ MSI: $(basename "$msi") ($size)"
        done
        find dist -name "*-win.zip" -type f | while read -r zip; do
            size=$(ls -lh "$zip" | awk '{print $5}')
            echo "   ✓ Portable: $(basename "$zip") ($size)"
        done
        echo ""
    fi
    
    # Linux builds
    if [ $LINUX_COUNT -gt 0 ]; then
        print_success "🐧 Linux Builds:"
        [ -d "dist/linux-unpacked" ] && echo "   ✓ Unpacked: dist/linux-unpacked/"
        find dist -name "*.AppImage" -type f | while read -r app; do
            size=$(ls -lh "$app" | awk '{print $5}')
            echo "   ✓ AppImage: $(basename "$app") ($size)"
        done
        find dist -name "*.deb" -type f | while read -r deb; do
            size=$(ls -lh "$deb" | awk '{print $5}')
            echo "   ✓ DEB: $(basename "$deb") ($size)"
        done
        find dist -name "*.rpm" -type f | while read -r rpm; do
            size=$(ls -lh "$rpm" | awk '{print $5}')
            echo "   ✓ RPM: $(basename "$rpm") ($size)"
        done
        find dist -name "*.snap" -type f | while read -r snap; do
            size=$(ls -lh "$snap" | awk '{print $5}')
            echo "   ✓ Snap: $(basename "$snap") ($size)"
        done
        echo ""
    fi
    
    # Auto-update files
    print_info "🔄 Auto-update files:"
    for yml in dist/*.yml; do
        if [ -f "$yml" ]; then
            echo "   ✓ $(basename "$yml")"
        fi
    done
else
    print_warning "No dist directory found. Build may have failed."
fi

echo ""
echo -e "${PURPLE}════════════════════════════════════════════════════════${NC}"
print_success "🎉 Complete build process finished!"
print_status "📁 All binaries and packages are in: ./dist/"
print_status ""
print_info "To run the application:"
print_info "  macOS:   ./run-macos-source.sh (dev) or ./run-macos.sh (binary)"
print_info "  Windows: run-windows-source.bat (dev) or run-windows.bat (binary)"
print_info "  Linux:   ./run-linux-source.sh (dev) or ./run-linux.sh (binary)"
```

## Script 2: run-macos-source.sh
Run from source on macOS:

```bash
#!/bin/bash

# Run from Source on macOS (Development Mode)
# Launches the app directly from source code using Electron

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[$(date +'%H:%M:%S')] ✔${NC} $1"
}

print_error() {
    echo -e "${RED}[$(date +'%H:%M:%S')] ✗${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

print_status "🚀 Starting application from source (macOS)..."

# Check if we're on macOS
if [ "$(uname)" != "Darwin" ]; then
    print_error "This script is designed for macOS only"
    print_status "Use run-linux-source.sh for Linux or run-windows-source.bat for Windows"
    exit 1
fi

# Check for required tools
if ! command_exists node; then
    print_error "Node.js is not installed. Please install Node.js first."
    exit 1
fi

if ! command_exists npm; then
    print_error "npm is not installed. Please install npm first."
    exit 1
fi

# Check if package.json exists
if [ ! -f "package.json" ]; then
    print_error "package.json not found. Make sure you're in the project root directory."
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    print_status "Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        print_error "Failed to install dependencies"
        exit 1
    fi
    print_success "Dependencies installed"
fi

# Launch the app from source
print_status "Launching application from source code..."
print_status "Press Ctrl+C to stop the application"
echo ""

# Run the app in development mode
npm start

echo ""
print_success "Application session ended"
```

## Script 3: run-macos.sh
Run compiled binary on macOS:

```bash
#!/bin/bash

# Run Compiled Binary on macOS
# Launches the compiled macOS app from dist folder

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

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

print_status "🚀 Launching compiled application (macOS)..."

# Check if we're on macOS
if [ "$(uname)" != "Darwin" ]; then
    print_error "This script is designed for macOS only"
    print_status "For other platforms:"
    print_status "  Windows: Use run-windows.bat"
    print_status "  Linux: Use ./run-linux.sh"
    exit 1
fi

# Check if dist directory exists
if [ ! -d "dist" ]; then
    print_error "No dist/ directory found. Please run ./compile-build-dist.sh first."
    exit 1
fi

# Detect system architecture
ARCH=$(uname -m)
APP_PATH=""

# Choose appropriate build based on architecture
if [ "$ARCH" = "arm64" ]; then
    print_status "Detected Apple Silicon Mac (ARM64)"
    # Look for ARM version first
    if [ -d "dist/mac-arm64" ]; then
        APP_PATH=$(find dist/mac-arm64 -name "*.app" -type d | head -n 1)
    fi
    # Fall back to universal or Intel build
    if [ -z "$APP_PATH" ] && [ -d "dist/mac" ]; then
        APP_PATH=$(find dist/mac -name "*.app" -type d | head -n 1)
        print_warning "ARM64 build not found, using Intel build with Rosetta"
    fi
else
    print_status "Detected Intel Mac (x64)"
    # Look for Intel version
    if [ -d "dist/mac" ]; then
        APP_PATH=$(find dist/mac -name "*.app" -type d | head -n 1)
    fi
fi

# If still no app found, look anywhere in dist
if [ -z "$APP_PATH" ]; then
    APP_PATH=$(find dist -name "*.app" -type d | head -n 1)
fi

# Launch the app if found
if [ -n "$APP_PATH" ] && [ -d "$APP_PATH" ]; then
    print_success "Found application: $(basename "$APP_PATH")"
    print_status "Launching..."
    
    # Launch the app
    open "$APP_PATH"
    
    print_success "Application launched successfully!"
    print_status "The app is now running"
else
    print_error "Could not find .app bundle in dist/ directory"
    print_warning "Available files in dist/:"
    
    if [ -d "dist" ]; then
        ls -la dist/ | head -20
    fi
    
    print_status ""
    print_status "To build the app first, run:"
    print_status "  ./compile-build-dist.sh"
    
    exit 1
fi
```

## Script 4: run-windows-source.bat
Run from source on Windows:

```batch
@echo off
setlocal enabledelayedexpansion

REM Run from Source on Windows (Development Mode)
REM Launches the app directly from source code using Electron

REM Set colors
set RED=[91m
set GREEN=[92m
set YELLOW=[93m
set BLUE=[94m
set NC=[0m

REM Get script directory
cd /d "%~dp0"

echo %BLUE%[%TIME%]%NC% Starting application from source (Windows)...

REM Check for Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo %RED%[%TIME%] X%NC% Node.js is not installed. Please install Node.js first.
    echo Download from: https://nodejs.org/
    pause
    exit /b 1
)

REM Check for npm
where npm >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo %RED%[%TIME%] X%NC% npm is not installed. Please install npm first.
    pause
    exit /b 1
)

REM Check if package.json exists
if not exist "package.json" (
    echo %RED%[%TIME%] X%NC% package.json not found. Make sure you're in the project root directory.
    pause
    exit /b 1
)

REM Install dependencies if needed
if not exist "node_modules" (
    echo %BLUE%[%TIME%]%NC% Installing dependencies...
    call npm install
    if %ERRORLEVEL% NEQ 0 (
        echo %RED%[%TIME%] X%NC% Failed to install dependencies
        pause
        exit /b 1
    )
    echo %GREEN%[%TIME%] OK%NC% Dependencies installed
)

REM Launch the app from source
echo %BLUE%[%TIME%]%NC% Launching application from source code...
echo Press Ctrl+C to stop the application
echo.

REM Run the app in development mode
call npm start

echo.
echo %GREEN%[%TIME%] OK%NC% Application session ended
pause
```

## Script 5: run-windows.bat
Run compiled binary on Windows:

```batch
@echo off
setlocal enabledelayedexpansion

REM Run Compiled Binary on Windows
REM Launches the compiled Windows app from dist folder

REM Set colors
set RED=[91m
set GREEN=[92m
set YELLOW=[93m
set BLUE=[94m
set NC=[0m

REM Get script directory
cd /d "%~dp0"

echo %BLUE%[%TIME%]%NC% Launching compiled application (Windows)...

REM Check if dist directory exists
if not exist "dist" (
    echo %RED%[%TIME%] X%NC% No dist/ directory found. Please run compile-build-dist.sh first.
    echo.
    echo Build the application first using:
    echo   - Git Bash: ./compile-build-dist.sh
    echo   - WSL: ./compile-build-dist.sh
    echo   - PowerShell with WSL: wsl ./compile-build-dist.sh
    pause
    exit /b 1
)

REM Find the executable
set "APP_PATH="

REM Check for unpacked executable first (faster launch)
if exist "dist\win-unpacked\*.exe" (
    for %%F in (dist\win-unpacked\*.exe) do (
        set "APP_PATH=%%F"
        echo %BLUE%[%TIME%]%NC% Found unpacked executable: %%~nxF
        goto :found
    )
)

REM Check for installer
if exist "dist\*.exe" (
    for %%F in (dist\*.exe) do (
        REM Skip blockmap files
        echo %%F | findstr /C:".blockmap" >nul
        if errorlevel 1 (
            set "APP_PATH=%%F"
            echo %YELLOW%[%TIME%] !%NC% Found installer: %%~nxF
            echo %YELLOW%[%TIME%] !%NC% Note: This will install the application
            goto :found
        )
    )
)

REM No executable found
echo %RED%[%TIME%] X%NC% Could not find executable in dist/ directory
echo.
echo %YELLOW%[%TIME%] !%NC% Available files in dist/:
dir dist /b
echo.
echo To build the app first, run:
echo   - Git Bash: ./compile-build-dist.sh
echo   - WSL: ./compile-build-dist.sh
pause
exit /b 1

:found
REM Launch the application
echo %GREEN%[%TIME%] OK%NC% Launching application...
start "" "!APP_PATH!"

echo %GREEN%[%TIME%] OK%NC% Application launched successfully!
echo The app is now running
pause
```

## Script 6: run-linux-source.sh
Run from source on Linux:

```bash
#!/bin/bash

# Run from Source on Linux (Development Mode)
# Launches the app directly from source code using Electron

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# Function to print colored output
print_status() {
    echo -e "${BLUE}[$(date +'%H:%M:%S')]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[$(date +'%H:%M:%S')] ✔${NC} $1"
}

print_error() {
    echo -e "${RED}[$(date +'%H:%M:%S')] ✗${NC} $1"
}

# Function to check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

print_status "🚀 Starting application from source (Linux)..."

# Check if we're on Linux
if [ "$(uname)" != "Linux" ]; then
    print_error "This script is designed for Linux only"
    print_status "Use run-macos-source.sh for macOS or run-windows-source.bat for Windows"
    exit 1
fi

# Check for required tools
if ! command_exists node; then
    print_error "Node.js is not installed. Please install Node.js first."
    print_status "Install with: sudo apt install nodejs (Debian/Ubuntu)"
    print_status "           or: sudo dnf install nodejs (Fedora)"
    print_status "           or: sudo pacman -S nodejs (Arch)"
    exit 1
fi

if ! command_exists npm; then
    print_error "npm is not installed. Please install npm first."
    print_status "Install with: sudo apt install npm (Debian/Ubuntu)"
    print_status "           or: sudo dnf install npm (Fedora)"
    print_status "           or: sudo pacman -S npm (Arch)"
    exit 1
fi

# Check if package.json exists
if [ ! -f "package.json" ]; then
    print_error "package.json not found. Make sure you're in the project root directory."
    exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    print_status "Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        print_error "Failed to install dependencies"
        exit 1
    fi
    print_success "Dependencies installed"
fi

# Set electron flags for better Linux compatibility
export ELECTRON_FORCE_WINDOW_MENU_BAR=1
export ELECTRON_TRASH=gio

# Launch the app from source
print_status "Launching application from source code..."
print_status "Press Ctrl+C to stop the application"
echo ""

# Run the app in development mode
npm start

echo ""
print_success "Application session ended"
```

## Script 7: run-linux.sh
Run compiled binary on Linux:

```bash
#!/bin/bash

# Run Compiled Binary on Linux
# Launches the compiled Linux app from dist folder

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Get the script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

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

print_status "🚀 Launching compiled application (Linux)..."

# Check if we're on Linux
if [ "$(uname)" != "Linux" ]; then
    print_error "This script is designed for Linux only"
    print_status "For other platforms:"
    print_status "  macOS: Use ./run-macos.sh"
    print_status "  Windows: Use run-windows.bat"
    exit 1
fi

# Check if dist directory exists
if [ ! -d "dist" ]; then
    print_error "No dist/ directory found. Please run ./compile-build-dist.sh first."
    exit 1
fi

# Function to launch different package types
launch_appimage() {
    local appimage="$1"
    
    # Make sure it's executable
    chmod +x "$appimage"
    
    # Check if we need to extract and run
    if [ -z "$DISPLAY" ]; then
        print_error "No display detected. Cannot run GUI application."
        exit 1
    fi
    
    print_status "Launching AppImage..."
    "$appimage" &
    print_success "AppImage launched successfully!"
}

launch_unpacked() {
    local exec_path="$1"
    
    # Make sure it's executable
    chmod +x "$exec_path"
    
    print_status "Launching unpacked application..."
    "$exec_path" &
    print_success "Application launched successfully!"
}

# Look for application in order of preference
APP_FOUND=false

# 1. Try AppImage first (most portable)
if [ -f dist/*.AppImage ]; then
    for appimage in dist/*.AppImage; do
        if [ -f "$appimage" ]; then
            print_info "Found AppImage: $(basename "$appimage")"
            launch_appimage "$appimage"
            APP_FOUND=true
            break
        fi
    done
fi

# 2. Try unpacked version
if [ "$APP_FOUND" = false ] && [ -d "dist/linux-unpacked" ]; then
    # Find the main executable
    EXEC_NAME=$(grep -l '"name"' package.json | xargs grep '"name"' | cut -d'"' -f4 | head -1)
    
    if [ -z "$EXEC_NAME" ]; then
        # Try to find any executable
        EXEC_PATH=$(find dist/linux-unpacked -type f -executable | grep -v ".so" | head -1)
    else
        EXEC_PATH="dist/linux-unpacked/$EXEC_NAME"
    fi
    
    if [ -f "$EXEC_PATH" ]; then
        print_info "Found unpacked executable: $(basename "$EXEC_PATH")"
        launch_unpacked "$EXEC_PATH"
        APP_FOUND=true
    fi
fi

# 3. Check for distribution packages
if [ "$APP_FOUND" = false ]; then
    print_warning "No runnable binary found. Found these packages instead:"
    
    if ls dist/*.deb 2>/dev/null; then
        for deb in dist/*.deb; do
            print_info "DEB package: $(basename "$deb")"
            print_info "  Install with: sudo dpkg -i $deb"
        done
    fi
    
    if ls dist/*.rpm 2>/dev/null; then
        for rpm in dist/*.rpm; do
            print_info "RPM package: $(basename "$rpm")"
            print_info "  Install with: sudo rpm -i $rpm"
        done
    fi
    
    if ls dist/*.snap 2>/dev/null; then
        for snap in dist/*.snap; do
            print_info "Snap package: $(basename "$snap")"
            print_info "  Install with: sudo snap install --dangerous $snap"
        done
    fi
    
    echo ""
    print_status "Install one of these packages to run the application system-wide"
    exit 1
fi

if [ "$APP_FOUND" = false ]; then
    print_error "Could not find any Linux binary in dist/ directory"
    print_warning "Available files in dist/:"
    
    if [ -d "dist" ]; then
        ls -la dist/ | head -20
    fi
    
    print_status ""
    print_status "To build the app first, run:"
    print_status "  ./compile-build-dist.sh"
    
    exit 1
fi

print_status "The application is running in the background"
print_status "Check your desktop or dock to interact with it"
```

## Package.json Configuration (For Electron Projects)

Add these scripts and build configuration to your package.json:

```json
{
  "name": "your-app-name",
  "version": "1.0.0",
  "description": "Your application description",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder --mac --win --linux",
    "dist:current": "electron-builder",
    "dist:mac": "electron-builder --mac",
    "dist:win": "electron-builder --win",
    "dist:win:msi": "electron-builder --win --config.win.target=msi",
    "dist:linux": "electron-builder --linux",
    "pack": "electron-builder --dir",
    "postinstall": "electron-builder install-app-deps"
  },
  "build": {
    "appId": "com.yourcompany.yourapp",
    "productName": "YourAppName",
    "copyright": "Copyright © 2024 ${author}",
    "directories": {
      "output": "dist",
      "buildResources": "build-resources"
    },
    "files": [
      "**/*",
      "!**/*.ts",
      "!*.code-workspace",
      "!LICENSE.md",
      "!package-lock.json",
      "!yarn.lock",
      "!pnpm-lock.yaml",
      "!.git",
      "!.vscode",
      "!node_modules/.cache",
      "!dist"
    ],
    "mac": {
      "category": "public.app-category.productivity",
      "icon": "build-resources/icon.icns",
      "hardenedRuntime": true,
      "gatekeeperAssess": false,
      "entitlements": "build-resources/entitlements.mac.plist",
      "entitlementsInherit": "build-resources/entitlements.mac.plist",
      "target": [
        {
          "target": "dmg",
          "arch": ["x64", "arm64"]
        },
        {
          "target": "zip",
          "arch": ["x64", "arm64"]
        }
      ]
    },
    "dmg": {
      "contents": [
        {
          "x": 410,
          "y": 150,
          "type": "link",
          "path": "/Applications"
        },
        {
          "x": 130,
          "y": 150,
          "type": "file"
        }
      ]
    },
    "win": {
      "icon": "build-resources/icon.ico",
      "target": [
        {
          "target": "nsis",
          "arch": ["x64", "ia32"]
        },
        {
          "target": "msi",
          "arch": ["x64", "ia32"]
        },
        {
          "target": "zip",
          "arch": ["x64", "ia32"]
        }
      ]
    },
    "nsis": {
      "oneClick": false,
      "installerIcon": "build-resources/icon.ico",
      "uninstallerIcon": "build-resources/icon.ico",
      "installerHeaderIcon": "build-resources/icon.ico",
      "allowToChangeInstallationDirectory": true,
      "perMachine": false,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "shortcutName": "YourAppName"
    },
    "msi": {
      "oneClick": false,
      "perMachine": false,
      "createDesktopShortcut": true,
      "createStartMenuShortcut": true,
      "upgradeCode": "YOUR-UNIQUE-GUID-HERE"
    },
    "linux": {
      "icon": "build-resources/icons",
      "category": "Utility",
      "target": [
        {
          "target": "AppImage",
          "arch": ["x64"]
        },
        {
          "target": "deb",
          "arch": ["x64"]
        },
        {
          "target": "rpm",
          "arch": ["x64"]
        },
        {
          "target": "snap",
          "arch": ["x64"]
        }
      ],
      "desktop": {
        "StartupNotify": "true",
        "Encoding": "UTF-8",
        "Icon": "yourapp",
        "Type": "Application",
        "Categories": "Utility;"
      }
    },
    "deb": {
      "depends": [
        "libgtk-3-0",
        "libnotify4",
        "libnss3",
        "libxss1",
        "libxtst6",
        "xdg-utils",
        "libatspi2.0-0",
        "libuuid1",
        "libsecret-1-0"
      ]
    },
    "rpm": {
      "depends": [
        "gtk3",
        "libnotify",
        "nss",
        "libXScrnSaver",
        "libXtst",
        "xdg-utils",
        "at-spi2-core",
        "libuuid",
        "libsecret"
      ]
    },
    "snap": {
      "grade": "stable",
      "summary": "Your app summary"
    },
    "appImage": {
      "systemIntegration": "ask"
    },
    "publish": [
      {
        "provider": "github",
        "owner": "your-github-username",
        "repo": "your-repo-name"
      }
    ]
  },
  "devDependencies": {
    "electron": "^27.0.0",
    "electron-builder": "^24.0.0"
  }
}
```

## Setting Up Icons and Resources

Create a `build-resources` directory with the following structure:

```
build-resources/
├── icon.icns           # macOS icon (1024x1024)
├── icon.ico            # Windows icon (256x256)
├── icons/              # Linux icons
│   ├── 16x16.png
│   ├── 32x32.png
│   ├── 48x48.png
│   ├── 64x64.png
│   ├── 128x128.png
│   ├── 256x256.png
│   └── 512x512.png
└── entitlements.mac.plist  # macOS entitlements
```

## macOS Entitlements File (entitlements.mac.plist)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
```

## Final Setup Steps

1. **Set executable permissions** for all shell scripts:
```bash
chmod +x compile-build-dist.sh
chmod +x run-macos-source.sh
chmod +x run-macos.sh
chmod +x run-linux-source.sh
chmod +x run-linux.sh
```

2. **Install required dependencies**:
```bash
npm install --save-dev electron electron-builder
```

3. **Create icon files** in the `build-resources` directory

4. **Test the build system**:
```bash
# Quick test for current platform
./compile-build-dist.sh --quick

# Full multi-platform build
./compile-build-dist.sh
```

## Additional Notes

- **Windows MSI**: Requires WiX Toolset installed on Windows for MSI generation
- **Linux Snap**: Requires snapcraft installed for snap package creation
- **Code Signing**: Add certificates for production releases
- **Auto-Update**: Configure GitHub releases or other update servers
- **CI/CD**: These scripts work with GitHub Actions, CircleCI, Travis CI, etc.

This complete build system provides:
- ✅ All platform support (macOS Intel/ARM, Windows x64/x86, Linux x64)
- ✅ All installer types (.dmg, .exe, .msi, .deb, .rpm, .AppImage, .snap)
- ✅ Development and production run scripts for all platforms
- ✅ Comprehensive error handling and status reporting
- ✅ Auto-update support files
- ✅ Professional build output with color-coded messages

## Python Projects - Compile Build System (For Python Projects)
For Python projects, use these standard scripts:

#### compile-build-dist.sh
```bash
#!/bin/bash
# Creates dist/ folder with compiled binaries for all platforms
# Usage: ./compile-build-dist.sh [--platform macos-intel|macos-arm64|windows|linux|all]

# Key features:
# - Creates virtual environment
# - Installs all dependencies
# - Uses PyInstaller for compilation
# - Generates platform-specific binaries
# - Creates installers (DMG, AppImage, EXE)
```

#### run-python-source.sh
```bash
#!/bin/bash
# Runs Python app from source with virtual environment
# Automatically installs dependencies
# Multiple entry points supported
```

#### run-python.sh
```bash
#!/bin/bash
# Runs compiled binary from dist/ folder
# Auto-detects platform
# Falls back to any available binary
```

**Python Build Output Structure**:
```
dist/
├── macos-intel/            # macOS Intel build
│   └── AppName.app/        # macOS app bundle
├── macos-arm64/            # macOS ARM64 build
│   └── AppName.app/        # macOS app bundle
├── windows/                # Windows build
│   └── AppName.exe         # Windows executable
├── linux/                  # Linux build
│   └── AppName             # Linux binary
├── installers/             # Platform installers
│   ├── AppName-1.0.0-intel.dmg
│   ├── AppName-1.0.0-arm64.dmg
│   ├── AppName-1.0.0-setup.exe
│   └── AppName-1.0.0.AppImage
└── build-info.json         # Build metadata
```

### SPECIAL INSTRUCTIONS

1. **PRESERVE**: Never delete without asking:
   - Any custom configuration
   - Existing documentation
   - .env files (but create .env.example)
   - Database files
   - User data

2. **ARCHIVE**: Move to `archive/` folder:
   - Old versions
   - Deprecated code
   - Backup files
   - .bak files

3. **INTELLIGENT DECISIONS**:
   - If unsure about file purpose, ask before moving
   - Detect monorepo structures and adapt accordingly
   - Recognize existing conventions and note conflicts
   - If project already well-organized, only add missing pieces

4. **REPORT**:
   After completion, provide:
   - Summary of changes made
   - Any files that couldn't be categorized
   - Suggestions for further improvements
   - Warnings about potential breaking changes

---

## USAGE INSTRUCTIONS FOR USER

1. Navigate to your project root directory
2. Copy this entire prompt
3. Paste to Claude and add: "Please standardize this project structure"
4. Review Claude's discovery findings
5. Approve the reorganization plan
6. Let Claude execute the changes
7. Verify your project still runs

## CUSTOMIZATION

You can append specific requirements:
- "...and use snake_case for all files"
- "...and set up for TypeScript"
- "...and prepare for Docker deployment"
- "...but keep my existing folder names"
- "...and add GitHub Actions for [specific need]"

---

END OF PROMPT - EXECUTE STANDARDIZATION NOW