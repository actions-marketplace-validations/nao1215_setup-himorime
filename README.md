# setup-himorime

GitHub Action to install [himorime](https://github.com/nao1215/himorime), which measures CLI performance, checks budgets and detects regressions between Git revisions.

Downloads a release with checksum verification enabled by default for Linux, macOS and Windows (amd64 / arm64). On same-repository pull requests, a post step automatically publishes a short problem-only comment from the saved JSON report.

## Quick start

```yaml
on: pull_request
jobs:
  benchmark:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v7
        with:
          # The base commit must exist locally for himorime's temporary worktree.
          fetch-depth: 0
          persist-credentials: false
      - uses: nao1215/setup-himorime@main # Pin a reviewed commit in production.
      - run: himorime ci --format json --output "$RUNNER_TEMP/himorime.json"
```

`himorime` is on `PATH`. The measurement step keeps its exit status, logs and Job Summary; the action posts the notification at the end of the job, including when measurement fails after writing a report. No comment command, helper executable or second workflow is needed. Automatic comments are available on `main`; existing release tags are unchanged.

Comments contain errors, regressions, budget violations and inconclusive or skipped checks, with a link to the Actions run. Passing and improved measurements are not listed. Repeated runs leave one bot-owned report comment; existing human comments are untouched. Fork PRs and non-PR events never post, even with a write-capable token.

Only a fresh `$RUNNER_TEMP/himorime.json` is read. Missing or stale reports are skipped; malformed reports or API failures fail the post step with a diagnostic. Use one reporting benchmark job per PR: concurrent jobs converge on one result, not a combined report. Do not use `pull_request_target` or pass the publication token to measured commands. Same-repository PR code runs in a job with write permissions; grant those permissions only to contributors you trust.

## Pin a version

```yaml
- uses: nao1215/setup-himorime@main # Pin a reviewed action commit in production.
  with:
    version: v0.1.0 # default: latest
```

The `version` input selects the himorime CLI release, independently of the action revision. Pin it instead of `latest` so a new himorime release cannot change what your workflow installs.

## Inputs

| Name                 | Default               | Description                                                        |
| -------------------- | --------------------- | ------------------------------------------------------------------ |
| `version`            | `latest`              | Release to install: `latest`, `v0.1.0`, or `0.1.0`.                |
| `github-token`       | `${{ github.token }}` | Token for downloads and PR comments; comments need `pull-requests: write`. |
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

The action fails when an enabled verification cannot be completed:

- `verify-checksum: true` (default): the install fails if `checksums.txt` cannot be downloaded, if the archive is missing from it, or if the SHA-256 does not match. Set `verify-checksum: false` to skip the check entirely.
- `verify-attestation: true`: the install fails if the `gh` CLI is unavailable, if neither `GH_TOKEN` nor `GITHUB_TOKEN` is set, or if `gh attestation verify` fails. It is opt-in and skipped by default.

The action derives release asset names (`himorime_<version>_<os>_<arch>.<ext>`) from himorime's [goreleaser](https://goreleaser.com/) config. If himorime's release naming changes, this action must be updated to match.

## Development

```shell
shellcheck -x scripts/install.sh scripts/version_test.sh scripts/install_test.sh
bash scripts/version_test.sh   # version normalization
bash scripts/install_test.sh   # checksum, extraction and install against a fake archive
node --test scripts/comment.test.mjs
```

The `install` job of `.github/workflows/test.yml` installs a real release on every platform. It needs a published himorime release that the workflow token can download, so it runs when the repository variable `HIMORIME_RELEASED` is `true`, or when the workflow is started by hand.

## License

[MIT](./LICENSE) © CHIKAMATSU Naohiro
