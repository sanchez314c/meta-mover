# META Mover - Troubleshooting Guide

## Electron Sandbox Crash on Linux

**Problem:** Application crashes on startup with `credentials.cc: Permission denied` error.

**Solution:**
```bash
# Temporary fix (requires sudo)
sudo sysctl -w kernel.unprivileged_userns_clone=1

# OR launch with sandbox disabled
npm start -- --no-sandbox
```

**Permanent fix:** Add to `/etc/sysctl.conf`:
```
kernel.unprivileged_userns_clone=1
```

## Node.js Version Mismatch

**Problem:** Build errors or runtime failures due to Node.js version incompatibility.

**Solution:**
```bash
# Install nvm if not present
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# Use project-specified version
nvm install 18
nvm use 18

# Verify version
node --version  # Should show v18.x.x
```

The project requires Node.js 18 or later (see `.nvmrc`).

## npm install Fails with Native Modules

**Problem:** Installation fails during native module compilation (`sharp`, `sqlite3`, etc.).

**Solution:**

**Linux:**
```bash
# Install build dependencies
sudo apt-get install -y build-essential python3 libvips-dev

# Rebuild native modules
npm run rebuild
```

**macOS:**
```bash
# Install Xcode Command Line Tools
xcode-select --install

# Rebuild native modules
npm run rebuild
```

**Windows:**
```powershell
# Install windows-build-tools (run as Administrator)
npm install --global windows-build-tools

# Rebuild native modules
npm run rebuild
```

## sharp Build Failures

**Problem:** `sharp` module fails to build or install platform-specific binaries.

**Solution:**
```bash
# Clean sharp cache
rm -rf node_modules/sharp

# Reinstall with verbose logging
npm install sharp --verbose

# If prebuilt binaries fail, force source build
npm install sharp --build-from-source
```

**Platform-specific issues:**
- **Linux:** Install `libvips-dev` (Ubuntu/Debian) or `vips` (Arch)
- **macOS:** Use Homebrew: `brew install vips`
- **Windows:** Prebuilt binaries should work; ensure Visual Studio Build Tools are installed

## sqlite3 Build Issues

**Problem:** `sqlite3` fails to compile during installation.

**Solution:**
```bash
# Ensure Python is available (required by node-gyp)
python3 --version

# Clean and rebuild
rm -rf node_modules/sqlite3
npm install sqlite3

# If build fails, use prebuilt binaries
npm install sqlite3 --build-from-source=false
```

**Note:** `node-gyp` requires Python 3.6+ and appropriate C++ build tools.

## Memory Issues with Large Collections

**Problem:** Application becomes unresponsive or crashes when processing large media collections.

**Solution:**

**Adjust Node.js memory limit:**
```bash
# Increase heap size (8GB example)
export NODE_OPTIONS="--max-old-space-size=8192"
npm start
```

**Configure batch processing:**
1. Open application settings
2. Navigate to Performance section
3. Reduce concurrent operations (default: 4, try: 2)
4. Lower batch size (default: 100, try: 50)

**System recommendations:**
- 8GB RAM minimum for collections over 5,000 files
- 16GB RAM recommended for collections over 20,000 files

## Permission Denied on macOS

**Problem:** Application cannot access media folders or external drives.

**Solution:**

**Grant Full Disk Access:**
1. Open System Preferences > Security & Privacy
2. Select Privacy tab
3. Click Full Disk Access
4. Add META Mover application
5. Restart the application

**For external drives:**
- Ensure drives are mounted with read/write permissions
- Check disk format (NTFS may require additional drivers)

## DevTools Access

**Development mode:**
```bash
npm start  # DevTools open automatically
```

**Production build:**
- Linux/Windows: Press `Ctrl+Shift+I`
- macOS: Press `Cmd+Option+I`

**Enable DevTools in production:**
Edit `src/main/main.ts` and set:
```typescript
mainWindow = new BrowserWindow({
  webPreferences: {
    devTools: true  // Force enable
  }
});
```

## Build Failures

**Problem:** Build process fails with dependency or compilation errors.

**Solution:**

**Clean slate rebuild:**
```bash
# Remove all build artifacts and dependencies
npm run clean:all

# Fresh install
npm install

# Rebuild native modules for Electron
npm run rebuild

# Attempt build
npm run build
```

**Specific build targets:**
```bash
# Linux
npm run build:linux

# macOS
npm run build:mac

# Windows
npm run build:win
```

**Common issues:**
- Ensure `electron-builder` dependencies are installed
- Check disk space (builds require several GB)
- Verify write permissions in project directory

## Log File Locations

**Development:**
- Linux: `~/.config/meta-mover/logs/`
- macOS: `~/Library/Logs/meta-mover/`
- Windows: `%APPDATA%\meta-mover\logs\`

**Production:**
Same locations as development, but use production log files.

**Enable verbose logging:**
Set environment variable before starting:
```bash
export DEBUG=metamover:*
npm start
```

## Database Corruption

**Problem:** Application fails to start or crashes with database errors.

**Solution:**
```bash
# Locate database file
# Linux: ~/.config/meta-mover/database.db
# macOS: ~/Library/Application Support/meta-mover/database.db
# Windows: %APPDATA%\meta-mover\database.db

# Backup existing database
cp database.db database.db.backup

# Remove corrupted database (will be recreated)
rm database.db

# Restart application
npm start
```

**Note:** Removing the database will lose cached metadata and duplicate detection history. Original media files are unaffected.

## Still Having Issues?

1. Check existing GitHub issues: https://github.com/username/meta-mover/issues
2. Review log files for error details
3. Create a new issue with:
   - Operating system and version
   - Node.js version
   - Complete error message
   - Steps to reproduce
   - Relevant log excerpts
