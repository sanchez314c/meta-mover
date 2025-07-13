#!/bin/bash

# META_Mover - Hybrid Environment Setup
# Uses Conda for Python/build tools + System Node.js for compatibility

set -e

echo "🐍 Setting up META_Mover hybrid development environment..."
echo "   • Conda: Python, build tools, native libraries"
echo "   • System: Node.js $(node --version) + npm $(npm --version)"

# Check prerequisites
if ! command -v conda &> /dev/null; then
    echo "❌ Conda not found. Please install Miniconda or Anaconda."
    exit 1
fi

if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 16+ from nodejs.org"
    exit 1
fi

# Remove existing environment
if /Users/heathen-admin/miniconda3/bin/conda env list | grep -q "metamover-dev"; then
    echo "📦 Removing existing environment..."
    /Users/heathen-admin/miniconda3/bin/conda env remove -n metamover-dev -y
fi

# Create hybrid environment
echo "📦 Creating hybrid conda environment..."
/Users/heathen-admin/miniconda3/bin/conda env create -f environment-hybrid.yml

# Create activation script
echo "📝 Creating activation script..."
cat > activate-dev.sh << 'EOF'
#!/bin/bash
echo "🚀 Activating META_Mover hybrid development environment..."

# Activate conda environment (for Python/build tools)
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate metamover-dev

# Verify environment
echo "✅ Environment activated!"
echo "📦 Node.js: $(node --version) (system)"
echo "📦 npm: $(npm --version) (system)"
echo "📦 Python: $(python --version) (conda)"

# Set up local npm config for this project
npm config set prefix "$CONDA_PREFIX"
export PATH="$CONDA_PREFIX/bin:$PATH"

echo "🚀 Ready to develop! Run: npm run dev"
EOF

chmod +x activate-dev.sh

# Activate and install dependencies
echo "⚡ Activating environment and installing dependencies..."
source /Users/heathen-admin/miniconda3/etc/profile.d/conda.sh
conda activate metamover-dev

# Install npm dependencies
echo "📦 Installing npm dependencies..."
npm install

echo ""
echo "✅ Setup complete! Hybrid environment ready."
echo ""
echo "🏗️  Architecture:"
echo "   • Python/Build Tools: Conda environment (self-contained)"
echo "   • Node.js/npm: System installation ($(node --version))"
echo "   • Project Dependencies: Local node_modules"
echo ""
echo "📋 Next steps:"
echo "   1. Activate: ./activate-dev.sh"
echo "   2. Develop: npm run dev"
echo ""