#!/usr/bin/env bash
#
# build-icu-data.sh – cut an ICU data package down to what collation needs.
#
# Emscripten's ICU port links libicu_stubdata: ICU's code with none of its
# data, so ucol_open() fails and Firebird reports UNICODE, UNICODE_CI and
# UNICODE_CI_AI as "not installed".  Stub data exists so an application can
# supply its own, which is what wasm/fb_wasm_icu_data.cpp does with the file
# this script produces.
#
# The input is ICU's own icudt68l.dat, already present in the Emscripten port's
# download cache — there is no need to fetch ICU separately.  The version must
# match the port's TAG (release-68-2): ICU rejects data whose major version
# differs from the library.
#
# Usage:  tools/build-icu-data.sh [items-to-keep-regex]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WASM_DIR="$(dirname "${SCRIPT_DIR}")"
REPO_ROOT="$(cd "${WASM_DIR}/../../.." && pwd)"

ICU_SRC="${REPO_ROOT}/third_party/emsdk/upstream/emscripten/cache/ports/icu/icu"
FULL_DAT="${ICU_SRC}/source/data/in/icudt68l.dat"
OUT_DIR="${WASM_DIR}/icu-data"
OUT_DAT="${OUT_DIR}/icudt68l.dat"

# Which items to keep.  Defaults to the whole collation tree; the root collator
# alone (coll/root.res plus coll/ucadata.icu) is smaller but has not been shown
# to be sufficient — see docs/roadmap.md.
KEEP="${1:-^coll/}"

if ! command -v icupkg >/dev/null; then
  echo "icupkg not found. On Debian/Ubuntu: apt-get install icu-devtools" >&2
  exit 1
fi

if [[ ! -f "${FULL_DAT}" ]]; then
  echo "ICU data not found at ${FULL_DAT}" >&2
  echo "It is downloaded by Emscripten's ICU port; build once with -sUSE_ICU=1 first." >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

icupkg -l "${FULL_DAT}" > "${work}/all.txt"
grep -vE "${KEEP}" "${work}/all.txt" > "${work}/remove.txt" || true

echo "keeping   $(grep -cE "${KEEP}" "${work}/all.txt") items"
echo "removing  $(wc -l < "${work}/remove.txt") items"

icupkg -r "${work}/remove.txt" "${FULL_DAT}" "${OUT_DAT}"

printf 'wrote %s (%s)\n' "${OUT_DAT}" "$(du -h "${OUT_DAT}" | cut -f1)"
