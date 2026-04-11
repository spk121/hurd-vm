# Run GitHub CI in Debian GNU/Hurd ![Test](https://github.com/spk121/hurd-vm/workflows/Test/badge.svg)

Use this action to run your CI in Debian GNU/Hurd.

GitHub Actions only supports Ubuntu, Windows, and macOS runners. This action launches the latest Debian GNU/Hurd in a QEMU VM on an Ubuntu runner, so you can build and test software targeting the Hurd.

The image is always the latest available from [cdimage.debian.org](https://cdimage.debian.org/cdimage/ports/latest/hurd-amd64/).


## 1. Example: `test.yml`

```yml
name: Test

on: [push]

jobs:
  test:
    runs-on: ubuntu-latest
    name: A job to run test in Debian GNU/Hurd
    env:
      MYTOKEN : ${{ secrets.MYTOKEN }}
      MYTOKEN2: "value2"
    steps:
    - uses: actions/checkout@v6
    - name: Test in Debian GNU/Hurd
      id: test
      uses: spk121/hurd-vm@v0
      with:
        envs: 'MYTOKEN MYTOKEN2'
        prepare: |
          apt-get update
          apt-get install -y curl

        run: |
          uname -a
          lsb_release -a 2>/dev/null || echo 'lsb_release not available'
          ls -lah
          whoami
          env
          nproc
          free -h

```

The `envs: 'MYTOKEN MYTOKEN2'` is the env names that you want to pass into the VM.

The `run: xxxxx` is the command you want to run in the VM.

The env variables are all copied into the VM, and the source code and directory are all synchronized into the VM.

The working dir for `run` in the VM is the same as in the host machine.

All the source code tree in the host machine are mounted into the VM.

All the `GITHUB_*` as well as `CI=true` env variables are passed into the VM.


## 2. Share code

The action defaults to `sync: rsync`, but the default Debian GNU/Hurd image does not include `rsync`.

If `rsync` is missing in the VM, the action falls back to `scp` automatically.

To use true `rsync` mode, install `rsync` in the VM first (for example in `prepare`). Otherwise, use `sync: scp` explicitly:

```yaml
    - name: Test
      uses: spk121/hurd-vm@v0
      with:
        sync: scp
```

Set `sync: no` to skip file syncing entirely.

When using `rsync` or `scp`, you can set `copyback: false` to skip copying files back from the VM to the host:

```yaml
    - name: Test
      uses: spk121/hurd-vm@v0
      with:
        sync: rsync
        copyback: false
```


## 3. NAT from host runner to the VM

You can add NAT port forwarding between the host and the VM:

```yaml
    - name: Test
      uses: spk121/hurd-vm@v0
      with:
        nat: |
          "8080": "80"
          "8443": "443"
          udp:"8081": "80"
```


## 4. Set memory and CPU

The default memory is 2048MB. Use `mem` to change it:

```yaml
    - name: Test
      uses: spk121/hurd-vm@v0
      with:
        mem: 4096
```

The VM uses 1 CPU core by default. Use `cpu` to increase it:

```yaml
    - name: Test
      uses: spk121/hurd-vm@v0
      with:
        cpu: 3
```


## 5. Custom shell

You can use multiple steps with a custom shell:

```yaml
    steps:
    - uses: actions/checkout@v6
    - name: Start VM
      uses: spk121/hurd-vm@v0
      with:
        sync: rsync
    - name: Custom shell step 1
      shell: hurd {0}
      run: |
        cd $GITHUB_WORKSPACE;
        pwd
        echo "this is step 1, running inside the VM"
    - name: Custom shell step 2
      shell: hurd {0}
      run: |
        cd $GITHUB_WORKSPACE;
        pwd
        echo "this is step 2, running inside the VM"
```


## 6. Disable cache

By default, the action caches the VM disk image to speed up subsequent runs. To disable caching:

```yml
    - name: Test
      uses: spk121/hurd-vm@v0
      with:
        disable-cache: true
```


## 7. Custom data directory

By default, VM images are stored in `$RUNNER_TEMP/hurd-vm-data`. Use `data-dir` to store them elsewhere:

```yml
    - name: Test
      uses: spk121/hurd-vm@v0
      with:
        data-dir: /mnt/fast-storage/hurd-vm
```


## 8. Debug logging

Set `debug: true` to enable verbose logging throughout the action (SSH attempts, timing, file listings, etc.):

```yaml
    - name: Test
      uses: spk121/hurd-vm@v0
      with:
        debug: true
```


## 9. Debug on error

Set `debug-on-error: true` to pause the action when `prepare` or `run` fails. After debugging inside the VM, run `touch ~/continue` to resume.

```yaml
    - name: Test
      uses: spk121/hurd-vm@v0
      with:
        debug-on-error: ${{ vars.DEBUG_ON_ERROR }}
```

# Under the hood

We use QEMU to run the Debian GNU/Hurd VM.

Debian GNU/Hurd is a port of the Debian GNU system to the GNU Hurd kernel (based on GNU Mach).
More information: https://www.debian.org/ports/hurd/
