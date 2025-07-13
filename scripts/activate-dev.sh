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
