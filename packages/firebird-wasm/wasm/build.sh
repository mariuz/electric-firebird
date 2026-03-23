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
#   1. Clone the Firebird source at a pinned stable tag (if not already present)
#   2. Bootstrap Firebird: run a native cmake configure to generate autoconfig.h
#   3. Run the Emscripten CMake build
#   4. Copy the resulting .wasm + .js artefacts to the output directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIREBIRD_SRC="${SCRIPT_DIR}/firebird-src"
OUTPUT_DIR="${SCRIPT_DIR}/../dist/wasm"

# Pinned Firebird release – update together with any source-level changes.
FIREBIRD_TAG="v5.0.3"

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

# ── Clone Firebird source if needed ─────────────────────────────────────────
if [[ ! -d "${FIREBIRD_SRC}/src" ]]; then
  echo "Cloning Firebird ${FIREBIRD_TAG} into ${FIREBIRD_SRC}…"
  git clone --depth 1 --branch "${FIREBIRD_TAG}" \
    https://github.com/FirebirdSQL/firebird.git "${FIREBIRD_SRC}"
fi

# ── Bootstrap: generate autoconfig.h via native (host) CMake configure ───────
# Firebird's source tree requires a configure step to produce
# src/include/gen/autoconfig.h before any compilation (including
# cross-compilation with Emscripten) can succeed.
#
# Some optional build targets (makeHeader, message databases) reference
# files that are absent in the released source tree; those cmake errors
# are non-fatal for our purposes because configure_file() for autoconfig.h
# runs before those targets.  We use `|| true` to allow cmake to exit
# non-zero while still capturing the generated header.
NATIVE_BUILD_DIR="${SCRIPT_DIR}/build-native-config"
AUTOCONFIG_NATIVE="${NATIVE_BUILD_DIR}/src/include/gen/autoconfig.h"
AUTOCONFIG_SRC="${FIREBIRD_SRC}/src/include/gen/autoconfig.h"

if [[ ! -f "${AUTOCONFIG_SRC}" ]]; then
  echo "Bootstrapping Firebird source (generating autoconfig.h)…"
  mkdir -p "${NATIVE_BUILD_DIR}"
  cmake \
    -B "${NATIVE_BUILD_DIR}" \
    -S "${FIREBIRD_SRC}" \
    -DCMAKE_BUILD_TYPE=Release \
    -Wno-dev 2>&1 || true

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

# ── Patch autoconfig.h for 32-bit WASM ──────────────────────────────────────
# autoconfig.h is generated on a 64-bit host where sizeof(long)==8.
# Emscripten targets 32-bit WASM where sizeof(long)==4.  Without this
# patch, type size mismatches cause compilation errors.
sed -i 's/^#define SIZEOF_LONG[[:space:]]*8/#define SIZEOF_LONG 4/' "${AUTOCONFIG_SRC}"

# ── CMake configure + build ──────────────────────────────────────────────────
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
