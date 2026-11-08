#!/bin/bash
# ==============================================================================
# scripts/setup-pm2.sh - Native Node.js PM2 Setup for notion-hugo-pipeline
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"

echo "=== 1. Checking Node.js Environment ==="
node --version
npm --version

echo ""
echo "=== 2. Starting Worker Daemon with PM2 ==="
# Remove old process if registered
pm2 delete notion-hugo-pipeline 2>/dev/null || true

# Start natively via ecosystem.config.cjs
pm2 start ecosystem.config.cjs

echo ""
echo "=== 3. Saving PM2 Process List ==="
pm2 save

echo ""
echo "=== 4. Worker Status ==="
pm2 status notion-hugo-pipeline

echo ""
echo "=============================================================================="
echo "Worker daemon 'notion-hugo-pipeline' is now running via PM2!"
echo ""
echo "Helpful commands:"
echo "  pm2 logs notion-hugo-pipeline       # View live logs"
echo "  pm2 restart notion-hugo-pipeline    # Restart worker daemon"
echo "  pm2 stop notion-hugo-pipeline       # Stop worker daemon"
echo "  pm2 startup                         # Generate systemd startup hook for reboots"
echo "=============================================================================="

