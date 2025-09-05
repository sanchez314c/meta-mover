# Installation Guide

Complete installation instructions for META Mover v1.0.

## Table of Contents
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Development Setup](#development-setup)
- [Production Build](#production-build)
- [Troubleshooting](#troubleshooting)

## Prerequisites

### Required Software
- **Node.js**: v18.0.0 or higher
- **npm**: v9.0.0 or higher
- **Git**: For cloning the repository

### Platform Requirements

#### macOS
- macOS 10.15 (Catalina) or higher
- Xcode Command Line Tools
- Administrator privileges (for installation)

#### Windows
- Windows 10 or higher (x64, ia32, arm64)
- Visual Studio Build Tools (for native modules)
- Administrator privileges

#### Linux
- Ubuntu 18.04+ / Debian 10+ / Fedora 32+ / equivalent
- gcc/g++ compilers
- libgtk-3-dev and related dependencies
- Administrator privileges (via sudo)

## Installation

### From Source

```bash
# Clone the repository
git clone https://github.com/sanchez314c/meta-mover.git
cd meta-mover

# Install dependencies
npm install

# Run in development mode
npm run dev
```

### From Release

#### macOS
1. Download the latest `.dmg` or `.pkg` file from [Releases](https://github.com/sanchez314c/meta-mover/releases)
2. Open the downloaded file
3. Drag META Mover to Applications folder
4. Launch from Applications

#### Windows
1. Download the latest `.exe` or `.msi` installer from [Releases](https://github.com/sanchez314c/meta-mover/releases)
2. Run the installer
3. Follow the installation wizard
4. Launch from Start Menu or desktop shortcut

#### Linux
```bash
# Download and run AppImage (universal)
chmod +x META-Mover-*.AppImage
./META-Mover-*.AppImage

# Or install deb package (Debian/Ubuntu)
sudo dpkg -i META-Mover-*.deb

# Or install rpm package (Fedora/RHEL)
sudo rpm -i META-Mover-*.rpm
```

## Development Setup

### First Time Setup

```bash
# Clone repository
git clone https://github.com/sanchez314c/meta-mover.git
cd meta-mover

# Install dependencies
npm install

# Run development server
npm run dev
```

### Development Commands

```bash
# Development with hot reload
npm run dev

# Build all components
npm run build

# Run tests
npm run test

# Type checking
npm run typecheck

# Linting
npm run lint

# Format code
npm run format
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for complete development guidelines.

## Production Build

### Building for Distribution

```bash
# Build for current platform
npm run dist

# Build for specific platforms
npm run dist:mac      # macOS
npm run dist:win      # Windows
npm run dist:linux    # Linux

# Build specific formats
npm run dist:mac:dmg      # macOS DMG
npm run dist:win:nsis     # Windows NSIS installer
npm run dist:linux:deb    # Linux Debian package
```

Output files are created in the `release/` directory.

## Troubleshooting

### Common Issues

#### "Cannot find module" errors
```bash
# Clean install
rm -rf node_modules package-lock.json
npm install
```

#### Native module build failures
```bash
# Rebuild native modules
npm rebuild

# Or use electron-rebuild
npm run rebuild
```

#### TypeScript path mapping errors
```bash
# Verify tsconfig.json paths
npm run typecheck
```

#### Electron won't start
```bash
# Clean all build artifacts
npm run clean:all

# Reinstall
npm install
npm run dev
```

### Platform-Specific Issues

#### macOS
- **"App is damaged" error**: Right-click → Open → Open anyway
- **Notarization issues**: Set `notarize: false` in electron-builder config
- **Code signing**: Provide valid Apple Developer certificates

#### Windows
- **Windows Defender blocking**: Add exclusion for META Mover
- **Antivirus false positives**: Digital signature required for distribution

#### Linux
- **Missing dependencies**: Install platform-specific libraries
  ```bash
  sudo apt-get install libgtk-3-dev libnotify-dev libnss3-dev
  ```
- **AppImage won't run**: Make executable with `chmod +x`

### Getting Help

- Check existing [GitHub Issues](https://github.com/sanchez314c/meta-mover/issues)
- Review [Troubleshooting Guide](../README.md#troubleshooting)
- Create a new issue with:
  - Platform and version
  - Error messages
  - Steps to reproduce
  - Expected vs actual behavior

---

*For more information, see [DEPLOYMENT_GUIDE.md](DEPLOYMENT_GUIDE.md)*
