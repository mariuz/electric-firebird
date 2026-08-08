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
#   1. Initialise the Firebird git submodule (tracks upstream master)
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

    if git -C "${FIREBIRD_SRC}" apply --whitespace=nowarn "$p" 2>/dev/null; then
      continue
    fi

    # Already applied?  `git apply --reverse --check` succeeding means the
    # change is present, which is fine on a re-run.
    if git -C "${FIREBIRD_SRC}" apply --reverse --check "$p" 2>/dev/null; then
      echo "    (already applied)"
      continue
    fi

    # Anything else is a genuine failure.  This used to be swallowed with a
    # "skipping" message, which is how two of these patches went unnoticed
    # for so long: 0002 was structurally corrupt and 0003 had drifted, so
    # neither had ever been applied to the tree being compiled.
    echo "Error: patch $(basename "$p") does not apply to ${FIREBIRD_SRC}." >&2
    echo "       Firebird has moved on; regenerate the patch against the" >&2
    echo "       current submodule revision:" >&2
    echo "         (cd ${FIREBIRD_SRC} && \$EDITOR <file> && git diff <file>)" >&2
    git -C "${FIREBIRD_SRC}" apply --whitespace=nowarn "$p" >&2 || true
    exit 1
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
# src/CMakeLists.txt lists the message-database SQL inputs as sources of a
# custom target, and CMake's Generate step fails outright if any are missing.
# Most are produced by a full Firebird build, which we do not run.  Create
# empty placeholders for whichever are absent — the message database is not
# built here, so their content is irrelevant.  Enumerated from the target's
# source list rather than named one at a time, because the list grows between
# Firebird versions (6.0 added history2.sql).
mkdir -p "${FIREBIRD_SRC}/src/msgs"
for msg_sql in facilities2 history2 locales messages2 msg symbols2 \
               system_errors2 transmsgs.de_DE2 transmsgs.fr_FR2; do
  [[ -f "${FIREBIRD_SRC}/src/msgs/${msg_sql}.sql" ]] || \
    touch "${FIREBIRD_SRC}/src/msgs/${msg_sql}.sql"
done

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
#
# A failed configure still leaves a CMakeCache.txt behind, which would make
# every later run skip this step and fail further down with a confusing
# "did not produce autoconfig.h".  Treat a cache without autoconfig.h as
# evidence of a failed configure and start over.
if [[ -f "${NATIVE_BUILD_DIR}/CMakeCache.txt" && ! -f "${AUTOCONFIG_NATIVE}" ]]; then
  echo "Discarding incomplete native build directory…"
  rm -rf "${NATIVE_BUILD_DIR}"
fi

if [[ ! -f "${NATIVE_BUILD_DIR}/CMakeCache.txt" ]]; then
  echo "Configuring native Firebird build (host compiler)…"
  mkdir -p "${NATIVE_BUILD_DIR}"
  # Firebird's top-level CMakeLists.txt still declares
  # cmake_minimum_required(VERSION 2.8.12).  CMake 4 removed compatibility
  # with < 3.5 and refuses to configure at all.  CMAKE_POLICY_VERSION_MINIMUM
  # tells it to assume 3.5 policies instead, which keeps the fix on our side
  # rather than patching upstream Firebird.
  cmake \
    -B "${NATIVE_BUILD_DIR}" \
    -S "${FIREBIRD_SRC}" \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
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

# ── Remove HAVE_AIO_H for Emscripten ─────────────────────────────────────────
# The native configure detects <aio.h> on Linux and sets HAVE_AIO_H.
# Emscripten does not provide <aio.h> (async I/O is Linux-kernel-specific).
# unix.cpp guards #include <aio.h> with #ifdef HAVE_AIO_H, and the actual
# aio_read/aio_write calls are further guarded by
# #if !(defined HAVE_PREAD && defined HAVE_PWRITE) – since Emscripten provides
# both pread and pwrite, that code is excluded anyway.  Removing HAVE_AIO_H
# prevents the stray #include <aio.h> from failing compilation.
sed -i '/^#define HAVE_AIO_H/d' "${AUTOCONFIG_SRC}"

# ── Remove HAVE_LINUX_FALLOC_H for Emscripten ────────────────────────────────
# The native configure may detect <linux/falloc.h> and set HAVE_LINUX_FALLOC_H.
# Emscripten does not provide Linux kernel headers.
# unix.cpp guards both #include <linux/falloc.h> and the fallocate() call with
# #ifdef HAVE_LINUX_FALLOC_H, so removing the define skips both cleanly.
# (A no-op fallocate() stub in fb_wasm_stubs.cpp handles any other callers.)
sed -i '/^#define HAVE_LINUX_FALLOC_H/d' "${AUTOCONFIG_SRC}"

# ── Remove SUPPORT_RAW_DEVICES for Emscripten ────────────────────────────────
# The native configure on Linux may detect raw-device support and set
# SUPPORT_RAW_DEVICES.  unix.cpp guards a block with this define that
# includes <sys/ioctl.h> and (when LINUX is also defined) <linux/fs.h>.
# Emscripten does not ship Linux kernel headers, so <linux/fs.h> is not
# available.  Raw-device databases (using a block device as a database
# file) are not supported in the WASM build; removing the define fully
# disables that code path.  The PIO functions provided by unix.cpp are
# still compiled and provide real in-memory I/O via Emscripten's MEMFS.
sed -i '/^#define SUPPORT_RAW_DEVICES/d' "${AUTOCONFIG_SRC}"

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
