#!/bin/bash

# META_Mover Development Environment Setup
# Self-contained environment with Conda integration

set -e

echo "🚀 Setting up META_Mover development environment..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Check if conda is available
if ! command -v conda &> /dev/null; then
    print_error "Conda is not installed or not in PATH"
    print_error "Please install Miniconda or Anaconda first"
    print_error "Visit: https://docs.conda.io/en/latest/miniconda.html"
    exit 1
fi

print_success "Conda found: $(conda --version)"

# Check if environment already exists
if conda env list | grep -q "metamover-dev"; then
    print_warning "Environment 'metamover-dev' already exists"
    read -p "Do you want to remove and recreate it? [y/N]: " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        print_status "Removing existing environment..."
        conda env remove -n metamover-dev -y
    else
        print_status "Using existing environment..."
        conda activate metamover-dev
        exit 0
    fi
fi

# Create conda environment from file
print_status "Creating conda environment from environment.yml..."
conda env create -f environment.yml

print_success "Conda environment 'metamover-dev' created successfully!"

# Activate environment
print_status "Activating environment..."
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate metamover-dev

# Verify Node.js installation
print_status "Verifying Node.js installation..."
node_version=$(node --version)
npm_version=$(npm --version)
print_success "Node.js: $node_version"
print_success "npm: $npm_version"

# Set npm configuration for local environment
print_status "Configuring npm for local environment..."
npm config set prefix "$CONDA_PREFIX"
npm config set cache "$CONDA_PREFIX/.npm"
npm config set tmp "$CONDA_PREFIX/tmp"

# Create necessary directories
mkdir -p "$CONDA_PREFIX/.npm"
mkdir -p "$CONDA_PREFIX/tmp"

# Install global development tools in conda environment
print_status "Installing global development tools..."
npm install -g electron@latest
npm install -g electron-builder@latest
npm install -g typescript@latest
npm install -g concurrently@latest

# Install project dependencies
print_status "Installing project dependencies..."
npm install

# Set up pre-commit hooks (if git repo)
if [ -d ".git" ]; then
    print_status "Setting up git hooks..."
    
    # Create pre-commit hook
    cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash
# Pre-commit hook for META_Mover

echo "Running pre-commit checks..."

# Check if conda environment is active
if [[ "$CONDA_DEFAULT_ENV" != "metamover-dev" ]]; then
    echo "Error: metamover-dev conda environment is not active"
    echo "Please run: conda activate metamover-dev"
    exit 1
fi

# Run linting
echo "Running ESLint..."
npm run lint
if [ $? -ne 0 ]; then
    echo "ESLint failed. Please fix the issues before committing."
    exit 1
fi

# Run type checking
echo "Running TypeScript type checking..."
npm run typecheck
if [ $? -ne 0 ]; then
    echo "TypeScript type checking failed. Please fix the issues before committing."
    exit 1
fi

# Run tests
echo "Running tests..."
npm run test
if [ $? -ne 0 ]; then
    echo "Tests failed. Please fix the issues before committing."
    exit 1
fi

echo "Pre-commit checks passed!"
EOF
    
    chmod +x .git/hooks/pre-commit
    print_success "Git pre-commit hook installed"
fi

# Create activation script for easy environment setup
cat > activate-dev.sh << 'EOF'
#!/bin/bash
# Activate META_Mover development environment

echo "🚀 Activating META_Mover development environment..."

# Activate conda environment
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate metamover-dev

# Verify environment
if [[ "$CONDA_DEFAULT_ENV" == "metamover-dev" ]]; then
    echo "✅ Environment activated successfully!"
    echo "Node.js: $(node --version)"
    echo "npm: $(npm --version)"
    echo "Electron: $(npx electron --version)"
    echo ""
    echo "Available commands:"
    echo "  npm run dev          - Start development server"
    echo "  npm run build        - Build for production"
    echo "  npm run test         - Run test suite"
    echo "  npm run lint         - Run code linting"
    echo "  npm run typecheck    - Run TypeScript checking"
    echo "  npm run dist         - Create distributable packages"
    echo ""
else
    echo "❌ Failed to activate environment"
    exit 1
fi
EOF

chmod +x activate-dev.sh

# Create development configuration
cat > .env.development << EOF
# Development Environment Configuration
NODE_ENV=development
ELECTRON_ENV=development

# Enable development features
ELECTRON_IS_DEV=true
DEBUG=metamover:*

# Hot reload settings
WEBPACK_DEV_SERVER_PORT=3000
ELECTRON_RELOAD=true

# Logging
LOG_LEVEL=debug
LOG_TO_FILE=false

# Performance monitoring
ENABLE_PERFORMANCE_MONITORING=true
EOF

print_success "Development environment setup complete!"
print_status ""
print_status "🎉 Next steps:"
print_status "1. Run: source activate-dev.sh"
print_status "2. Run: npm run dev"
print_status ""
print_status "📝 Available commands:"
print_status "  npm run dev      - Start development server with hot reload"
print_status "  npm run build    - Build for production"
print_status "  npm run test     - Run comprehensive test suite"
print_status "  npm run dist     - Create distributable packages"
print_status ""
print_warning "Note: Always activate the conda environment before working:"
print_warning "  conda activate metamover-dev"
print_status ""

# Final verification
print_status "Environment verification:"
echo "  📁 Conda environment: $CONDA_DEFAULT_ENV"
echo "  🟢 Node.js: $(node --version)"
echo "  📦 npm: $(npm --version)"
echo "  ⚡ Electron: $(npx electron --version 2>/dev/null || echo 'Installing...')"
echo "  🔧 TypeScript: $(npx tsc --version)"

print_success "🎉 META_Mover development environment is ready!"