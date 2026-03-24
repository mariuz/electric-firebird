# CMakeLists.txt – Emscripten cross-compilation of Firebird Embedded → WASM
#
# Prerequisites:
#   - Emscripten SDK (emsdk) activated in the current shell
#   - Firebird source tree cloned at ${FIREBIRD_SRC} (default: ./firebird-src)
#
# Usage:
#   emcmake cmake -B build -S .
#   cmake --build build -j$(nproc)
#
# The build produces:
#   build/firebird-embedded.js   – Emscripten JS glue
#   build/firebird-embedded.wasm – compiled WASM binary

cmake_minimum_required(VERSION 3.20)
project(firebird-wasm C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---------------------------------------------------------------------------
# Firebird source location
# ---------------------------------------------------------------------------
set(FIREBIRD_SRC "${CMAKE_CURRENT_SOURCE_DIR}/firebird-src"
    CACHE PATH "Path to the Firebird source tree")

if(NOT EXISTS "${FIREBIRD_SRC}/src/include/firebird.h")
  message(FATAL_ERROR
    "Firebird source tree not found at ${FIREBIRD_SRC}. "
    "Clone https://github.com/FirebirdSQL/firebird there or set -DFIREBIRD_SRC=<path>.")
endif()

# ---------------------------------------------------------------------------
# Extern library sources (mirroring upstream Firebird CMakeLists.txt)
# ---------------------------------------------------------------------------

# libtommath – arbitrary-precision integer arithmetic (used by BigInteger)
file(GLOB LIBTOMMATH_SRCS "${FIREBIRD_SRC}/extern/libtommath/*.c")

# libtomcrypt – cryptographic library (used by auth plugins)
file(GLOB_RECURSE LIBTOMCRYPT_SRCS "${FIREBIRD_SRC}/extern/libtomcrypt/src/*.c")
list(FILTER LIBTOMCRYPT_SRCS EXCLUDE REGEX ".*aes_tab\\.c")
list(FILTER LIBTOMCRYPT_SRCS EXCLUDE REGEX ".*whirltab\\.c")
list(FILTER LIBTOMCRYPT_SRCS EXCLUDE REGEX ".*sober128tab\\.c")

# decNumber – IEEE 754 decimal-arithmetic library (used by numeric types)
file(GLOB_RECURSE DECNUMBER_SRCS "${FIREBIRD_SRC}/extern/decNumber/*.c")
list(FILTER DECNUMBER_SRCS EXCLUDE REGEX ".*decBasic\\.c")
list(FILTER DECNUMBER_SRCS EXCLUDE REGEX ".*decCommon\\.c")

# re2 – regular expression library (used by SimilarToRegex)
file(GLOB RE2_LIB_SRCS "${FIREBIRD_SRC}/extern/re2/re2/*.cc")
set(RE2_UTIL_SRCS
  "${FIREBIRD_SRC}/extern/re2/util/rune.cc"
  "${FIREBIRD_SRC}/extern/re2/util/strutil.cc"
)
set(RE2_SRCS ${RE2_LIB_SRCS} ${RE2_UTIL_SRCS})

# ---------------------------------------------------------------------------
# Collect the embedded-engine source files
# ---------------------------------------------------------------------------
# The Firebird embedded engine (libfbembed) is compiled from a subset of the
# full server source.  The file lists below mirror the upstream Makefile
# targets for the embedded library.

file(GLOB_RECURSE FB_COMMON_SRCS
  "${FIREBIRD_SRC}/src/common/*.cpp"
)
# Exclude standalone test / benchmark utilities in classes/misc/ – they use
# unqualified #includes ("tree.h", "alloc.h") that don't resolve with our
# include paths and are not part of the embedded engine.
list(FILTER FB_COMMON_SRCS EXCLUDE REGEX ".*/common/classes/misc/.*")
# Exclude Boost unit tests in classes/tests/ – they require boost/test headers
# which are not available in the WASM build environment.
list(FILTER FB_COMMON_SRCS EXCLUDE REGEX ".*/common/classes/tests/.*")
# Exclude top-level common/tests/ (e.g. CommonTest.cpp) – same Boost dependency.
list(FILTER FB_COMMON_SRCS EXCLUDE REGEX ".*/common/tests/.*")
# Exclude Darwin (macOS) and Win32 platform-specific sources – the WASM build
# targets Emscripten (POSIX-compatible) so only the posix/ implementations
# are used.  Darwin files require <mach-o/dyld.h>; Win32 files require
# <windows.h> – neither is available under Emscripten.
list(FILTER FB_COMMON_SRCS EXCLUDE REGEX ".*/common/os/darwin/.*")
list(FILTER FB_COMMON_SRCS EXCLUDE REGEX ".*/common/os/win32/.*")

file(GLOB_RECURSE FB_DSQL_SRCS
  "${FIREBIRD_SRC}/src/dsql/*.cpp"
)

file(GLOB_RECURSE FB_JRD_SRCS
  "${FIREBIRD_SRC}/src/jrd/*.cpp"
)
# Exclude standalone test utilities in jrd/misc/ (e.g. evl_string_test.cpp) –
# they are not part of the embedded engine and reference constructors/types
# that may not compile in the WASM context.
list(FILTER FB_JRD_SRCS EXCLUDE REGEX ".*/jrd/misc/.*")

file(GLOB_RECURSE FB_LOCK_SRCS
  "${FIREBIRD_SRC}/src/lock/*.cpp"
)

# ---------------------------------------------------------------------------
# Include paths
# ---------------------------------------------------------------------------
set(FB_INCLUDE_DIRS
  "${FIREBIRD_SRC}/src/include"
  "${FIREBIRD_SRC}/src/include/gen"
  "${FIREBIRD_SRC}/src/common"
  "${FIREBIRD_SRC}/src/jrd"
  "${FIREBIRD_SRC}/src"
  # Extern headers required by Firebird source
  "${FIREBIRD_SRC}/extern/libtommath"
  "${FIREBIRD_SRC}/extern/libtomcrypt/src/headers"
  "${FIREBIRD_SRC}/extern/decNumber"
  # re2 – include path so that #include "re2/re2.h" and "util/*.h" resolve
  "${FIREBIRD_SRC}/extern/re2"
  # libcds – Concurrent Data Structures library; jrd/jrd.h unconditionally
  # includes <cds/threading/model.h>.  Only the headers are needed – no CDS
  # source files are compiled for the WASM build.
  "${FIREBIRD_SRC}/extern/libcds"
  # ICU headers are provided by Emscripten's ICU port (-sUSE_ICU=1).
  # No stub headers are needed – the real ICU headers supply all type/enum
  # definitions AND function declarations used by unicode_util.cpp.
)

# ---------------------------------------------------------------------------
# WASM library target
# ---------------------------------------------------------------------------
add_executable(firebird-embedded
  ${FB_COMMON_SRCS}
  ${FB_DSQL_SRCS}
  ${FB_JRD_SRCS}
  ${FB_LOCK_SRCS}
  ${LIBTOMMATH_SRCS}
  ${LIBTOMCRYPT_SRCS}
  ${DECNUMBER_SRCS}
  ${RE2_SRCS}
)

target_include_directories(firebird-embedded PRIVATE ${FB_INCLUDE_DIRS})

# Emscripten-specific definitions
target_compile_definitions(firebird-embedded PRIVATE
  EMBEDDED=1
  SUPERSERVER=1
  _REENTRANT=1
  LINUX=1
  # Emscripten's pthread implementation does not provide the GNU/Linux-specific
  # PTHREAD_RWLOCK_PREFER_WRITER_NONRECURSIVE_NP constant or
  # pthread_rwlockattr_setkind_np() function used in Firebird's rwlock.h.
  # The constant's exact value is irrelevant here because the function call
  # that consumes it is also stubbed out below.
  PTHREAD_RWLOCK_PREFER_WRITER_NONRECURSIVE_NP=1
  # libtomcrypt compile-time flags (same as upstream Firebird)
  LTC_NO_ROLC
  LTC_SOURCE
  # FB_TZDATADIR is normally set by the autotools configure; Firebird's
  # TimeZoneUtil.cpp references it at compile time.  An empty string
  # disables the external tzdata lookup – fine for WASM.
  FB_TZDATADIR=""
)

# Stub pthread_rwlockattr_setkind_np() as a no-op returning 0 (success).
# This function only sets a scheduling-preference hint for rwlocks; Firebird
# does not depend on the preference for correctness, so a silent no-op is
# safe for the single-threaded / limited-threading WASM environment.
# We use target_compile_options because CMake's target_compile_definitions
# drops function-style macros.
#
# -sUSE_ICU=1 activates Emscripten's ICU port, which downloads, builds, and
# links the ICU libraries (common + i18n) automatically.  The flag is needed
# at compile time so that Emscripten's port system injects the ICU include
# path into the compiler invocation, and at link time so the ICU libraries
# are linked into the WASM binary.
target_compile_options(firebird-embedded PRIVATE
  "-Dpthread_rwlockattr_setkind_np(a,b)=0"
  "-sUSE_ICU=1"
)

# ---------------------------------------------------------------------------
# Emscripten link flags
# ---------------------------------------------------------------------------
# - MODULARIZE: wrap output in a factory function for ES module usage
# - EXPORTED_FUNCTIONS: C API surface exposed to JS/TS callers
# - ALLOW_MEMORY_GROWTH: database buffers can grow at runtime
# - FORCE_FILESYSTEM: include MEMFS so databases live in virtual memory
# - EXPORTED_RUNTIME_METHODS: helper utilities passed through to JS
set(EMSCRIPTEN_LINK_FLAGS
  "-s MODULARIZE=1"
  "-s EXPORT_NAME='createFirebirdModule'"
  "-s EXPORTED_FUNCTIONS='[\"_fb_init\",\"_fb_create_database\",\"_fb_attach_database\",\"_fb_detach_database\",\"_fb_execute\",\"_fb_query\",\"_fb_free_result\",\"_fb_start_transaction\",\"_fb_commit\",\"_fb_rollback\",\"_malloc\",\"_free\"]'"
  "-s EXPORTED_RUNTIME_METHODS='[\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\",\"FS\",\"MEMFS\"]'"
  "-s ALLOW_MEMORY_GROWTH=1"
  "-s INITIAL_MEMORY=67108864"
  "-s FORCE_FILESYSTEM=1"
  "-s ENVIRONMENT='web,worker,node'"
  "-s SINGLE_FILE=0"
  "-s USE_ICU=1"
)

string(REPLACE ";" " " EMSCRIPTEN_LINK_FLAGS_STR "${EMSCRIPTEN_LINK_FLAGS}")
set_target_properties(firebird-embedded PROPERTIES LINK_FLAGS "${EMSCRIPTEN_LINK_FLAGS_STR}")
