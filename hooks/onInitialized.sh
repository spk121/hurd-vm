#!/usr/bin/env sh

# Runs in the VM after all files have been synced and the workdir symlink is set up.

echo "==> onInitialized: workspace contents"
ls -lah "$GITHUB_WORKSPACE"

echo "==> onInitialized: disk usage"
df -h

