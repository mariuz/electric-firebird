#!/usr/bin/env bash
# build.sh – Build Firebird Embedded as a WASM module via Emscripten
#
# Usage:
#   ./build.sh [--firebird-src <path>] [--output <dir>]
#
# Requirements:
#   - Emscripten SDK (emsdk) must be activated  (source emsdk_env.sh)
#   - git, cmake ≥ 3.20, make / ninja
#
# The script will:
#   1. Clone the Firebird source (if not already present)
#   2. Run the Emscripten CMake build
#   3. Copy the resulting .wasm + .js artefacts to the output directory

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIREBIRD_SRC="${SCRIPT_DIR}/firebird-src"
OUTPUT_DIR="${SCRIPT_DIR}/../dist/wasm"

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
  echo "Cloning Firebird source into ${FIREBIRD_SRC}…"
  git clone --depth 1 https://github.com/FirebirdSQL/firebird.git "${FIREBIRD_SRC}"
fi

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
