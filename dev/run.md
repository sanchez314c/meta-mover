# Run Instructions

## Quick Start

### Running from Source (Development)
```bash
# Setup environment (first time only)
./scripts/setup-hybrid.sh
./scripts/activate-dev.sh

# Install dependencies (if not done)
npm install

# Start development mode
npm run dev
```

### Running Built Application
```bash
# Build first
npm run build

# Run built app
npm run start
```

## Platform-Specific Run Scripts

### macOS

#### From Source
```bash
#!/bin/bash
# run-macos-source.sh
export NODE_ENV=development
source ./scripts/activate-dev.sh
npm run dev
```

#### Production Build
```bash
#!/bin/bash
# run-macos.sh
npm run build
npm run start
```

### Windows

#### From Source
```batch
@echo off
REM run-windows-source.bat
set NODE_ENV=development
call scripts\activate-dev.sh
npm run dev
```

#### Production Build  
```batch
@echo off
REM run-windows.bat
npm run build
npm run start
```

### Linux

#### From Source
```bash
#!/bin/bash
# run-linux-source.sh
export NODE_ENV=development
source ./scripts/activate-dev.sh
npm run dev
```

#### Production Build
```bash
#!/bin/bash
# run-linux.sh
npm run build
npm run start
```

## Development Modes

### Hot Reload Development
```bash
npm run dev              # Full hot reload with DevTools
```

### Production Testing
```bash
npm run build           # Build for production
npm run start          # Test production build locally
```

### Debug Mode
```bash
npm run dev:debug      # Start with Chrome DevTools open
```

## Environment Variables

### Development
```bash
NODE_ENV=development    # Enable development features
DEBUG_PROD=true        # Debug production builds
```

### Production
```bash
NODE_ENV=production    # Production optimizations
```

## Troubleshooting

### Port Conflicts
```bash
# If port 3000 is in use
PORT=3001 npm run dev
```

### Memory Issues
```bash
# Increase Node.js memory limit
NODE_OPTIONS="--max-old-space-size=4096" npm run dev
```

### Clean Start
```bash
# Clear all caches and restart
npm run clean
rm -rf node_modules package-lock.json
npm install
npm run dev
```

### GPU Acceleration (macOS)
```bash
# Enable Metal GPU acceleration
export METAL_DEVICE_WRAPPER_TYPE=1
npm run dev
```

## Performance Tips

### Development
- Use `npm run dev` for fastest iteration
- Enable GPU acceleration on macOS
- Close unnecessary applications to free memory

### Production Testing
- Always test with `npm run build && npm run start` before releasing
- Monitor memory usage with large file collections
- Test with sample datasets first