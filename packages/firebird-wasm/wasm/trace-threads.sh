#!/usr/bin/env bash
# trace-threads.sh – list the threads the engine starts, by C API call.
#
# Step 1 of docs/plans/sab-free-build.md.  Relinks the existing build tree
# (wasm/build, from build.sh) with --profiling-funcs into wasm/build-trace,
# about half a minute with no recompile, then makes the glue log a stack at
# every pthread_create, then drives the C API with trace-threads.cjs once per
# configuration and prints which threads each call started.
#
# Usage:  ./trace-threads.sh ["firebird.conf text" ...]
#   With no argument, the shipped configuration and GCPolicy = cooperative.
#   Lines of a conf text are separated by \n.
#
# Requirements: an activated emsdk and a completed build.sh run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR="${SCRIPT_DIR}/build"
TRACE_DIR="${SCRIPT_DIR}/build-trace"
LINK_SCRIPT="${BUILD_DIR}/CMakeFiles/firebird-embedded.dir/link.txt"

if [[ ! -f "${LINK_SCRIPT}" ]]; then
  echo "No build tree at ${BUILD_DIR}: run build.sh first." >&2
  exit 1
fi
command -v em++ >/dev/null || { echo "em++ not found: source emsdk_env.sh first." >&2; exit 1; }

mkdir -p "${TRACE_DIR}"
# CMake's own link script, with function names kept and the output moved.
# Run through cmake -E cmake_link_script, which is how make runs it: the
# script's quoting is written for that, not for a shell.
TRACE_LINK="${BUILD_DIR}/CMakeFiles/firebird-embedded.dir/link-trace.txt"
sed "s#-o firebird-embedded.js#--profiling-funcs -o ${TRACE_DIR}/firebird-embedded.js#" \
  "${LINK_SCRIPT}" > "${TRACE_LINK}"
echo "Relinking with function names into ${TRACE_DIR} ..."
(cd "${BUILD_DIR}" && cmake -E cmake_link_script "${TRACE_LINK}" 2>&1 | grep -v "warning:" || true)
rm -f "${TRACE_LINK}"
[[ -f "${TRACE_DIR}/firebird-embedded.wasm" ]] || { echo "Relink failed." >&2; exit 1; }

# Every thread the engine starts goes through ___pthread_create_js in the glue.
# Log the wasm frames above it there, when FB_THREAD_LOG names a file.
node - "${TRACE_DIR}/firebird-embedded.js" <<'EOF'
const fs = require('fs');
const file = process.argv[2];
const anchor = 'var ___pthread_create_js=(pthread_ptr,attr,startRoutine,arg)=>{';
let glue = fs.readFileSync(file, 'utf8');
if (glue.split(anchor).length !== 2) {
  console.error('pthread_create hook point not found exactly once in the glue');
  process.exit(1);
}
const hook = 'if(globalThis.process?.env?.FB_THREAD_LOG){Error.stackTraceLimit=40;'
  + 'var st=new Error().stack.split("\\n").filter(l=>l.includes("wasm://"))'
  + '.map(l=>l.trim().replace(/^at /,"").replace(/ \\(wasm:.*$/,""));'
  + 'require("node:fs").appendFileSync(process.env.FB_THREAD_LOG,'
  + 'JSON.stringify({pthread:ENVIRONMENT_IS_PTHREAD,stack:st})+"\\n")}';
fs.writeFileSync(file, glue.split(anchor).join(anchor + hook));
EOF

if [[ $# -eq 0 ]]; then
  set -- "" "GCPolicy = cooperative"
fi
for conf in "$@"; do
  echo
  echo "firebird.conf: ${conf:-(none, as shipped)}"
  node "${SCRIPT_DIR}/trace-threads.cjs" "${TRACE_DIR}" "${conf}"
done
