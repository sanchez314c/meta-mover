# Build Instructions

## Prerequisites

### System Requirements
- Node.js v18+ (Currently using v23.11.0)
- Python 3.8+ (for build tools via Conda)
- Git

### Development Environment Setup
```bash
# Setup hybrid environment (Conda for Python/build tools + System Node.js)
./scripts/setup-hybrid.sh

# Activate environment for each terminal session
./scripts/activate-dev.sh

# Clean install if needed
rm -rf node_modules package-lock.json && npm install
```

## Build Commands

### Development
```bash
npm run dev              # Start development server with hot reload
npm run start           # Run the built application
```

### Production Build
```bash
npm run build           # Build for production
npm run dist            # Create platform-specific installers
npm run pack            # Package without installer
```

### Testing & Quality
```bash
npm run test            # Run test suite
npm run test:coverage   # Run with coverage report
npm run verify          # Run all quality checks
npm run lint            # Lint and fix code
npm run typecheck       # TypeScript checking
npm run format          # Format with Prettier
```

## Platform-Specific Builds

### macOS
- **Output**: DMG installer and .app bundle
- **Requirements**: macOS 10.15+ (Catalina)
- **Command**: `npm run dist:mac`

### Windows
- **Output**: EXE installer and portable executable
- **Requirements**: Windows 10+
- **Command**: `npm run dist:win`

### Linux
- **Output**: DEB package and AppImage
- **Requirements**: Ubuntu 18.04+, Debian 10+
- **Command**: `npm run dist:linux`

## Build Outputs
- `dist/`: Contains all build artifacts and installers
- `dist/mac/`: macOS builds (.app, .dmg)
- `dist/win/`: Windows builds (.exe installer, portable)
- `dist/linux/`: Linux builds (.deb, .AppImage)

## Troubleshooting

### Clean Build
```bash
npm run clean           # Clean all build artifacts
rm -rf node_modules dist && npm install
npm run build
```

### Environment Issues
```bash
# Reset hybrid environment
./scripts/setup-hybrid.sh --reset
source ./scripts/activate-dev.sh
```

### Platform-Specific Issues
- **macOS**: Ensure Xcode command line tools installed
- **Windows**: Ensure Windows SDK available
- **Linux**: Install build-essential package