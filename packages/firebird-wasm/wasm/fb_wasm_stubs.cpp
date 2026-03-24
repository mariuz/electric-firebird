/*
 * fb_wasm_stubs.cpp – Stub / minimal implementations of Firebird internal
 * functions that are referenced by the compiled source files but whose
 * canonical implementations live in modules not yet included in the WASM
 * build (e.g. yvalve/gds.cpp, yvalve/why.cpp).
 *
 * Each stub either provides the real algorithm (when it is small and
 * self-contained) or a safe no-op, so the linker can resolve the symbol
 * without pulling in heavyweight modules with platform-specific
 * dependencies.
 */

/* These headers resolve via the target_include_directories set in
   CMakeLists.txt (which adds firebird-src/src/include, etc.).
   firebird.h transitively pulls in common.h and fb_types.h which
   define SLONG, SSHORT, UCHAR, TEXT, API_ROUTINE, etc. */
#include "firebird.h"
#include "firebird/impl/types_pub.h"

#include <cstdarg>
#include <cstdio>
#include <cstdlib>
#include <cstring>

/* -----------------------------------------------------------------------
 * gds__vax_integer  –  pick up (and convert) a VAX-style integer of
 *                       variable length (1–4 bytes, little-endian).
 *
 * This is a real implementation copied from yvalve/gds.cpp because
 * StatementMetadata.cpp calls it heavily and the algorithm is trivial.
 * ----------------------------------------------------------------------- */
extern "C"
SLONG API_ROUTINE gds__vax_integer(const UCHAR* ptr, SSHORT length)
{
    if (!ptr || length <= 0 || length > 4)
        return 0;

    SLONG value = 0;
    int shift = 0;

    /* Process the first (length-1) bytes as unsigned */
    while (--length > 0)
    {
        value += ((SLONG) *ptr++) << shift;
        shift += 8;
    }

    /* Sign-extend the most significant (final) byte */
    value += ((SLONG)(SCHAR) *ptr) << shift;

    return value;
}

/* -----------------------------------------------------------------------
 * isc_portable_integer  –  pick up a Little-Endian integer of variable
 *                           length (1–8 bytes) without sign extension.
 *
 * Real implementation from yvalve/gds.cpp.  Used by TimeZoneUtil.cpp.
 * ----------------------------------------------------------------------- */
extern "C"
SINT64 API_ROUTINE isc_portable_integer(const UCHAR* ptr, SSHORT length)
{
    if (!ptr || length <= 0 || length > 8)
        return 0;

    SINT64 value = 0;
    int shift = 0;

    while (--length > 0)
    {
        value += ((SINT64) *ptr++) << shift;
        shift += 8;
    }

    value += ((SINT64)(UCHAR) *ptr) << shift;

    return value;
}

/* -----------------------------------------------------------------------
 * gds__log  –  post a message to the Firebird log file.
 *
 * In the WASM environment there is no log file.  We write to stderr
 * (which Emscripten maps to console.warn) so diagnostic messages are
 * still visible during development.
 * ----------------------------------------------------------------------- */
extern "C"
void API_ROUTINE gds__log(const TEXT* text, ...)
{
    if (!text)
        return;

    va_list args;
    va_start(args, text);
    vfprintf(stderr, text, args);
    fputc('\n', stderr);
    va_end(args);
}

/* -----------------------------------------------------------------------
 * gds__log_status  –  log a Firebird status vector.
 *
 * Simplified implementation: just log the database name so we know
 * which database triggered the error.
 * ----------------------------------------------------------------------- */
extern "C"
void API_ROUTINE gds__log_status(const TEXT* database, const ISC_STATUS* status_vector)
{
    (void)status_vector;
    if (database && *database)
        fprintf(stderr, "gds__log_status: database=%s\n", database);
}

/* -----------------------------------------------------------------------
 * fb_get_master_interface  –  return the singleton IMaster*.
 *
 * The real implementation lives in yvalve/why.cpp and bootstraps the
 * entire provider/plugin infrastructure.  In the WASM stub build we
 * return NULL; the glue layer (fb_wasm_api.cpp) will provide its own
 * initialisation path once the engine is fully wired up.
 * ----------------------------------------------------------------------- */
namespace Firebird {
    class IMaster;
}

extern "C"
Firebird::IMaster* API_ROUTINE fb_get_master_interface()
{
    return nullptr;
}

/* -----------------------------------------------------------------------
 * fb_interpret  –  format one status-vector element into a text buffer.
 *
 * The real implementation in yvalve/gds.cpp walks the status vector and
 * produces human-readable messages.  For the WASM stub we just return 0
 * (no message formatted).
 * ----------------------------------------------------------------------- */
extern "C"
SLONG API_ROUTINE fb_interpret(char* buffer, unsigned int bufsize,
                               const ISC_STATUS** vector)
{
    if (buffer && bufsize > 0)
        buffer[0] = '\0';
    (void)vector;
    return 0;
}

/* -----------------------------------------------------------------------
 * gds__msg_lookup  –  look up an error message by facility + number.
 *
 * The real implementation reads from firebird.msg on disk.  In the WASM
 * environment there is no message file; return -1 (not found).
 * ----------------------------------------------------------------------- */
extern "C"
SSHORT API_ROUTINE gds__msg_lookup(void* handle, USHORT facility,
                                   USHORT number, USHORT length,
                                   TEXT* buffer, USHORT* flags)
{
    (void)handle;
    (void)facility;
    (void)number;
    (void)flags;
    if (buffer && length > 0)
        buffer[0] = '\0';
    return -1;
}

/* -----------------------------------------------------------------------
 * gds__prefix_lock  –  build a lock-file path from the Firebird prefix.
 *
 * In WASM there is no filesystem lock directory.  We set the output to
 * "/tmp/" + root so callers get a syntactically valid path.
 * ----------------------------------------------------------------------- */
extern "C"
void API_ROUTINE gds__prefix_lock(TEXT* string, const TEXT* root)
{
    if (!string)
        return;
    strcpy(string, "/tmp/");
    if (root)
        strcat(string, root);
}

/* -----------------------------------------------------------------------
 * gds__alloc / gds__free  –  legacy memory allocation wrappers.
 *
 * The real implementations in yvalve/gds.cpp delegate to the Firebird
 * memory pool.  For the WASM stub we use standard malloc/free.
 * ----------------------------------------------------------------------- */
extern "C"
void* API_ROUTINE gds__alloc(SLONG size)
{
    return malloc(size > 0 ? (size_t)size : 1);
}

extern "C"
ULONG API_ROUTINE gds__free(void* blk)
{
    free(blk);
    return 0;
}

/* -----------------------------------------------------------------------
 * fallocate  –  Linux-specific file space pre-allocation.
 *
 * This is a Linux system call not available in Emscripten.  WASM uses
 * an in-memory virtual filesystem, so pre-allocation is meaningless.
 * Return 0 (success) to satisfy callers in isc_sync.cpp.
 * ----------------------------------------------------------------------- */
extern "C"
int fallocate(int fd, int mode, off_t offset, off_t len)
{
    (void)fd;
    (void)mode;
    (void)offset;
    (void)len;
    return 0;
}

/* -----------------------------------------------------------------------
 * gds__prefix  –  build a path from the Firebird installation prefix.
 *
 * In WASM there is no installation directory.  We return "/firebird/" +
 * root so callers get a syntactically valid path inside the virtual FS.
 * ----------------------------------------------------------------------- */
extern "C"
void API_ROUTINE gds__prefix(TEXT* string, const TEXT* root)
{
    if (!string)
        return;
    strcpy(string, "/firebird/");
    if (root)
        strcat(string, root);
}

/* -----------------------------------------------------------------------
 * gds__prefix_msg  –  build a path for the message file.
 *
 * Same pattern as gds__prefix – return a path under the virtual FS.
 * ----------------------------------------------------------------------- */
extern "C"
void API_ROUTINE gds__prefix_msg(TEXT* string, const TEXT* root)
{
    if (!string)
        return;
    strcpy(string, "/firebird/");
    if (root)
        strcat(string, root);
}

/* -----------------------------------------------------------------------
 * sem_timedwait  –  POSIX semaphore wait with timeout.
 *
 * Emscripten does not provide sem_timedwait.  In the single-threaded
 * WASM environment, blocking waits would deadlock, so we attempt a
 * non-blocking sem_trywait and return ETIMEDOUT on failure.
 * ----------------------------------------------------------------------- */
#include <semaphore.h>
#include <errno.h>
#include <time.h>

extern "C"
int sem_timedwait(sem_t* sem, const struct timespec* abs_timeout)
{
    (void)abs_timeout;
    /* Try a non-blocking decrement first. If that fails, return
       ETIMEDOUT rather than blocking (which would deadlock the
       single-threaded WASM runtime). */
    if (sem_trywait(sem) == 0)
        return 0;
    errno = ETIMEDOUT;
    return -1;
}

/* -----------------------------------------------------------------------
 * Stubs for functions defined in .epp (embedded-preprocessor) generated
 * files that are not yet available in the WASM build.
 *
 * The .epp → .cpp generation requires the gpre preprocessor (which needs
 * a running Firebird database), so these files (met.epp, scl.epp,
 * metd.epp) are not compiled for WASM.  Minimal stubs are provided so
 * the linker can resolve the symbols.
 *
 * We include the actual Firebird headers that declare these functions to
 * guarantee that the C++ name-mangling matches what callers expect.
 * ----------------------------------------------------------------------- */

#include "firebird/impl/types_pub.h"

/* Forward declarations – just enough for the prototypes below.
   Full headers (scl.h, met_proto.h, metd_proto.h) pull in too many
   transitive dependencies, so we replicate only the needed bits. */
namespace Jrd {
    class thread_db;
    class jrd_tra;
    class jrd_rel;
    class MetaName;
}

/* METD_get_charset_bpc – return bytes-per-character for a charset id.
 * Declared in dsql/metd_proto.h as:
 *   USHORT METD_get_charset_bpc(Jrd::jrd_tra*, SSHORT);
 * Returns 1 (single-byte) as a safe default. */
USHORT METD_get_charset_bpc(Jrd::jrd_tra*, SSHORT)
{
    return 1;
}

/* MET_lookup_relation – look up a relation (table/view) by name.
 * Declared in jrd/met_proto.h as:
 *   Jrd::jrd_rel* MET_lookup_relation(Jrd::thread_db*, const Jrd::MetaName&);
 * Returns nullptr (not found) when metadata tables are unavailable. */
Jrd::jrd_rel* MET_lookup_relation(Jrd::thread_db*, const Jrd::MetaName&)
{
    return nullptr;
}

/* MET_lookup_field – look up a field in a relation by name.
 * Declared in jrd/met_proto.h as:
 *   int MET_lookup_field(Jrd::thread_db*, Jrd::jrd_rel*, const Jrd::MetaName&);
 * Returns -1 (not found). */
int MET_lookup_field(Jrd::thread_db*, Jrd::jrd_rel*, const Jrd::MetaName&)
{
    return -1;
}

/* Jrd::UserId::findGrantedRoles – populate granted roles for a user.
 * Declared in jrd/scl.h as a private method of class UserId:
 *   void findGrantedRoles(thread_db* tdbb) const;
 * We include scl.h to get the class definition so the mangled name
 * matches.  No-op when metadata tables are unavailable. */
#include "jrd/scl.h"

namespace Jrd {
    void UserId::findGrantedRoles(thread_db*) const
    {
    }
}

/* -----------------------------------------------------------------------
 * Stubs for libcds (Concurrent Data Structures) symbols.
 *
 * The full libcds source files (init.cpp, thread_data.cpp, hp.cpp, …)
 * pull in a deep dependency chain (hazard-pointer GC, RCU, …) that is
 * not meaningful in the single-threaded WASM environment.  We define
 * only the symbols that the Firebird engine references at link time.
 *
 * The headers below mirror the conditional includes from libcds/src/init.cpp.
 * ----------------------------------------------------------------------- */
#include <cds/threading/details/_common.h>
#if CDS_COMPILER == CDS_COMPILER_GCC || CDS_COMPILER == CDS_COMPILER_CLANG || CDS_COMPILER == CDS_COMPILER_INTEL
#   include <cds/threading/details/gcc_manager.h>
#endif
#include <cds/threading/details/pthread_manager.h>
#ifdef CDS_CXX11_THREAD_LOCAL_SUPPORT
#   include <cds/threading/details/cxx11_manager.h>
#endif
#include <cds/algo/backoff_strategy.h>

namespace cds {

    /* Static pthread TLS key used by the pthread threading manager. */
    pthread_key_t threading::pthread::Manager::Holder::m_key;

    /* GCC/Clang __thread thread-local storage variables. */
#if CDS_COMPILER == CDS_COMPILER_GCC || CDS_COMPILER == CDS_COMPILER_CLANG
    __thread threading::gcc_internal::ThreadDataPlaceholder CDS_DATA_ALIGNMENT(8) threading::gcc_internal::s_threadData;
    __thread threading::ThreadData * threading::gcc_internal::s_pThreadData = nullptr;
#endif

    /* C++11 thread_local storage variables. */
#ifdef CDS_CXX11_THREAD_LOCAL_SUPPORT
    thread_local threading::cxx11_internal::ThreadDataPlaceholder CDS_DATA_ALIGNMENT(8) threading::cxx11_internal::s_threadData;
    thread_local threading::ThreadData * threading::cxx11_internal::s_pThreadData = nullptr;
#endif

    namespace threading {
        /* Static data members of ThreadData */
        CDS_EXPORT_API atomics::atomic<size_t> ThreadData::s_nLastUsedProcNo(0);
        CDS_EXPORT_API size_t ThreadData::s_nProcCount = 1;

        /* Thread lifecycle – simplified for single-threaded WASM.
         * The real init() attaches to HP/DHP GC and RCU, which we skip. */
        CDS_EXPORT_API void ThreadData::init()
        {
            ++m_nAttachCount;
        }

        CDS_EXPORT_API bool ThreadData::fini()
        {
            if (--m_nAttachCount == 0)
                return true;
            return false;
        }
    } // namespace threading

    namespace details {
        static atomics::atomic<size_t> s_nInitCallCount(0);

        bool CDS_EXPORT_API init_first_call()
        {
            return s_nInitCallCount.fetch_add(1, atomics::memory_order_relaxed) == 0;
        }

        bool CDS_EXPORT_API fini_last_call()
        {
            if (s_nInitCallCount.fetch_sub(1, atomics::memory_order_relaxed) == 1) {
                atomics::atomic_thread_fence(atomics::memory_order_release);
                return true;
            }
            return false;
        }
    } // namespace details

    namespace backoff {
        /*static*/ size_t exponential_runtime_traits::lower_bound = 16;
        /*static*/ size_t exponential_runtime_traits::upper_bound = 16 * 1024;
        /*static*/ unsigned delay_runtime_traits::timeout = 5;
    } // namespace backoff

} // namespace cds
