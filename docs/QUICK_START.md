# Quick Start Guide

Get META Mover running in 5 minutes.

## Prerequisites

- Node.js 18.0.0 or higher
- npm 9.0.0 or higher

## Installation

### 1. Clone Repository

```bash
git clone https://github.com/sanchez314c/meta-mover.git
cd meta-mover
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Launch Application

```bash
npm run dev
```

The application will build and launch automatically.

## First Use

### Basic Workflow

1. **Select Source Folder**
   - Click "Select Source" button
   - Choose the folder containing media files to organize

2. **Set Destination Folder**
   - Click "Select Destination" button
   - Choose where organized files should be placed

3. **Configure Options**
   - Date format: YYYY-MM-DD or custom format
   - Duplicate handling: Skip, Replace, or Rename
   - Corruption detection: Enable/Disable

4. **Start Processing**
   - Click "Start" button
   - Monitor progress in real-time
   - Review results when complete

### Platform-Specific Run Scripts

#### Linux

```bash
./run-source-linux.sh
```

#### macOS

```bash
./run-source-mac.sh
```

#### Windows

```bat
run-source-windows.bat
```

## Development Workflow

### Watch Mode

For active development with auto-reload:

```bash
npm run watch
```

### Production Build

To test production builds locally:

```bash
npm run build
npm start
```

## Common Tasks

### Run Tests

```bash
npm test
```

### Check Code Quality

```bash
npm run lint
npm run typecheck
```

### Format Code

```bash
npm run format
```

## Next Steps

- Read the [Development Guide](./DEVELOPMENT.md) for detailed setup
- Review [Workflow Guide](./WORKFLOW.md) for best practices
- Check [API Documentation](./API.md) for architecture details

## Troubleshooting

### Build Fails

```bash
npm run clean:all
npm install
npm run build:dev
```

### Electron Won't Launch

Ensure Node.js version is 18.0.0 or higher:

```bash
node --version
```

### Permission Issues on Linux

```bash
chmod +x run-source-linux.sh
```

## Support

- Issues: https://github.com/sanchez314c/meta-mover/issues
- Documentation: https://github.com/sanchez314c/meta-mover#readme
