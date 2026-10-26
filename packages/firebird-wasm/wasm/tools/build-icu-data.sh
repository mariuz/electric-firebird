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
# The input is ICU's own icudt68l.dat, present in the Emscripten port's
# download cache (or populated via `embuilder build icu`).  The version must
# match the port's TAG (release-68-2): ICU rejects data whose major version
# differs from the library, and fb_wasm_icu_data.cpp enforces
# U_ICU_VERSION_MAJOR_NUM == 68 at compile time.
#
# Usage:  tools/build-icu-data.sh [items-to-keep-regex]
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WASM_DIR="$(dirname "${SCRIPT_DIR}")"
REPO_ROOT="$(cd "${WASM_DIR}/../../.." && pwd)"

EM_CACHE_DIR="$(em-config CACHE 2>/dev/null || echo "${REPO_ROOT}/third_party/emsdk/upstream/emscripten/cache")"
ICU_SRC="${EM_CACHE_DIR}/ports/icu/icu"
FULL_DAT="${ICU_SRC}/source/data/in/icudt68l.dat"
OUT_DIR="${WASM_DIR}/icu-data"
OUT_DAT="${OUT_DIR}/icudt68l.dat"

# Default: the root collator, Unicode collation weights table, and default
# locale fallback chain (~808 KB raw, ~270 KB gzipped), which is what
# Firebird's UNICODE, UNICODE_CI, and UNICODE_CI_AI collations use.
# Pass '^coll/' to keep all 170 locale-specific collations (~3.3 MB raw).
# Pass '--locales' to build the optional lazy-loaded locale tailoring pack
# (wasm/icu-data/icudt68l-locales.dat) for LOCALE=de_DE, es_ES, fr_FR, ja_JP.
if [[ "${1:-}" == "--locales" ]]; then
  shift
  OUT_DAT="${OUT_DIR}/icudt68l-locales.dat"
  KEEP="${1:-^(res_index\.res|coll/((de|es|fr|ja)(_[A-Z0-9]+)?\.res|res_index\.res))$}"
else
  KEEP="${1:-^(res_index\.res|coll/(ucadata\.icu|root\.res|en(_US(_POSIX)?)?\.res|res_index\.res))$}"
fi

if ! command -v icupkg >/dev/null; then
  echo "icupkg not found. On Debian/Ubuntu: apt-get install icu-devtools" >&2
  exit 1
fi

if [[ ! -f "${FULL_DAT}" ]]; then
  if command -v embuilder >/dev/null; then
    echo "Populating Emscripten ICU port cache via embuilder…"
    embuilder build icu
  fi
fi

if [[ ! -f "${FULL_DAT}" ]]; then
  OTHER_DAT="$(ls "${ICU_SRC}/source/data/in"/icudt*l.dat 2>/dev/null | head -1 || true)"
  if [[ -n "${OTHER_DAT}" ]]; then
    echo "Error: expected ${FULL_DAT} (ICU 68), but found ${OTHER_DAT}." >&2
    echo "       Emscripten's ICU port version changed; update icudt68l.dat in" >&2
    echo "       CMakeLists.txt, fb_wasm_icu_data.cpp, and tools/build-icu-data.sh." >&2
  else
    echo "Error: ICU data not found at ${FULL_DAT}" >&2
  fi
  exit 1
fi

mkdir -p "${OUT_DIR}"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

icupkg -l "${FULL_DAT}" > "${work}/all.txt"
grep -vE "${KEEP}" "${work}/all.txt" > "${work}/remove.txt" || true

echo "keeping   $(grep -cE "${KEEP}" "${work}/all.txt") items"
echo "removing  $(wc -l < "${work}/remove.txt") items"

icupkg -r "${work}/remove.txt" "${FULL_DAT}" "${work}/icudt68l.dat"

if [[ -f "${OUT_DAT}" ]] && cmp -s "${work}/icudt68l.dat" "${OUT_DAT}"; then
  printf 'unchanged %s (%s)\n' "${OUT_DAT}" "$(du -h "${OUT_DAT}" | cut -f1)"
else
  cp "${work}/icudt68l.dat" "${OUT_DAT}"
  printf 'wrote %s (%s)\n' "${OUT_DAT}" "$(du -h "${OUT_DAT}" | cut -f1)"
fi
