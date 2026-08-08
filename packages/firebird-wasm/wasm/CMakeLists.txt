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

# Firebird master requires C++20 — src/common/classes/init.h uses concepts
# (`requires(std::invocable<...>)`), and upstream's own builds pass -std=c++20
# on every platform.  Building it as C++17 fails in the first common/ header.
set(CMAKE_CXX_STANDARD 20)
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

# libcds DHP (Dynamic Hazard Pointer) GC – dhp.cpp provides the SMR
# (Safe Memory Reclamation) implementation: smr::construct, smr::destruct,
# smr::set_memory_allocator, smr::tls, and related helpers.
# dhp.cpp compiles cleanly under Emscripten (uses only standard C++ and
# POSIX pthreads).  init.cpp and thread_data.cpp are NOT compiled here
# because their symbols are provided as lightweight stubs in
# fb_wasm_stubs.cpp (those files pull in heavy URCU dependencies).
set(FB_CDS_DHP_SRCS
  "${FIREBIRD_SRC}/extern/libcds/src/dhp.cpp"
)

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
# Exclude Boost unit tests anywhere under common/ – they require boost/test
# headers which are not available in the WASM build environment.  The pattern
# is deliberately broad: it used to name classes/tests/ and common/tests/
# individually, and Firebird 6 added common/ipc/tests/, which then broke the
# build.  Matching any tests/ directory keeps new ones from doing that again.
list(FILTER FB_COMMON_SRCS EXCLUDE REGEX ".*/common/.*/tests/.*")
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
# Exclude Boost-dependent test files in jrd/tests/ (CompressorTest.cpp,
# EngineTest.cpp) – they require Boost test headers unavailable in WASM.
list(FILTER FB_JRD_SRCS EXCLUDE REGEX ".*/jrd/tests/.*")
# Exclude Win32 platform-specific sources – they require <windows.h> which is
# unavailable under Emscripten.
list(FILTER FB_JRD_SRCS EXCLUDE REGEX ".*/jrd/os/win32/.*")
# Exclude the External Data Sources (extds/) subsystem – it connects to remote
# Firebird servers via the legacy isc_* client API (isc_attach_database,
# isc_array_*, isc_blob_*, isc_commit_transaction, etc.) and requires
# UserId::populateDpb (implemented in scl.epp, not compiled for WASM).
# Without this exclusion the linker reports 20+ undefined isc_* symbols.
# The External Data Sources feature is irrelevant in a single-process
# in-memory WASM embedded engine.
list(FILTER FB_JRD_SRCS EXCLUDE REGEX ".*/jrd/extds/.*")
# jrd/os/posix/unix.cpp provides the physical page I/O (PIO_read, PIO_write,
# PIO_open, PIO_create, PIO_close, etc.) that the page cache (cch.cpp) and
# other JRD modules require.  It compiles cleanly under Emscripten because:
#  - HAVE_PREAD / HAVE_PWRITE are set by the native-host autoconfig.h, so the
#    async-I/O fallback (which uses <aio.h>) is compiled out.
#  - build.sh removes HAVE_AIO_H, HAVE_LINUX_FALLOC_H, and SUPPORT_RAW_DEVICES
#    from autoconfig.h so neither <aio.h>, <linux/falloc.h>, nor <linux/fs.h>
#    are included.  Raw-device database support is not meaningful in the
#    in-memory WASM VFS and is fully disabled by this removal.
# Emscripten exposes pread/pwrite via its MEMFS virtual filesystem, giving the
# WASM engine real in-memory page storage without any native disk dependency.

file(GLOB_RECURSE FB_LOCK_SRCS
  "${FIREBIRD_SRC}/src/lock/*.cpp"
)
# Exclude Boost unit tests – same reason as common/ above.  These only started
# compiling once extern/boost joined the include path, and then failed at link
# because the Boost.Test *library* is not built here.
list(FILTER FB_LOCK_SRCS EXCLUDE REGEX ".*/lock/tests/.*")

# yvalve – the "Y-valve".  fb_wasm_api.cpp drives the engine through Firebird's
# public OO API, whose entry points all live here:
#
#   MasterImplementation.cpp  fb_get_master_interface(), IStatus, getDispatcher()
#   utl.cpp                   IUtil (XPB builder, date/time decoding,
#                             formatStatus, IInt128, IDecFloat*)
#   PluginManager.cpp         IPluginManager, used by fb_init() to find the
#                             statically linked engine provider
#   why.cpp                   the Y-valve object model + fb_shutdown()
#
# Globbed recursively: ConfigRoot::osConfigRoot() and osConfigInstallDir()
# live in yvalve/config/os/posix/, which a flat glob misses.
#
# gds.cpp *is* compiled.  It was previously excluded on the grounds that the
# legacy isc_* API is unused, with its gds__* helpers stubbed instead — but
# utl.cpp's IUtil implementation calls isc_encode_sql_date / isc_decode_sql_date
# and friends, and those are the exact date routines fb_query() relies on to
# decode DATE/TIME/TIMESTAMP columns.  Stubbing them would silently corrupt
# every date value the engine returns.
file(GLOB_RECURSE FB_YVALVE_SRCS
  "${FIREBIRD_SRC}/src/yvalve/*.cpp"
)
# Platform variants: keep posix only, as elsewhere in this file.
list(FILTER FB_YVALVE_SRCS EXCLUDE REGEX ".*/yvalve/.*/os/darwin/.*")
list(FILTER FB_YVALVE_SRCS EXCLUDE REGEX ".*/yvalve/.*/os/win32/.*")

# binreloc is C, not C++, so the .cpp glob above misses it.  config_root.cpp
# calls br_init_lib()/br_find_exe_dir() to locate the installation directory
# at runtime; without it the link fails on two namespaced binreloc symbols.
file(GLOB_RECURSE FB_YVALVE_C_SRCS
  "${FIREBIRD_SRC}/src/yvalve/*.c"
)
list(APPEND FB_YVALVE_SRCS ${FB_YVALVE_C_SRCS})

# ---------------------------------------------------------------------------
# gpre-generated sources
# ---------------------------------------------------------------------------
# Firebird's metadata layer is written in embedded SQL (.epp) and preprocessed
# into C++ by gpre.  build.sh runs the *boot* gpre pass — which resolves system
# tables from compiled-in definitions and needs no running database — and puts
# the results in FB_EPP_GENERATED_DIR.
#
# These were previously replaced by hand-written no-ops in fb_wasm_stubs.cpp.
# That linked, but produced an engine that could not touch metadata, which
# means it could not create a database, prepare a statement, or resolve a
# table name.  Compiling the real generated code is what makes the engine
# functional rather than merely linkable.
set(FB_EPP_GENERATED_DIR "" CACHE PATH
    "Directory holding the gpre-preprocessed .cpp sources (set by build.sh)")

set(FB_EPP_SRCS)
if(FB_EPP_GENERATED_DIR)
  file(GLOB FB_EPP_SRCS "${FB_EPP_GENERATED_DIR}/*.cpp")
endif()

if(FB_EPP_SRCS)
  list(LENGTH FB_EPP_SRCS FB_EPP_COUNT)
  message(STATUS "Using ${FB_EPP_COUNT} gpre-generated source(s) from ${FB_EPP_GENERATED_DIR}")
else()
  message(WARNING
    "No gpre-generated sources found. The metadata layer will fall back to the "
    "stubs in fb_wasm_stubs.cpp, which link but fault as soon as the engine "
    "touches metadata. Run build.sh so the boot gpre pass produces them.")
endif()

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
  # source files are compiled for the WASM build.  The few CDS symbols
  # referenced at link time are stubbed in fb_wasm_stubs.cpp.
  "${FIREBIRD_SRC}/extern/libcds"
  # Boost headers vendored by Firebird.  Firebird 6's src/StdHelper.h (reached
  # from the new common/ipc/ subsystem) includes <boost/type_traits/copy_cv.hpp>.
  # Header-only — nothing from Boost is compiled.
  "${FIREBIRD_SRC}/extern/boost"
  # ICU headers are provided by Emscripten's ICU port (-sUSE_ICU=1).
  # No stub headers are needed – the real ICU headers supply all type/enum
  # definitions AND function declarations used by unicode_util.cpp.
)

# ---------------------------------------------------------------------------
# WASM glue & stub sources
# ---------------------------------------------------------------------------
# fb_wasm_api.cpp  – extern "C" API surface exported to JavaScript via
#                    -s EXPORTED_FUNCTIONS (fb_init, fb_create_database, …).
# fb_wasm_stubs.cpp – minimal implementations of Firebird internal functions
#                     whose canonical homes (yvalve/gds.cpp, …) are not yet
#                     compiled into the WASM build.
set(FB_WASM_GLUE_SRCS
  "${CMAKE_CURRENT_SOURCE_DIR}/fb_wasm_api.cpp"
  "${CMAKE_CURRENT_SOURCE_DIR}/fb_wasm_stubs.cpp"
)

# ---------------------------------------------------------------------------
# WASM library target
# ---------------------------------------------------------------------------
add_executable(firebird-embedded
  ${FB_WASM_GLUE_SRCS}
  ${FB_COMMON_SRCS}
  ${FB_DSQL_SRCS}
  ${FB_JRD_SRCS}
  ${FB_LOCK_SRCS}
  ${FB_YVALVE_SRCS}
  ${FB_EPP_SRCS}
  ${LIBTOMMATH_SRCS}
  ${LIBTOMCRYPT_SRCS}
  ${DECNUMBER_SRCS}
  ${RE2_SRCS}
  ${FB_CDS_DHP_SRCS}
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
  # Report every unresolved symbol, not the default first 20 — with a build
  # this size, a truncated list means several link iterations to see one
  # round's worth of problems.
  "-Wl,--error-limit=0"
  "-s MODULARIZE=1"
  "-s EXPORT_NAME='createFirebirdModule'"
  "-s EXPORTED_FUNCTIONS='[\"_fb_init\",\"_fb_last_error\",\"_fb_create_database\",\"_fb_attach_database\",\"_fb_detach_database\",\"_fb_execute\",\"_fb_query\",\"_fb_free_result\",\"_fb_start_transaction\",\"_fb_commit\",\"_fb_rollback\",\"_malloc\",\"_free\"]'"
  "-s EXPORTED_RUNTIME_METHODS='[\"UTF8ToString\",\"stringToUTF8\",\"lengthBytesUTF8\",\"FS\",\"MEMFS\"]'"
  "-s ALLOW_MEMORY_GROWTH=1"
  "-s INITIAL_MEMORY=67108864"
  "-s FORCE_FILESYSTEM=1"
  "-s ENVIRONMENT='web,worker,node'"
  "-s SINGLE_FILE=0"
  "-s USE_ICU=1"
)

# ---------------------------------------------------------------------------
# Optional debug profile:  cmake -DFB_WASM_DEBUG=ON
# ---------------------------------------------------------------------------
# ASSERTIONS=2 turns WASM's terse aborts ("function signature mismatch") into
# messages naming the offending call, and --profiling-funcs keeps function
# names in stack traces without the size cost of full DWARF.
option(FB_WASM_DEBUG "Build with Emscripten assertions and named stack frames" OFF)

if(FB_WASM_DEBUG)
  message(STATUS "FB_WASM_DEBUG=ON: assertions and named stack frames enabled")
  list(APPEND EMSCRIPTEN_LINK_FLAGS
    "-s ASSERTIONS=2"
    "--profiling-funcs"
    "-g"
  )
endif()

# Compile a few files with DWARF so their frames carry line numbers.  Doing
# this for the whole engine would be enormous; naming the files under
# investigation keeps the rebuild to seconds.
set(FB_WASM_DEBUG_SOURCES "" CACHE STRING
    "Semicolon-separated source paths to compile with -g for line numbers")
if(FB_WASM_DEBUG AND FB_WASM_DEBUG_SOURCES)
  foreach(dbg_src ${FB_WASM_DEBUG_SOURCES})
    set_source_files_properties("${dbg_src}" PROPERTIES COMPILE_OPTIONS "-g")
    message(STATUS "  debug line info: ${dbg_src}")
  endforeach()
endif()

string(REPLACE ";" " " EMSCRIPTEN_LINK_FLAGS_STR "${EMSCRIPTEN_LINK_FLAGS}")
set_target_properties(firebird-embedded PROPERTIES LINK_FLAGS "${EMSCRIPTEN_LINK_FLAGS_STR}")
