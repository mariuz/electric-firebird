#!/usr/bin/env bash
# build.sh – Build Firebird Embedded as a WASM module via Emscripten
#
# Usage:
#   ./build.sh [--firebird-src <path>] [--output <dir>]
#
# Requirements:
#   - Emscripten SDK (emsdk) must be activated  (source emsdk_env.sh)
#   - git, cmake ≥ 3.20, make / ninja
#   - A host C++ compiler (gcc/clang) for the native bootstrap step
#
# The script will:
#   1. Initialise the Firebird git submodule (pinned to v5.0.3)
#   2. Apply WASM / ICU patches from wasm/patches/
#   3. Bootstrap Firebird: run a native cmake configure to generate autoconfig.h
#   4. Build the btyacc parser generator and run it to produce parse.h/parse.cpp
#   5. Run the Emscripten CMake build
#   6. Copy the resulting .wasm + .js artefacts to the output directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
FIREBIRD_SRC="${SCRIPT_DIR}/firebird-src"
OUTPUT_DIR="${SCRIPT_DIR}/../dist/wasm"
PATCHES_DIR="${SCRIPT_DIR}/patches"

# ── Parse arguments ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --firebird-src) FIREBIRD_SRC="$2"; shift 2 ;;
    --output)       OUTPUT_DIR="$2";   shift 2 ;;
    -h|--help)
      echo "Usage: $0 [--firebird-src <path>] [--output <dir>]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── Verify Emscripten ────────────────────────────────────────────────────────
if ! command -v emcc &>/dev/null; then
  echo "Error: emcc not found. Activate Emscripten SDK first:" >&2
  echo "  source <emsdk>/emsdk_env.sh" >&2
  exit 1
fi

echo "Using Emscripten: $(emcc --version | head -1)"

# ── Initialise Firebird submodule if needed ──────────────────────────────────
if [[ ! -d "${FIREBIRD_SRC}/src" ]]; then
  echo "Initialising Firebird submodule…"
  git -C "${REPO_ROOT}" submodule update --init --depth 1 \
    packages/firebird-wasm/wasm/firebird-src
fi

# ── Apply WASM / ICU patches ────────────────────────────────────────────────
# Patches in wasm/patches/ modify the Firebird source so it can be compiled
# with ICU support and loaded as a static library under Emscripten/WASM.
# Each patch is applied once; a marker file tracks what has already been
# applied so that re-running the build is idempotent.
PATCH_MARKER="${FIREBIRD_SRC}/.wasm-patches-applied"
if [[ ! -f "${PATCH_MARKER}" ]]; then
  echo "Applying WASM / ICU patches…"
  for p in "${PATCHES_DIR}"/00*.patch; do
    [[ -f "$p" ]] || continue
    echo "  → $(basename "$p")"
    # Use git apply with relaxed matching; fall back to patch(1)
    git -C "${FIREBIRD_SRC}" apply --whitespace=nowarn "$p" 2>/dev/null \
      || patch -d "${FIREBIRD_SRC}" -p1 --forward --batch < "$p" \
      || echo "    (already applied or not applicable – skipping)"
  done
  touch "${PATCH_MARKER}"
fi

# ── Bootstrap: native (host) CMake configure ─────────────────────────────────
# Firebird's source tree requires a configure step to produce
# src/include/gen/autoconfig.h before any compilation (including
# cross-compilation with Emscripten) can succeed.
#
# The same native build directory is also used to build the btyacc parser
# generator tool and run the "parse" target to produce parse.h / parse.cpp.
#
# The Firebird cmake checks for ICU headers on UNIX and exits with
# FATAL_ERROR if they are not found.  We pass -DICU_INCLUDE_DIR=/usr/include
# to satisfy that check without requiring the full libicu-dev package.
#
# Some optional build targets (makeHeader, message databases) reference
# generated files that are absent from the source tree.  CMake's Generate
# step fails entirely if add_executable / add_custom_target references
# source files that do not exist, which prevents *any* Makefile from being
# produced (even for targets we *do* need, like "parse").
# Create minimal stubs so the cmake Generate step succeeds.
if [[ ! -f "${FIREBIRD_SRC}/src/misc/makeHeader.cpp" ]]; then
  mkdir -p "${FIREBIRD_SRC}/src/misc"
  echo 'int main() { return 0; }' > "${FIREBIRD_SRC}/src/misc/makeHeader.cpp"
fi
if [[ ! -f "${FIREBIRD_SRC}/src/msgs/facilities2.sql" ]]; then
  mkdir -p "${FIREBIRD_SRC}/src/msgs"
  touch "${FIREBIRD_SRC}/src/msgs/facilities2.sql"
fi

NATIVE_BUILD_DIR="${SCRIPT_DIR}/build-native-config"
AUTOCONFIG_NATIVE="${NATIVE_BUILD_DIR}/src/include/gen/autoconfig.h"
AUTOCONFIG_SRC="${FIREBIRD_SRC}/src/include/gen/autoconfig.h"
PARSE_H_NATIVE="${NATIVE_BUILD_DIR}/src/include/gen/parse.h"
PARSE_H_SRC="${FIREBIRD_SRC}/src/include/gen/parse.h"
PARSE_CPP_NATIVE="${NATIVE_BUILD_DIR}/src/dsql/parse.cpp"
PARSE_CPP_SRC="${FIREBIRD_SRC}/src/dsql/parse.cpp"

# Ensure native build directory is configured (needed for both autoconfig.h
# generation and the parse target).  We keep `|| true` as a safety net in
# case other optional cmake targets fail, but the stubs above should allow
# the Generate step to succeed and produce valid Makefiles.
if [[ ! -f "${NATIVE_BUILD_DIR}/CMakeCache.txt" ]]; then
  echo "Configuring native Firebird build (host compiler)…"
  mkdir -p "${NATIVE_BUILD_DIR}"
  cmake \
    -B "${NATIVE_BUILD_DIR}" \
    -S "${FIREBIRD_SRC}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DICU_INCLUDE_DIR=/usr/include \
    -Wno-dev 2>&1 || true
fi

# ── Step 1: autoconfig.h ─────────────────────────────────────────────────────
if [[ ! -f "${AUTOCONFIG_SRC}" ]]; then
  echo "Copying autoconfig.h from native build…"
  if [[ -f "${AUTOCONFIG_NATIVE}" ]]; then
    mkdir -p "${FIREBIRD_SRC}/src/include/gen"
    cp "${AUTOCONFIG_NATIVE}" "${AUTOCONFIG_SRC}"
    echo "autoconfig.h generated and copied to source tree."
  else
    echo "Error: native CMake configure did not produce autoconfig.h." >&2
    echo "       Ensure cmake and a host C++ compiler (gcc/clang) are installed." >&2
    exit 1
  fi
fi

# ── Step 2: parse.h + parse.cpp (btyacc parser generation) ──────────────────
# Firebird's SQL parser is generated from src/dsql/parse.y by the btyacc
# (backtracking YACC) tool that ships in extern/btyacc/.  The upstream
# CMakeLists.txt defines a "parse" custom target that:
#   1. Builds the btyacc executable from extern/btyacc/*.c
#   2. Runs btyacc on parse.y with the Firebird skeleton (btyacc_fb.ske)
#   3. Post-processes token defines to add TOK_ prefixes
#   4. Copies the result to include/gen/parse.h and dsql/parse.cpp
#
# We build only the "parse" target (and its btyacc dependency) using the
# native host compiler.  The generated files are then copied into the
# source tree so the Emscripten cross-compilation can find them.
if [[ ! -f "${PARSE_H_SRC}" ]]; then
  echo "Generating parse.h and parse.cpp (building btyacc + parse target)…"
  cmake --build "${NATIVE_BUILD_DIR}" --target parse -j"$(nproc)" 2>&1 || true

  if [[ -f "${PARSE_H_NATIVE}" ]]; then
    mkdir -p "${FIREBIRD_SRC}/src/include/gen"
    cp "${PARSE_H_NATIVE}" "${PARSE_H_SRC}"
    echo "parse.h generated and copied to source tree."
  else
    echo "Error: native build did not produce parse.h." >&2
    echo "       Ensure a host C compiler is installed (btyacc is built from C)." >&2
    exit 1
  fi

  if [[ -f "${PARSE_CPP_NATIVE}" ]]; then
    cp "${PARSE_CPP_NATIVE}" "${PARSE_CPP_SRC}"
    echo "parse.cpp generated and copied to source tree."
  else
    echo "Error: native build did not produce parse.cpp." >&2
    exit 1
  fi
fi

# ── Patch autoconfig.h for 32-bit WASM ──────────────────────────────────────
# autoconfig.h is generated on a 64-bit host where sizeof(long)==8, so it
# contains "#define SIZEOF_LONG 8".  Emscripten targets 32-bit WASM where
# sizeof(long)==4.  Without this patch fb_types.h defines SLONG as `int`,
# while types_pub.h (which doesn't see _LP64) redefines ISC_LONG as
# `signed long`, causing a "typedef redefinition with different types" error.
# No backup is needed: this file is a generated copy we placed here ourselves;
# the canonical source is ${NATIVE_BUILD_DIR}/src/include/gen/autoconfig.h.
# The substitution is idempotent (no-op if already patched to 4).
sed -i 's/^#define SIZEOF_LONG[[:space:]]*8/#define SIZEOF_LONG 4/' "${AUTOCONFIG_SRC}"

# ── Patch GETTIMEOFDAY for Emscripten ────────────────────────────────────────
# The native cmake configure detects that gettimeofday() does NOT accept a
# second (timezone) argument, so autoconfig.h ends up with:
#   #define GETTIMEOFDAY(x) gettimeofday((x))
# However Emscripten's gettimeofday() *requires* two arguments (the second
# may be NULL).  Replace the 1-arg form with a 2-arg form.
# The substitution is idempotent.
sed -i 's|^#define GETTIMEOFDAY(x) gettimeofday((x))[[:space:]]*$|#define GETTIMEOFDAY(x) gettimeofday((x), (struct timezone *)0)|' "${AUTOCONFIG_SRC}"

# ── Remove HAVE_ZLIB_H for Emscripten ───────────────────────────────────────
# The native configure detects zlib on the host and sets HAVE_ZLIB_H, which
# causes zip.h to #include <zlib.h>.  Emscripten does not ship zlib headers.
# ZIP compression is used for wire-protocol compression (client ↔ server),
# which is irrelevant for the embedded WASM engine.  Both zip.h and zip.cpp
# guard their content with #ifdef HAVE_ZLIB_H, so removing the define makes
# them compile to empty stubs.  The deletion is idempotent.
sed -i '/^#define HAVE_ZLIB_H/d' "${AUTOCONFIG_SRC}"

# ── CMake configure + build ──────────────────────────────────────────────────
# NOTE: The CMakeLists.txt uses -sUSE_ICU=1 which causes Emscripten to
# download, build, and link ICU automatically (both common and i18n
# libraries).  This provides full Unicode support (collation, case
# mapping, calendar functions) for the embedded engine.
#
# ICU Data File (icudt):
# Emscripten's ICU port embeds a minimal ICU data set into the compiled
# WASM binary.  If your application requires additional locale data beyond
# the default, you may need to package a full icudt*.dat file using
# Emscripten's --preload-file flag.  If you see U_MISSING_RESOURCE_ERROR
# at runtime, this is the likely cause.  Add to EMSCRIPTEN_LINK_FLAGS in
# CMakeLists.txt:
#   "--preload-file /path/to/icudt<ver>l.dat@/usr/share/icu/<ver>/icudt<ver>l.dat"
BUILD_DIR="${SCRIPT_DIR}/build"
mkdir -p "${BUILD_DIR}"

echo "Configuring with Emscripten CMake toolchain…"
emcmake cmake \
  -B "${BUILD_DIR}" \
  -S "${SCRIPT_DIR}" \
  -DFIREBIRD_SRC="${FIREBIRD_SRC}" \
  -DCMAKE_BUILD_TYPE=Release

echo "Building WASM module…"
cmake --build "${BUILD_DIR}" -j"$(nproc)"

# ── Copy artefacts ───────────────────────────────────────────────────────────
mkdir -p "${OUTPUT_DIR}"
cp "${BUILD_DIR}/firebird-embedded.js"   "${OUTPUT_DIR}/"
cp "${BUILD_DIR}/firebird-embedded.wasm" "${OUTPUT_DIR}/"

echo ""
echo "Build complete:"
ls -lh "${OUTPUT_DIR}/firebird-embedded".*
