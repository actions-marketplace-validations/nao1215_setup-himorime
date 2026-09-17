# setup-himorime

GitHub Action to install the [himorime](https://github.com/nao1215/himorime)
CLI, which measures the latency, throughput, CPU time and memory of
command-line programs, checks budgets, and detects regressions between Git
revisions.

It downloads a prebuilt release binary instead of building from source, so
your workflows stay fast: no Go setup, no `go build`. Works on Linux, macOS,
and Windows (amd64 / arm64).

## Quick start

```yaml
jobs:
  benchmark:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          # The base commit must exist locally for himorime's temporary worktree.
          fetch-depth: 0
          persist-credentials: false
      - uses: nao1215/setup-himorime@v0
      - run: himorime ci
```

`himorime` is now on `PATH`. `himorime ci` compares the pull request's base
revision with the checked-out head, writes a job summary and annotations, and
exits 1 on a budget violation or a gated regression.

## Pin a version

```yaml
- uses: nao1215/setup-himorime@v0
  with:
    version: v0.1.0 # default: latest
```

For reproducible CI, pin an exact version instead of `latest`, so a new
himorime release cannot change what your workflow installs.

## Inputs

| Name                 | Default               | Description                                                        |
| -------------------- | --------------------- | ------------------------------------------------------------------ |
| `version`            | `latest`              | Release to install: `latest`, `v0.1.0`, or `0.1.0`.                |
| `github-token`       | `${{ github.token }}` | Token for API requests / downloads (avoids rate limiting).         |
| `install-dir`        | `$HOME/.himorime/bin` | Where to install the binary. Added to `PATH`.                      |
| `verify-checksum`    | `true`                | Verify the archive against `checksums.txt` (SHA-256).              |
| `verify-attestation` | `false`               | Verify build provenance with `gh attestation verify` (opt-in).     |
| `add-to-path`        | `true`                | Add the install directory to `PATH`. Set `false` for outputs only. |

## Outputs

| Name          | Description                                  |
| ------------- | -------------------------------------------- |
| `version`     | Installed version (e.g. `v0.1.0`).           |
| `bin-path`    | Absolute path to the `himorime` binary.      |
| `install-dir` | Directory the binary was installed into.     |

## Verification behavior

The action fails (rather than silently continuing) when a verification you
enabled cannot be completed:

- `verify-checksum: true` (default): the install fails if `checksums.txt`
  cannot be downloaded, if the archive is missing from it, or if the SHA-256
  does not match. Set `verify-checksum: false` to skip the check entirely.
- `verify-attestation: true`: the install fails if the `gh` CLI is
  unavailable, if neither `GH_TOKEN` nor `GITHUB_TOKEN` is set, or if
  `gh attestation verify` fails. It is opt-in and skipped by default.

The action derives release asset names
(`himorime_<version>_<os>_<arch>.<ext>`) from himorime's
[goreleaser](https://goreleaser.com/) config. If himorime's release naming
changes, this action must be updated to match.

## Development

```shell
shellcheck -x scripts/install.sh scripts/version_test.sh scripts/install_test.sh
bash scripts/version_test.sh   # version normalization
bash scripts/install_test.sh   # checksum, extraction and install against a fake archive
```

The `install` job of `.github/workflows/test.yml` installs a real release on
every platform. It needs a published himorime release that the workflow token
can download, so it runs when the repository variable `HIMORIME_RELEASED` is
`true`, or when the workflow is started by hand.

## License

[MIT](./LICENSE) © CHIKAMATSU Naohiro
