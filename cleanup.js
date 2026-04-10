import * as core from '@actions/core';
import * as fs from 'fs';

async function cleanup() {
  try {
    // Kill the QEMU process
    const pidFile = core.getState('pidFile');
    if (pidFile && fs.existsSync(pidFile)) {
      const pid = fs.readFileSync(pidFile, 'utf8').trim();
      if (pid) {
        core.info(`Shutting down QEMU (PID ${pid})...`);
        try {
          process.kill(parseInt(pid, 10), 'SIGTERM');
        } catch (e) {
          // Process may already be gone
          core.info(`QEMU process already exited: ${e.message}`);
        }
      }
      fs.unlinkSync(pidFile);
    }

    // Remove SSH key
    const sshKeyPath = core.getState('sshKeyPath');
    if (sshKeyPath) {
      for (const f of [sshKeyPath, `${sshKeyPath}.pub`]) {
        if (fs.existsSync(f)) {
          fs.unlinkSync(f);
        }
      }
    }

    core.info("Cleanup complete.");
  } catch (error) {
    core.warning(`Cleanup failed: ${error.message}`);
  }
}

cleanup();
