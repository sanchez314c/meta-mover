# Installation Guide

## Quick Install (Recommended)

### macOS
1. Download the latest `.dmg` file from releases
2. Open the DMG and drag META_Mover to Applications
3. Launch from Applications folder

### Windows
1. Download the latest `.exe` installer from releases
2. Run the installer as Administrator
3. Follow the installation wizard
4. Launch from Start Menu or Desktop shortcut

### Linux (Ubuntu/Debian)
```bash
# Download and install DEB package
wget https://github.com/user/META_Mover/releases/latest/download/metamover_x.x.x_amd64.deb
sudo dpkg -i metamover_x.x.x_amd64.deb

# Install dependencies if needed
sudo apt-get install -f
```

### Linux (Other Distributions)
```bash
# Download AppImage (portable)
wget https://github.com/user/META_Mover/releases/latest/download/META_Mover-x.x.x.AppImage
chmod +x META_Mover-x.x.x.AppImage
./META_Mover-x.x.x.AppImage
```

## Development Installation

### Prerequisites
- Node.js v18+ (v23.11.0 recommended)
- Python 3.8+ (via Conda recommended)
- Git

### Clone and Setup
```bash
# Clone repository
git clone https://github.com/user/META_Mover.git
cd META_Mover

# Setup hybrid development environment
./scripts/setup-hybrid.sh

# Activate environment
./scripts/activate-dev.sh

# Install dependencies
npm install

# Start development server
npm run dev
```

## System Requirements

### Minimum Requirements
- **RAM**: 4GB
- **Storage**: 500MB free space
- **CPU**: Dual-core 2.0GHz+
- **OS**: 
  - macOS 10.15+ (Catalina)
  - Windows 10+
  - Ubuntu 18.04+ / Debian 10+

### Recommended Requirements
- **RAM**: 8GB+
- **Storage**: 2GB free space
- **CPU**: Quad-core 2.5GHz+
- **GPU**: Dedicated graphics (for large media processing)

## External Dependencies

### Required
- **Node.js**: Included in packaged builds
- **Electron**: Bundled with application

### Optional (Enhanced Features)
- **FFmpeg**: For advanced video processing
- **ExifTool**: For enhanced metadata extraction (legacy support)

## Verification

### Test Installation
```bash
# For development builds
npm run test

# For installed applications
# Launch application and check "About" dialog for version info
```

### Troubleshooting

#### Permission Issues (macOS)
```bash
# If app is blocked by Gatekeeper
xattr -d com.apple.quarantine /Applications/META_Mover.app
```

#### Missing Dependencies (Linux)
```bash
# Install required libraries
sudo apt-get install libnss3 libatk-bridge2.0-0 libdrm2 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libxss1 libasound2
```

#### Antivirus False Positives (Windows)
- Add META_Mover installation directory to antivirus exclusions
- Whitelist the executable if flagged during download