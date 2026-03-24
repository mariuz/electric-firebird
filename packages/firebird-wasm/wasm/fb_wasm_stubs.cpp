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
