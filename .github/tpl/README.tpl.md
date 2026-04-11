# Run GitHub CI in {{VM_NAME}} ![Test](https://github.com/{{GITHUB_REPOSITORY}}/workflows/Test/badge.svg)

Powered by [AnyVM.org](https://anyvm.org)

Use this action to run your CI in {{VM_NAME}}.

The github workflow only supports Ubuntu, Windows and MacOS. But what if you need to use {{VM_NAME}}?


All the supported releases are here:

{{RELEASE_TABLE}}




## 1. Example: `test.yml`:

```yml

name: Test

on: [push]

jobs:
  test:
    runs-on: {{VM_RUNS_ON}}
    name: A job to run test in {{VM_NAME}}
    env:
      MYTOKEN : ${{ secrets.MYTOKEN }}
      MYTOKEN2: "value2"
    steps:
    - uses: actions/checkout@v6
    - name: Test in {{VM_NAME}}
      id: test
      uses: {{GITHUB_REPOSITORY}}@{{LATEST_MAJOR}}
      with:
        envs: 'MYTOKEN MYTOKEN2'
        prepare: |
          {{VM_PREPARE}}

        run: |
{{VM_RUN}}




```


The latest major version is: `{{LATEST_MAJOR}}`, which is the most recommended to use. (You can also use the latest full version: `{{LATEST_TAG}}`)  


If you are migrating from the previous `v0`, please change the `runs-on: ` to `runs-on: {{VM_RUNS_ON}}`


The `envs: 'MYTOKEN MYTOKEN2'` is the env names that you want to pass into the vm.

The `run: xxxxx`  is the command you want to run in the vm.

The env variables are all copied into the VM, and the source code and directory are all synchronized into the VM.

The working dir for `run` in the VM is the same as in the Host machine.

All the source code tree in the Host machine are mounted into the VM.

All the `GITHUB_*` as well as `CI=true` env variables are passed into the VM.

So, you will have the same directory and same default env variables when you `run` the CI script.



## 2. Share code

The code is shared from the host to the VM via `rsync` by default. You can also use `scp`, or set `sync: no` to skip syncing entirely. (`sshfs` and `nfs` are not supported on Debian GNU/Hurd.)


```yaml

...

    - name: Test
      id: test
      uses: {{GITHUB_REPOSITORY}}@{{LATEST_MAJOR}}
      with:
        sync: scp


...


```

You can also set `sync: no`, so the files will not be synced to the  VM.


When using `rsync` or `scp`,  you can define `copyback: false` to not copy files back from the VM in to the host.


```yaml

...

    - name: Test
      id: test
      uses: {{GITHUB_REPOSITORY}}@{{LATEST_MAJOR}}
      with:
        sync: rsync
        copyback: false


...


```


{{VM_SYNC_COMMENTS}}


## 3. NAT from host runner to the VM

You can add NAT port between the host and the VM.

```yaml
...
    - name: Test
      id: test
      uses: {{GITHUB_REPOSITORY}}@{{LATEST_MAJOR}}
      with:
        nat: |
          "8080": "80"
          "8443": "443"
          udp:"8081": "80"
...
```


## 4. Set memory and cpu

The default memory of the VM is 2048MB, you can use `mem` option to set the memory size:

```yaml

...
    - name: Test
      id: test
      uses: {{GITHUB_REPOSITORY}}@{{LATEST_MAJOR}}
      with:
        mem: 4096
...
```


The VM is using all the cpu cores of the host by default, you can use `cpu` option to change the cpu cores:

```yaml

...
    - name: Test
      id: test
      uses: {{GITHUB_REPOSITORY}}@{{LATEST_MAJOR}}
      with:
        cpu: 3
...
```


## 5. Custom shell

Support custom shell:

```yaml
...
    steps:
    - uses: actions/checkout@v6
    - name: Start VM
      id: vm
      uses: {{GITHUB_REPOSITORY}}@{{LATEST_MAJOR}}
      with:
        sync: scp
    - name: Custom shell step 1
      shell: {{VM_OS_NAME}} {0}
      run: |
        cd $GITHUB_WORKSPACE;
        pwd
        echo "this is step 1, running inside the VM"
    - name: Custom shell step 2
      shell: {{VM_OS_NAME}} {0}
      run: |
        cd $GITHUB_WORKSPACE;
        pwd
        echo "this is step 2, running inside the VM"
...
```


## 6. Disable cache

By default, the action caches the VM image archive to speed up later runs. You can use `disable-cache: true` to disable this:

```yml
...
    - name: Test
      id: test
      uses: {{GITHUB_REPOSITORY}}@{{LATEST_MAJOR}}
      with:
        disable-cache: true
...
```


## 7. Debug on error

If you want to debug the VM when the `prepare` or `run` step fails, you can set `debug-on-error: true`.

When a failure occurs, the action pauses and waits for your interaction. To continue or finish the action, run `touch ~/continue` inside the VM.

[First create a variable `DEBUG_ON_ERROR` with value being "true"](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables),

Then use it in the workflow:

```yaml
...
    - name: Test
      id: test
      uses: {{GITHUB_REPOSITORY}}@{{LATEST_MAJOR}}
      with:
        debug-on-error: ${{ vars.DEBUG_ON_ERROR }}

...
```

# Under the hood

We use Qemu to run the {{VM_NAME}} VM.

Debian GNU/Hurd is a port of the Debian GNU system to the GNU Hurd kernel (based on GNU Mach).
More information: https://www.debian.org/ports/hurd/
