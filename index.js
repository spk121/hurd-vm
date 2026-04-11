import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as cache from '@actions/cache';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to expand shell-style variables
function expandVars(str, env) {
  if (!str) {
    return str;
  }
  return str.replace(/\$\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
    return env[key] || match;
  }).replace(/\$([a-zA-Z0-9_]+)/g, (match, key) => {
    return env[key] || match;
  });
}

// Parse shell-style config file
function parseConfig(filePath, initialEnv = {}) {
  if (!fs.existsSync(filePath)) {
    return initialEnv;
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const env = { ...initialEnv };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^([a-zA-Z0-9_]+)=(.*)$/);
    if (match) {
      const key = match[1];
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      value = expandVars(value, env);
      env[key] = value;
    }
  }
  return env;
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    core.info(`Downloading ${url} to ${dest}`);
    const file = fs.createWriteStream(dest);

    const handleResponse = (response) => {
      if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 307 || response.statusCode === 308) {
        if (response.headers.location) {
          core.info(`Redirecting to ${response.headers.location}`);
          https.get(response.headers.location, handleResponse).on('error', (err) => {
            fs.unlink(dest, () => { });
            reject(err);
          });
          return;
        }
      }

      if (response.statusCode !== 200) {
        fs.unlink(dest, () => { });
        reject(new Error(`Failed to download ${url}: Status Code ${response.statusCode}`));
        return;
      }

      response.pipe(file);
    };

    const request = https.get(url, handleResponse);

    request.on('error', (err) => {
      fs.unlink(dest, () => { });
      reject(err);
    });

    file.on('finish', () => {
      file.close(() => resolve());
    });

    file.on('error', (err) => {
      fs.unlink(dest, () => { });
      reject(err);
    });
  });
}

async function execSSH(cmd, sshConfig, ignoreReturn = false, silent = false) {
  core.info(`Exec SSH: ${cmd}`);

  const sshHost = sshConfig.host;
  const osName = sshConfig.osName;
  const work = sshConfig.work;
  const vmwork = sshConfig.vmwork;
  const userEnvNames = sshConfig.userEnvNames || [];

  const args = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
  ];

  let envExports = "";
  // For Hurd, the work path differs from the host — rewrite GITHUB_* paths
  if (work && vmwork && work !== vmwork) {
    const workRegex = new RegExp(work.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GITHUB_') || key === 'CI') {
        const val = process.env[key] || "";
        const newVal = val.replace(workRegex, vmwork);
        envExports += `export ${key}="${newVal}"\n`;
      }
    }
    // Also export user-specified env vars (with path rewriting)
    for (const key of userEnvNames) {
      if (key && !key.startsWith('GITHUB_') && key !== 'CI' && process.env[key] !== undefined) {
        const val = process.env[key] || "";
        const newVal = val.replace(workRegex, vmwork);
        envExports += `export ${key}="${newVal}"\n`;
      }
    }
  }

  try {
    const fullCmd = "set -eu\n" + envExports + cmd;
    await exec.exec("ssh", [...args, sshHost, "sh"], {
      input: Buffer.from(fullCmd),
      silent: silent
    });
  } catch (err) {
    if (!ignoreReturn) {
      throw err;
    }
  }
}

async function handleErrorWithDebug(sshHost, vncLink, debug) {
  const message = vncLink
    ? `Please open the remote vnc link for debugging: ${vncLink} . To finish debugging, you can run \`touch ~/continue\` in the VM.`
    : "Please open the remote vnc link for debugging. To finish debugging, you can run `touch ~/continue` in the VM.";

  core.warning(message);

  const args = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=3",
    sshHost
  ];

  core.info("Monitoring ~/continue file in the VM...");
  const continueFile = "~/continue";
  let finished = false;
  let counter = 0;
  while (!finished) {
    counter++;
    try {
      if (debug === 'true') {
        core.info(`[Debug] Checking for ${continueFile} in VM (Attempt ${counter})...`);
      }
      const exitCode = await exec.exec("ssh", [...args, `test -f ${continueFile}`], {
        silent: true,
        ignoreReturnCode: true,
      });

      if (exitCode === 0) {
        core.info(`${continueFile} found. Cleaning up and continuing...`);
        await exec.exec("ssh", [...args, `rm -f ${continueFile}`], { silent: true });
        finished = true;
      } else if (exitCode === 1) {
        await new Promise(r => setTimeout(r, 5000));
      } else {
        throw new Error("The VM has exited (SSH connection failed), so the debugging process is terminating.");
      }
    } catch (e) {
      throw new Error("The VM has exited, so the debugging process is terminating.");
    }
  }
}

async function install(sync, debug) {
  const start = Date.now();
  core.info("Installing dependencies...");
  if (process.platform === 'linux') {
    const pkgs = [
      "qemu-utils",
      "qemu-system-x86",
    ];

    if (sync === 'nfs') {
      pkgs.push("nfs-kernel-server");
    }

    const aptOpts = [
      "-o", "Acquire::Retries=3",
      "-o", "Dpkg::Options::=--force-confdef",
      "-o", "Dpkg::Options::=--force-confold",
      "-o", "Dpkg::Options::=--force-unsafe-io",
      "-o", "Acquire::Languages=none",
    ];

    await exec.exec("sudo", ["apt-get", "update", "-q"], { silent: true });
    await exec.exec("sudo", ["apt-get", "install", "-y", "-q", ...aptOpts, "--no-install-recommends", ...pkgs]);

    if (fs.existsSync('/dev/kvm')) {
      await exec.exec("sudo", ["chmod", "666", "/dev/kvm"]);
    }
  } else if (process.platform === 'darwin') {
    await exec.exec("brew", ["install", "qemu"]);
  } else if (process.platform === 'win32') {
    await exec.exec("choco", ["install", "qemu", "-y"]);
  }

  if (debug === 'true') {
    const elapsed = Date.now() - start;
    core.info(`install() took ${elapsed}ms`);
  }
}


async function scpToVM(sshHost, work, vmwork, debug) {
  core.info(`==> Ensuring ${vmwork} exists...`);
  await execSSH(`mkdir -p ${vmwork}`, { host: sshHost, osName: 'hurd', work, vmwork });

  core.info("==> Uploading files via scp (excluding _actions and _PipelineMapping)...");

  const items = await fs.promises.readdir(work, { withFileTypes: true });

  for (const item of items) {
    const itemName = item.name;
    if (itemName === "_actions" || itemName === "_PipelineMapping") {
      continue;
    }

    const localPath = path.join(work, itemName);
    const scpArgs = [
      "-O",
      "-r",
      "-p",
      "-o", "StrictHostKeyChecking=no",
      localPath,
      `${sshHost}:${vmwork}/`
    ];

    if (debug === 'true') {
      core.info(`Uploading: ${localPath} to ${sshHost}:${vmwork}/`);
    }
    await exec.exec("scp", scpArgs, { silent: debug !== 'true' });
  }

  core.info("==> Done.");
}

// Generate an SSH key pair for VM access
async function generateSSHKey(keyPath) {
  if (!fs.existsSync(keyPath)) {
    await exec.exec("ssh-keygen", ["-t", "ed25519", "-f", keyPath, "-N", "", "-C", "hurd-vm-action"]);
  }
  return fs.readFileSync(`${keyPath}.pub`, 'utf8').trim();
}

// Inject SSH public key into the Hurd disk image using qemu-nbd
async function prepareHurdImage(imagePath, sshKeyPub, debug) {
  core.info("Preparing Hurd image: injecting SSH key via qemu-nbd...");

  // Load the nbd kernel module with partition scanning support
  await exec.exec("sudo", ["modprobe", "nbd", "max_part=8"]);
  await new Promise(r => setTimeout(r, 1000));

  // Connect the image to the first available NBD device
  await exec.exec("sudo", ["qemu-nbd", "--format=raw", "--connect=/dev/nbd0", imagePath]);

  // Give the kernel time to read the partition table
  await new Promise(r => setTimeout(r, 2000));

  if (debug === 'true') {
    await exec.exec("sudo", ["fdisk", "-l", "/dev/nbd0"], { ignoreReturnCode: true });
  }

  await exec.exec("sudo", ["mkdir", "-p", "/mnt/hurd-root"]);

  // Hurd images commonly use p1 for swap and p2 for rootfs.
  // Try likely root partitions first, then fall back to the raw device.
  let mounted = false;
  for (const dev of ["/dev/nbd0p2", "/dev/nbd0p1", "/dev/nbd0"]) {
    const rc = await exec.exec("sudo", ["mount", dev, "/mnt/hurd-root"], { ignoreReturnCode: true });
    if (rc === 0) {
      core.info(`Mounted ${dev} successfully.`);
      mounted = true;
      break;
    }
    if (debug === 'true') {
      core.info(`mount ${dev} returned ${rc}, trying next...`);
    }
  }

  if (!mounted) {
    await exec.exec("sudo", ["qemu-nbd", "--disconnect", "/dev/nbd0"], { ignoreReturnCode: true });
    throw new Error("Could not mount any partition from Hurd image. Check that qemu-utils is installed and the image is valid.");
  }

  // Inject the SSH public key for root
  await exec.exec("sudo", ["mkdir", "-p", "/mnt/hurd-root/root/.ssh"]);

  const tmpKeyFile = path.join(os.tmpdir(), `hurd_authorized_keys_${Date.now()}`);
  fs.writeFileSync(tmpKeyFile, sshKeyPub + "\n", { mode: 0o600 });
  await exec.exec("sudo", ["cp", tmpKeyFile, "/mnt/hurd-root/root/.ssh/authorized_keys"]);
  fs.unlinkSync(tmpKeyFile);

  await exec.exec("sudo", ["chmod", "700", "/mnt/hurd-root/root/.ssh"]);
  await exec.exec("sudo", ["chmod", "600", "/mnt/hurd-root/root/.ssh/authorized_keys"]);
  await exec.exec("sudo", ["chown", "-R", "0:0", "/mnt/hurd-root/root/.ssh"]);

  // Ensure sshd allows root login with pubkey authentication.
  const sshdConfig = "/mnt/hurd-root/etc/ssh/sshd_config";
  if (fs.existsSync(sshdConfig)) {
    await exec.exec("sudo", ["sh", "-c",
      `printf '\\n# Added by hurd-vm action\\nPermitRootLogin yes\\nPubkeyAuthentication yes\\nAuthorizedKeysFile .ssh/authorized_keys\\n' >> ${sshdConfig}`
    ]);
    if (debug === 'true') {
      await exec.exec("sudo", ["tail", "-10", sshdConfig]);
    }
  } else {
    core.warning(`sshd_config not found at ${sshdConfig} — SSH key auth may not work.`);
  }

  // Unmount and disconnect cleanly
  await exec.exec("sudo", ["umount", "/mnt/hurd-root"]);
  await exec.exec("sudo", ["qemu-nbd", "--disconnect", "/dev/nbd0"]);
  await new Promise(r => setTimeout(r, 1000));

  core.info("Hurd image prepared successfully.");
}

// Parse the nat input lines into a list of { hostPort, guestPort, proto }
function parseNatPorts(nat) {
  if (!nat) return [];
  const result = [];
  for (const line of nat.split('\n')) {
    const trimmed = line.trim().replace(/['"]/g, '').replace(/\s+/g, '');
    if (!trimmed) continue;
    const isUdp = trimmed.startsWith('udp:');
    const clean = trimmed.replace(/^udp:/, '');
    const parts = clean.split(':');
    if (parts.length >= 2) {
      result.push({ hostPort: parts[0], guestPort: parts[1], proto: isUdp ? 'udp' : 'tcp' });
    }
  }
  return result;
}

// Launch QEMU in the background (daemonized)
async function startQemu(qemuSystem, imagePath, mem, cpu, sshPort, natPortsList, debug) {
  core.info(`Starting QEMU: ${qemuSystem} with image ${imagePath}`);

  const hostfwds = [
    `hostfwd=tcp:127.0.0.1:${sshPort}-:22`,
    ...natPortsList.map(({ hostPort, guestPort, proto }) =>
      `hostfwd=${proto}::${hostPort}-:${guestPort}`
    )
  ].join(',');

  const pidFile = path.join(os.tmpdir(), 'hurd-vm.pid');

  const args = [
    "-m", `${mem}`,
    "-drive", `file=${imagePath},format=raw,cache=writeback`,
    "-net", `user,${hostfwds}`,
    "-net", "nic,model=e1000",
    "-display", "none",
    "-daemonize",
    "-pidfile", pidFile,
  ];

  if (fs.existsSync('/dev/kvm')) {
    args.unshift("-enable-kvm");
  }

  if (cpu) {
    args.push("-smp", cpu);
  }

  await exec.exec(qemuSystem, args);
  core.info(`QEMU started. PID file: ${pidFile}`);
}

// Wait until SSH is accepting connections
async function waitForSSH(sshHost, timeoutSec, debug) {
  core.info(`Waiting for SSH on ${sshHost} (timeout: ${timeoutSec}s)...`);
  const start = Date.now();
  let attempt = 0;
  while ((Date.now() - start) / 1000 < timeoutSec) {
    attempt++;
    if (debug === 'true') {
      core.info(`SSH attempt ${attempt}...`);
    }
    const rc = await exec.exec("ssh", [
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=5",
      "-o", "BatchMode=yes",
      sshHost,
      "echo ssh-ready"
    ], { silent: debug !== 'true', ignoreReturnCode: true });

    if (rc === 0) {
      core.info(`SSH is ready after ${attempt} attempt(s) (${Math.round((Date.now() - start) / 1000)}s).`);
      return;
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  throw new Error(`Timed out waiting for SSH on ${sshHost} after ${timeoutSec}s`);
}

// Check whether rsync is available inside the VM.
async function hasRsyncInVM(sshHost) {
  const rc = await exec.exec("ssh", [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    sshHost,
    "command -v rsync >/dev/null 2>&1"
  ], { silent: true, ignoreReturnCode: true });
  return rc === 0;
}

async function main() {
  try {
    // 1. Inputs
    const debug = core.getInput("debug");
    const inputOsName = core.getInput("osname").toLowerCase();
    const mem = core.getInput("mem") || '2048';
    const cpu = core.getInput("cpu");
    const nat = core.getInput("nat");
    const envs = core.getInput("envs");
    const prepare = core.getInput("prepare");
    const run = core.getInput("run");
    const sync = core.getInput("sync").toLowerCase() || 'rsync';
    const copyback = core.getInput("copyback").toLowerCase();
    const disableCache = core.getInput("disable-cache").toLowerCase() === 'true';
    const debugOnError = core.getInput("debug-on-error").toLowerCase() === 'true';

    const work = path.join(process.env["HOME"], "work");
    const vmwork = '/root/work';
    const osName = inputOsName;

    // Parse user env names for path rewriting
    const userEnvNames = envs ? envs.split(/\s+/).filter(Boolean) : [];

    // 2. Load Config
    const confPath = path.join(__dirname, 'conf/default.conf');
    if (!fs.existsSync(confPath)) {
      throw new Error(`Config not found: ${confPath}`);
    }
    const env = parseConfig(confPath);

    const imageUrl   = env['IMAGE_URL'];
    const qemuSystem = env['QEMU_SYSTEM'] || 'qemu-system-x86_64';
    const sshUser    = env['SSH_USER']    || 'root';
    const sshPort    = env['SSH_PORT']    || '2222';

    if (!imageUrl) {
      throw new Error(`IMAGE_URL not defined in ${confPath}`);
    }

    core.startGroup("Configuration");
    core.info(`OS Name:     ${osName}`);
    core.info(`QEMU System: ${qemuSystem}`);
    core.info(`Image URL:   ${imageUrl}`);
    core.info(`SSH User:    ${sshUser}`);
    core.info(`SSH Port:    ${sshPort}`);
    core.endGroup();

    // 3. Generate SSH key pair for this run
    core.startGroup("SSH Key");
    const sshDir = path.join(process.env["HOME"], ".ssh");
    if (!fs.existsSync(sshDir)) {
      fs.mkdirSync(sshDir, { recursive: true });
    }
    const sshKeyPath = path.join(sshDir, "hurd_vm_key");
    const sshKeyPub = await generateSSHKey(sshKeyPath);
    core.info(`SSH public key: ${sshKeyPub}`);
    core.endGroup();

    // 4. Install dependencies
    core.startGroup("Installing dependencies");
    await install(sync, debug);
    core.endGroup();

    // 5. Cache
    // We use a date-based key derived from the current week so the image
    // refreshes weekly but cache hits within the same week avoid re-downloading.
    const now = new Date();
    const weekKey = `${now.getFullYear()}-W${String(Math.ceil(((now - new Date(now.getFullYear(),0,1)) / 86400000 + 1) / 7)).padStart(2,'0')}`;
    const cacheKey = `hurd-image-latest-amd64-${weekKey}`;

    const dataDir = core.getInput("data-dir")
      ? expandVars(core.getInput("data-dir"), process.env)
      : path.join(process.env['RUNNER_TEMP'] || os.tmpdir(), 'hurd-vm-data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const archiveFileName = 'debian-hurd.img.tar.gz';
    const archivePath = path.join(dataDir, archiveFileName);

    core.startGroup("Cache");
    let cacheHit = false;
    if (!disableCache) {
      try {
        const restoredKey = await cache.restoreCache(
          [archivePath],
          cacheKey,
          ['hurd-image-latest-amd64-']
        );
        if (restoredKey && fs.existsSync(archivePath)) {
          cacheHit = true;
          core.info(`Cache hit: ${restoredKey}`);
        } else {
          core.info("No cache hit for disk image.");
        }
      } catch (e) {
        core.warning(`Cache restore failed: ${e.message}`);
      }
    } else {
      core.info("Cache disabled.");
    }
    core.endGroup();

    // 6. Download image if not cached, then save to cache before starting the VM.
    if (!cacheHit || !fs.existsSync(archivePath)) {
      core.startGroup("Downloading Hurd disk image");
      await downloadFile(imageUrl, archivePath);
      core.endGroup();

      if (!disableCache) {
        core.startGroup("Saving image to cache");
        try {
          await cache.saveCache([archivePath], cacheKey);
          core.info(`Cache saved: ${cacheKey}`);
        } catch (e) {
          if (e.message && (e.message.includes('already exists') || e.message.includes('Cache already exists'))) {
            core.info(`Cache save skipped (benign): ${e.message}`);
          } else {
            core.warning(`Cache save failed: ${e.message}`);
          }
        }
        core.endGroup();
      }
    }

    // 7. Extract the image archive
    core.startGroup("Extracting disk image");
    const extractDir = path.join(dataDir, 'hurd-extract');
    if (!fs.existsSync(extractDir)) {
      fs.mkdirSync(extractDir, { recursive: true });
    }
    const existingImgs = fs.readdirSync(extractDir).filter(f => f.endsWith('.img'));
    for (const f of existingImgs) {
      fs.unlinkSync(path.join(extractDir, f));
    }
    await exec.exec("tar", ["-xf", archivePath, "-C", extractDir]);
    const imgFiles = fs.readdirSync(extractDir).filter(f => f.endsWith('.img'));
    if (imgFiles.length === 0) {
      throw new Error(`No .img file found after extracting ${archivePath} into ${extractDir}`);
    }
    const imagePath = path.join(extractDir, imgFiles[0]);
    core.info(`Using image: ${imagePath}`);
    core.endGroup();

    // 8. Prepare image: inject SSH key via qemu-nbd
    core.startGroup("Preparing image (SSH key injection)");
    await prepareHurdImage(imagePath, sshKeyPub, debug);
    core.endGroup();

    // 9. Parse NAT port mappings
    const natPortsList = parseNatPorts(nat);
    if (debug === 'true') {
      core.info(`NAT ports: ${JSON.stringify(natPortsList)}`);
    }

    // 10. Start QEMU
    core.startGroup("Starting Hurd VM");
    await startQemu(qemuSystem, imagePath, mem, cpu, sshPort, natPortsList, debug);
    core.endGroup();

    // 11. Wait for SSH
    core.startGroup("Waiting for SSH");
    const sshHostAlias = osName || 'hurd';

    const sshConfigPath = path.join(sshDir, "config");
    let sshConfigEntry = `Host ${sshHostAlias}\n`;
    sshConfigEntry += `  HostName 127.0.0.1\n`;
    sshConfigEntry += `  Port ${sshPort}\n`;
    sshConfigEntry += `  User ${sshUser}\n`;
    sshConfigEntry += `  IdentityFile ${sshKeyPath}\n`;
    sshConfigEntry += `  StrictHostKeyChecking no\n`;
    sshConfigEntry += `  UserKnownHostsFile /dev/null\n`;

    let sendEnvs = [];
    if (envs) sendEnvs.push(envs);
    sendEnvs.push("CI");
    if (sendEnvs.length > 0) {
      sshConfigEntry += `  SendEnv ${sendEnvs.join(" ")}\n`;
    }
    sshConfigEntry += "\n";
    sshConfigEntry += "Host *\n  StrictHostKeyChecking no\n";

    fs.writeFileSync(sshConfigPath, sshConfigEntry);

    if (debug === 'true') {
      core.info("SSH config:");
      core.info(fs.readFileSync(sshConfigPath, 'utf8'));
    }

    // Hurd can take a while to boot — allow up to 5 minutes
    await waitForSSH(sshHostAlias, 300, debug);
    core.endGroup();

    const sshConfig = {
      host: sshHostAlias,
      osName: osName,
      work: work,
      vmwork: vmwork,
      userEnvNames: userEnvNames
    };

    // 12. Register a custom shell wrapper so users can write: shell: hurd {0}
    const localBinDir = path.join(process.env["HOME"], ".local", "bin");
    if (!fs.existsSync(localBinDir)) {
      fs.mkdirSync(localBinDir, { recursive: true });
    }
    const sshWrapperPath = path.join(localBinDir, sshHostAlias);
    const sshWrapperContent = `#!/usr/bin/env sh\n\nssh ${sshHostAlias} sh<$1\n`;
    fs.writeFileSync(sshWrapperPath, sshWrapperContent);
    fs.chmodSync(sshWrapperPath, '755');

    // 13. Run onStarted hook
    const onStartedHook = path.join(__dirname, 'hooks', 'onStarted.sh');
    if (fs.existsSync(onStartedHook)) {
      core.startGroup(`Running onStarted hook`);
      const hookContent = fs.readFileSync(onStartedHook, 'utf8');
      await execSSH(hookContent, sshConfig, false, debug !== 'true');
      core.endGroup();
    }

    // 14. File sync
    if (process.platform !== 'win32') {
      const homeDir = process.env.HOME;
      if (homeDir) {
        try {
          fs.chmodSync(homeDir, '755');
        } catch (err) {
          core.warning(`Failed to chmod ${homeDir}: ${err.message}`);
        }
      }
    }

    // sshfs and nfs are not supported on Hurd
    let effectiveSync = sync;
    if (sync === 'sshfs' || sync === 'nfs') {
      throw new Error(`Sync mode '${sync}' is not supported on Debian GNU/Hurd. Use 'rsync', 'scp', or 'no' instead.`);
    }

    // rsync requires the rsync binary in the guest VM. If missing, use scp.
    if (effectiveSync === 'rsync' && !(await hasRsyncInVM(sshHostAlias))) {
      core.warning("rsync is not installed in the VM; falling back to scp for file sync.");
      effectiveSync = 'scp';
    }

    let isScpOrRsync = false;
    if (effectiveSync === 'scp' || effectiveSync === 'rsync') {
      isScpOrRsync = true;
    }

    if (isScpOrRsync) {
      core.startGroup("Syncing source code to VM");
      await execSSH(`rm -rf ${vmwork}`, { ...sshConfig });
      await execSSH(`mkdir -p ${vmwork}`, { ...sshConfig });
      if (effectiveSync === 'scp') {
        core.info("Syncing via SCP");
        await scpToVM(sshHostAlias, work, vmwork, debug);
      } else {
        core.info("Syncing via Rsync");
        const rsyncArgs = [
          debug === 'true' ? "-avrtopg" : "-artopg",
          "--exclude", "_actions",
          "--exclude", "_PipelineMapping",
          "-e", "ssh",
          work + "/",
          `${sshHostAlias}:${vmwork}/`
        ];
        await exec.exec("rsync", rsyncArgs);
        if (debug === 'true') {
          core.startGroup("Debug: VM work directory");
          await execSSH(`ls -la ${vmwork}`, { ...sshConfig });
          core.endGroup();
        }
      }
      core.endGroup();
    }

    if (effectiveSync !== 'no') {
      core.startGroup('Creating workdir symlink');
      await execSSH(`ln -sf ${vmwork} $HOME/work`, { ...sshConfig });
      core.endGroup();
    }

    // 15. Run onInitialized hook
    const onInitializedHook = path.join(__dirname, 'hooks', 'onInitialized.sh');
    if (fs.existsSync(onInitializedHook)) {
      core.startGroup(`Running onInitialized hook`);
      const hookContent = fs.readFileSync(onInitializedHook, 'utf8');
      await execSSH(hookContent, sshConfig, false, debug !== 'true');
      core.endGroup();
    }

    // 16. Run prepare
    try {
      core.startGroup("Run 'prepare' in VM");
      if (prepare) {
        const prepareCmd = (effectiveSync !== 'no') ? `cd "$GITHUB_WORKSPACE"\n${prepare}` : prepare;
        await execSSH(prepareCmd, { ...sshConfig });
      }
      core.endGroup();
    } catch (err) {
      core.endGroup();
      if (debugOnError) {
        await handleErrorWithDebug(sshHostAlias, "", debug);
      } else {
        throw err;
      }
    }

    // 16. Run user command
    try {
      core.startGroup("Run 'run' in VM");
      if (run) {
        const runCmd = (effectiveSync !== 'no') ? `cd "$GITHUB_WORKSPACE"\n${run}` : run;
        await execSSH(runCmd, { ...sshConfig });
      }
      core.endGroup();
    } catch (err) {
      core.endGroup();
      if (debugOnError) {
        await handleErrorWithDebug(sshHostAlias, "", debug);
      } else {
        throw err;
      }
    }

    // 17. Copy results back from VM to host
    if (copyback !== 'false' && effectiveSync !== 'no') {
      const workspace = process.env['GITHUB_WORKSPACE'];
      if (workspace) {
        core.startGroup("Copyback artifacts");
        if (effectiveSync === 'scp') {
          const remoteTarCmd = `cd "${vmwork}" && tar -cf - --exclude .git .`;
          core.info(`Remote tar: ${remoteTarCmd}`);

          await new Promise((resolve, reject) => {
            const sshProc = spawn("ssh", ["-o", "StrictHostKeyChecking=no", sshHostAlias, remoteTarCmd]);
            const tarProc = spawn("tar", ["-xf", "-"], { cwd: work });

            sshProc.stdout.pipe(tarProc.stdin);
            sshProc.stderr.on('data', (d) => core.info(`[SSH] ${d}`));
            tarProc.stderr.on('data', (d) => core.info(`[TAR] ${d}`));

            sshProc.on('close', (code) => { if (code !== 0) reject(new Error(`SSH exited ${code}`)); });
            tarProc.on('close', (code) => { if (code !== 0) reject(new Error(`tar exited ${code}`)); else resolve(); });
            sshProc.on('error', reject);
            tarProc.on('error', reject);
          });
        } else {
          await exec.exec("rsync", [
            debug === 'true' ? "-av" : "-a",
            "--exclude", ".git",
            "-e", "ssh",
            `${sshHostAlias}:${vmwork}/`,
            `${work}/`
          ]);
        }
        core.endGroup();
      }
    }

    // Save the PID file path for cleanup.js
    const pidFile = path.join(os.tmpdir(), 'hurd-vm.pid');
    core.saveState('pidFile', pidFile);
    core.saveState('sshKeyPath', sshKeyPath);

  } catch (error) {
    core.setFailed(error.message);
    process.exit(1);
  }
}

main();
