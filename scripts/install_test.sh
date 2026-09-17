#!/usr/bin/env bash
#
# install_test.sh — offline tests of the install steps that do not need a
# published release: platform detection, checksum verification, archive
# extraction and copying the binary out of an archive laid out like
# himorime's goreleaser archives.
#
# The download itself needs a real release and is covered by the install job
# in .github/workflows/test.yml.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=install.sh
source "${here}/install.sh"

failures=0
pass() { printf 'ok:   %s\n' "$1"; }
fail() { printf 'FAIL: %s\n' "$1"; failures=$((failures + 1)); }

# expect_fail runs a command in a subshell, because die exits, and checks
# that it fails with a message containing the given text.
expect_fail() {
  local name="$1" want="$2"
  shift 2
  local out
  if out="$( ("$@") 2>&1)"; then
    fail "${name}: succeeded, want a failure mentioning '${want}'"
  elif [[ "$out" != *"$want"* ]]; then
    fail "${name}: failed with '${out}', want '${want}'"
  else
    pass "$name"
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- detect_platform ---------------------------------------------------------
check_platform() {
  local runner_os="$1" runner_arch="$2" want="$3"
  RUNNER_OS="$runner_os" RUNNER_ARCH="$runner_arch"
  detect_platform
  local got="${OS}/${ARCH}/${EXT}/${BIN_SUFFIX}"
  if [ "$got" = "$want" ]; then
    pass "detect_platform ${runner_os} ${runner_arch}"
  else
    fail "detect_platform ${runner_os} ${runner_arch}: got ${got}, want ${want}"
  fi
}
check_platform Linux X64 "linux/amd64/tar.gz/"
check_platform Linux ARM64 "linux/arm64/tar.gz/"
check_platform macOS ARM64 "darwin/arm64/tar.gz/"
check_platform macOS X64 "darwin/amd64/tar.gz/"
check_platform Windows X64 "windows/amd64/zip/.exe"
check_platform Windows ARM64 "windows/arm64/zip/.exe"
expect_fail "detect_platform rejects 32-bit" "unsupported runner architecture" \
  env RUNNER_OS=Linux RUNNER_ARCH=X86 bash -c "source '${here}/install.sh'; detect_platform"
expect_fail "detect_platform rejects an unknown OS" "unsupported runner OS" \
  env RUNNER_OS=FreeBSD RUNNER_ARCH=X64 bash -c "source '${here}/install.sh'; detect_platform"

# --- a fake release shaped like himorime's archives --------------------------
# goreleaser puts the binary at the top of the archive next to LICENSE,
# README.md, CHANGELOG.md and completions/, including completions/himorime.bash
# whose name starts with the binary's.
stage="${tmp}/stage"
mkdir -p "${stage}/completions"
printf '#!/bin/sh\necho "himorime fake"\n' >"${stage}/himorime"
cp "${stage}/himorime" "${stage}/himorime.exe"
for f in LICENSE README.md CHANGELOG.md completions/himorime.bash completions/himorime.zsh completions/himorime.fish; do
  printf 'not the binary\n' >"${stage}/${f}"
done

tarball="${tmp}/himorime_0.1.0_linux_amd64.tar.gz"
tar -czf "$tarball" -C "$stage" himorime LICENSE README.md CHANGELOG.md completions
zipball="${tmp}/himorime_0.1.0_windows_amd64.zip"
if command -v zip >/dev/null 2>&1; then
  (cd "$stage" && zip -qr "$zipball" himorime.exe LICENSE README.md CHANGELOG.md completions)
elif command -v pwsh >/dev/null 2>&1 || command -v powershell >/dev/null 2>&1; then
  ps="$(command -v pwsh || command -v powershell)"
  stage_native="$stage" zip_native="$zipball"
  if command -v cygpath >/dev/null 2>&1; then
    stage_native="$(cygpath -w "$stage")" zip_native="$(cygpath -w "$zipball")"
  fi
  "$ps" -NoProfile -NonInteractive -Command \
    "Compress-Archive -Path '${stage_native}\\himorime.exe','${stage_native}\\LICENSE','${stage_native}\\completions' -DestinationPath '${zip_native}'"
else
  zipball=""
  printf 'skip: no zip or PowerShell to build a zip archive\n'
fi

checksums="${tmp}/checksums.txt"
{
  printf '%s  %s\n' "$(sha256_of "$tarball")" "$(basename "$tarball")"
  [ -z "$zipball" ] || printf '%s  %s\n' "$(sha256_of "$zipball")" "$(basename "$zipball")"
} >"$checksums"

# --- verify_checksum ---------------------------------------------------------
if out="$(verify_checksum "$tarball" "$checksums" "$(basename "$tarball")")" && [[ "$out" == *"Checksum OK"* ]]; then
  pass "verify_checksum accepts a matching archive"
else
  fail "verify_checksum rejected a matching archive: ${out:-}"
fi
expect_fail "verify_checksum rejects an archive missing from checksums.txt" "not found in checksums.txt" \
  verify_checksum "$tarball" "$checksums" "himorime_0.1.0_darwin_arm64.tar.gz"
tampered="${tmp}/tampered.tar.gz"
cp "$tarball" "$tampered"
printf 'x' >>"$tampered"
expect_fail "verify_checksum rejects a modified archive" "checksum mismatch" \
  verify_checksum "$tampered" "$checksums" "$(basename "$tarball")"
# A name must match whole: a longer asset name that ends the same way does not.
printf '%s  %s\n' "$(sha256_of "$tarball")" "other_himorime_0.1.0_linux_amd64.tar.gz" >"${tmp}/suffix.txt"
expect_fail "verify_checksum does not match a longer asset name" "not found in checksums.txt" \
  verify_checksum "$tarball" "${tmp}/suffix.txt" "$(basename "$tarball")"

# --- extract_archive and install_binary --------------------------------------
check_install() {
  local archive="$1" suffix="$2"
  local name dest install_dir
  name="$(basename "$archive")"
  dest="${tmp}/extract-${name}"
  install_dir="${tmp}/bin-${name}"
  BIN_SUFFIX="$suffix"
  extract_archive "$archive" "$dest"
  local installed
  installed="$(install_binary "$dest" "$install_dir" "$(basename "$archive")")"
  if [ "$installed" != "${install_dir}/himorime${suffix}" ]; then
    fail "install_binary $(basename "$archive"): installed ${installed}"
  elif ! grep -q "himorime fake" "$installed"; then
    fail "install_binary $(basename "$archive"): copied a file that is not the binary"
  elif [ "$(ls "$install_dir")" != "himorime${suffix}" ]; then
    fail "install_binary $(basename "$archive"): install dir holds $(ls "$install_dir")"
  else
    pass "extract_archive and install_binary $(basename "$archive")"
  fi
}
check_install "$tarball" ""
[ -z "$zipball" ] || check_install "$zipball" ".exe"

mkdir -p "${tmp}/empty/completions"
printf 'x\n' >"${tmp}/empty/completions/himorime.bash"
expect_fail "install_binary fails when the archive has no binary" "not found inside" \
  install_binary "${tmp}/empty" "${tmp}/bin-empty" "broken.tar.gz"
expect_fail "extract_archive rejects an unknown format" "unsupported archive format" \
  extract_archive "${tmp}/himorime.rar" "${tmp}/rar"

if [ "$failures" -ne 0 ]; then
  printf '%d test(s) failed\n' "$failures" >&2
  exit 1
fi
printf 'all install tests passed\n'
