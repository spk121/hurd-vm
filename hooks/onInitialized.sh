#!/usr/bin/env sh

# Runs in the VM after all files have been synced and the workdir symlink is set up.
# When sync: no is used, GITHUB_WORKSPACE may not exist in the VM — skip those checks.

if [ -n "${GITHUB_WORKSPACE:-}" ] && [ -d "$GITHUB_WORKSPACE" ]; then
  echo "==> onInitialized: workspace contents"
  ls -lah "$GITHUB_WORKSPACE"
fi

echo "==> onInitialized: disk usage"
df -h
