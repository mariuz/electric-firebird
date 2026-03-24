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
 * We include the Firebird proto headers (met_proto.h, metd_proto.h) plus
 * the necessary supporting headers to guarantee that the C++ name-
 * mangling matches what callers expect.
 * ----------------------------------------------------------------------- */

/* Supporting headers for types used *by value* in function signatures. */
#include "jrd/MetaName.h"                  /* Jrd::MetaName (used by value) */
#include "jrd/QualifiedName.h"             /* Jrd::QualifiedName (used by value) */
#include "common/classes/Nullable.h"       /* Nullable<bool> (used by value) */
#include "common/classes/NestConst.h"      /* NestConst<T> (used by value) */
#include "common/classes/GenericMap.h"     /* GenericMap (for MetaNamePairMap) */
#include "common/classes/fb_pair.h"       /* MetaNamePair */

/* Forward declarations – only pointers/references are used, so full
   definitions are not required. */
struct dsc;
class MemoryPool;

namespace Jrd {
    class thread_db;
    class jrd_tra;
    class jrd_rel;
    class GeneratorItem;
    class ExceptionItem;
    class DmlNode;
    class CompilerScratch;
    class Format;
    class jrd_fld;
    class jrd_prc;
    class Shadow;
    class BlobFilter;
    class Routine;
    class DeferredWork;
    class Statement;
    class Request;
    class Database;
    class TrigVector;
    class dsql_intlsym;
    class dsql_udf;
    class dsql_prc;
    class dsql_rel;
    class TypeClause;
    class DsqlCompilerScratch;
    class DsqlRequest;
    class FieldNode;
    struct bid;
    struct index_desc;
    struct FieldInfo;

    /* From metd_proto.h */
    typedef Firebird::GenericMap<MetaNamePair> MetaNamePairMap;

    /* From met_proto.h */
    enum IndexStatus
    {
        MET_object_active,
        MET_object_deferred_active,
        MET_object_inactive,
        MET_object_unknown
    };

    /* From dsql/sym.h – used by MET_dsql_cache_use/release. */
    enum sym_type {
        SYM_relation = 1,
        SYM_udf,
        SYM_procedure,
        SYM_intlsym_charset,
        SYM_intlsym_collation,
        SYM_eof
    };
}

/* SubtypeInfo – replicated from met_proto.h (the original uses
   Firebird::UCharBuffer which needs array.h). */
struct SubtypeInfo
{
    SubtypeInfo() : attributes(0), ignoreAttributes(true) {}
    Jrd::MetaName charsetName;
    Jrd::MetaName collationName;
    Jrd::MetaName baseCollationName;
    USHORT attributes;
    bool ignoreAttributes;
    /* Simplified: callers only need the struct to exist; the specificAttributes
       member is never populated by stub code.  Use the same concrete type
       (HalfStaticArray) as the original to keep ABI-compatible. */
    Firebird::HalfStaticArray<UCHAR, 32> specificAttributes;
};

/* -----------------------------------------------------------------------
 * met.epp stubs  (MET_* functions from jrd/met_proto.h)
 *
 * In the WASM embedded build, system tables are not available, so all
 * metadata-lookup functions return "not found" or no-op equivalents.
 * ----------------------------------------------------------------------- */

void MET_activate_shadow(Jrd::thread_db*) {}

ULONG MET_align(const dsc*, ULONG value) { return value; }

Jrd::DeferredWork* MET_change_fields(Jrd::thread_db*, Jrd::jrd_tra*, const dsc*)
{ return nullptr; }

Jrd::Format* MET_current(Jrd::thread_db*, Jrd::jrd_rel*)
{ return nullptr; }

void MET_delete_dependencies(Jrd::thread_db*, const Jrd::MetaName&, int, Jrd::jrd_tra*) {}

void MET_delete_shadow(Jrd::thread_db*, USHORT) {}

bool MET_dsql_cache_use(Jrd::thread_db*, Jrd::sym_type, const Jrd::MetaName&, const Jrd::MetaName&)
{ return false; }

void MET_dsql_cache_release(Jrd::thread_db*, Jrd::sym_type, const Jrd::MetaName&, const Jrd::MetaName&) {}

void MET_error(const TEXT*, ...) {}

Jrd::Format* MET_format(Jrd::thread_db*, Jrd::jrd_rel*, USHORT)
{ return nullptr; }

bool MET_get_char_coll_subtype(Jrd::thread_db*, USHORT*, const UCHAR*, USHORT)
{ return false; }

bool MET_get_char_coll_subtype_info(Jrd::thread_db*, USHORT, SubtypeInfo*)
{ return false; }

Jrd::DmlNode* MET_get_dependencies(Jrd::thread_db*, Jrd::jrd_rel*, const UCHAR*, const ULONG,
    Jrd::CompilerScratch*, Jrd::bid*, Jrd::Statement**, Jrd::CompilerScratch**,
    const Jrd::MetaName&, int, USHORT, Jrd::jrd_tra*, const Jrd::MetaName&)
{ return nullptr; }

Jrd::jrd_fld* MET_get_field(const Jrd::jrd_rel*, USHORT)
{ return nullptr; }

ULONG MET_get_rel_flags_from_TYPE(USHORT) { return 0; }

bool MET_get_repl_state(Jrd::thread_db*, const Jrd::MetaName&)
{ return false; }

void MET_get_shadow_files(Jrd::thread_db*, bool) {}
void MET_load_db_triggers(Jrd::thread_db*, int) {}
void MET_load_ddl_triggers(Jrd::thread_db*) {}

bool MET_load_exception(Jrd::thread_db*, Jrd::ExceptionItem&)
{ return false; }

void MET_load_trigger(Jrd::thread_db*, Jrd::jrd_rel*, const Jrd::MetaName&, Jrd::TrigVector**) {}
void MET_lookup_index_for_cnstrt(Jrd::thread_db*, Jrd::MetaName&, const Jrd::MetaName&) {}
void MET_lookup_cnstrt_for_index(Jrd::thread_db*, Jrd::MetaName&, const Jrd::MetaName&) {}
void MET_lookup_cnstrt_for_trigger(Jrd::thread_db*, Jrd::MetaName&, Jrd::MetaName&, const Jrd::MetaName&) {}
void MET_lookup_exception(Jrd::thread_db*, SLONG, Jrd::MetaName&, Firebird::string*) {}

int MET_lookup_field(Jrd::thread_db*, Jrd::jrd_rel*, const Jrd::MetaName&)
{ return -1; }

Jrd::BlobFilter* MET_lookup_filter(Jrd::thread_db*, SSHORT, SSHORT)
{ return nullptr; }

bool MET_load_generator(Jrd::thread_db*, Jrd::GeneratorItem&, bool*, SLONG*)
{ return false; }

SLONG MET_lookup_generator(Jrd::thread_db*, const Jrd::MetaName&, bool*, SLONG*)
{ return 0; }

bool MET_lookup_generator_id(Jrd::thread_db*, SLONG, Jrd::MetaName&, bool*)
{ return false; }

void MET_update_generator_increment(Jrd::thread_db*, SLONG, SLONG) {}
void MET_lookup_index(Jrd::thread_db*, Jrd::MetaName&, const Jrd::MetaName&, USHORT) {}
void MET_lookup_index_condition(Jrd::thread_db*, Jrd::jrd_rel*, Jrd::index_desc*) {}
void MET_lookup_index_expression(Jrd::thread_db*, Jrd::jrd_rel*, Jrd::index_desc*) {}

bool MET_lookup_index_expr_cond_blr(Jrd::thread_db*, const Jrd::MetaName&, Jrd::bid&, Jrd::bid&)
{ return false; }

SLONG MET_lookup_index_name(Jrd::thread_db*, const Jrd::MetaName&, SLONG*, Jrd::IndexStatus*)
{ return 0; }

bool MET_lookup_partner(Jrd::thread_db*, Jrd::jrd_rel*, struct Jrd::index_desc*, const TEXT*)
{ return false; }

Jrd::jrd_prc* MET_lookup_procedure(Jrd::thread_db*, const Jrd::QualifiedName&, bool)
{ return nullptr; }

Jrd::jrd_prc* MET_lookup_procedure_id(Jrd::thread_db*, USHORT, bool, bool, USHORT)
{ return nullptr; }

Jrd::jrd_rel* MET_lookup_relation(Jrd::thread_db*, const Jrd::MetaName&)
{ return nullptr; }

Jrd::jrd_rel* MET_lookup_relation_id(Jrd::thread_db*, SLONG, bool)
{ return nullptr; }

Jrd::DmlNode* MET_parse_blob(Jrd::thread_db*, Jrd::jrd_rel*, Jrd::bid*, Jrd::CompilerScratch**,
    Jrd::Statement**, bool, bool)
{ return nullptr; }

void MET_parse_sys_trigger(Jrd::thread_db*, Jrd::jrd_rel*) {}
void MET_post_existence(Jrd::thread_db*, Jrd::jrd_rel*) {}
void MET_prepare(Jrd::thread_db*, Jrd::jrd_tra*, USHORT, const UCHAR*) {}

Jrd::jrd_prc* MET_procedure(Jrd::thread_db*, USHORT, bool, USHORT)
{ return nullptr; }

Jrd::jrd_rel* MET_relation(Jrd::thread_db*, USHORT)
{ return nullptr; }

void MET_release_existence(Jrd::thread_db*, Jrd::jrd_rel*) {}
void MET_release_trigger(Jrd::thread_db*, Jrd::TrigVector**, const Jrd::MetaName&) {}
void MET_release_triggers(Jrd::thread_db*, Jrd::TrigVector**, bool) {}

#ifdef DEV_BUILD
void MET_verify_cache(Jrd::thread_db*) {}
#endif

void MET_clear_cache(Jrd::thread_db*) {}

bool MET_routine_in_use(Jrd::thread_db*, Jrd::Routine*)
{ return false; }

void MET_revoke(Jrd::thread_db*, Jrd::jrd_tra*, const Jrd::MetaName&,
    const Jrd::MetaName&, const Firebird::string&) {}

void MET_scan_partners(Jrd::thread_db*, Jrd::jrd_rel*) {}
void MET_scan_relation(Jrd::thread_db*, Jrd::jrd_rel*) {}
void MET_trigger_msg(Jrd::thread_db*, Firebird::string&, const Jrd::MetaName&, USHORT) {}
void MET_update_shadow(Jrd::thread_db*, Jrd::Shadow*, USHORT) {}
void MET_update_transaction(Jrd::thread_db*, Jrd::jrd_tra*, const bool) {}
void MET_get_domain(Jrd::thread_db*, MemoryPool&, const Jrd::MetaName&, dsc*, Jrd::FieldInfo*) {}

Jrd::MetaName MET_get_relation_field(Jrd::thread_db*, MemoryPool&,
    const Jrd::MetaName&, const Jrd::MetaName&, dsc*, Jrd::FieldInfo*)
{ return Jrd::MetaName(); }

void MET_update_partners(Jrd::thread_db*) {}
int MET_get_linger(Jrd::thread_db*) { return 0; }

Nullable<bool> MET_get_ss_definer(Jrd::thread_db*)
{ return Nullable<bool>(); }

/* MET_store_dependencies uses CompilerScratch::Dependency, a nested type
   from jrd/exe.h.  exe.h brings in the entire JRD header chain.  We
   include it only for this single stub. */
#include "jrd/exe.h"

void MET_store_dependencies(Jrd::thread_db*, Firebird::Array<Jrd::CompilerScratch::Dependency>&,
    const Jrd::jrd_rel*, const Jrd::MetaName&, int, Jrd::jrd_tra*) {}

/* -----------------------------------------------------------------------
 * metd.epp stubs  (METD_* functions from dsql/metd_proto.h)
 *
 * Same rationale as MET_* above – system tables are unavailable.
 * ----------------------------------------------------------------------- */

void METD_drop_charset(Jrd::jrd_tra*, const Jrd::MetaName&) {}
void METD_drop_collation(Jrd::jrd_tra*, const Jrd::MetaName&) {}
void METD_drop_function(Jrd::jrd_tra*, const Jrd::QualifiedName&) {}
void METD_drop_procedure(Jrd::jrd_tra*, const Jrd::QualifiedName&) {}
void METD_drop_relation(Jrd::jrd_tra*, const Jrd::MetaName&) {}

Jrd::dsql_intlsym* METD_get_charset(Jrd::jrd_tra*, USHORT, const char*)
{ return nullptr; }

USHORT METD_get_charset_bpc(Jrd::jrd_tra*, SSHORT)
{ return 1; }

Jrd::MetaName METD_get_charset_name(Jrd::jrd_tra*, SSHORT)
{ return Jrd::MetaName(); }

Jrd::dsql_intlsym* METD_get_collation(Jrd::jrd_tra*, const Jrd::MetaName&, USHORT)
{ return nullptr; }

Jrd::MetaName METD_get_default_charset(Jrd::jrd_tra*)
{ return Jrd::MetaName(); }

bool METD_get_domain(Jrd::jrd_tra*, Jrd::TypeClause*, const Jrd::MetaName&)
{ return false; }

Jrd::dsql_udf* METD_get_function(Jrd::jrd_tra*, Jrd::DsqlCompilerScratch*, const Jrd::QualifiedName&)
{ return nullptr; }

void METD_get_primary_key(Jrd::jrd_tra*, const Jrd::MetaName&,
    Firebird::Array<NestConst<Jrd::FieldNode> >&) {}

Jrd::dsql_prc* METD_get_procedure(Jrd::jrd_tra*, Jrd::DsqlCompilerScratch*, const Jrd::QualifiedName&)
{ return nullptr; }

Jrd::dsql_rel* METD_get_relation(Jrd::jrd_tra*, Jrd::DsqlCompilerScratch*, const Jrd::MetaName&)
{ return nullptr; }

bool METD_get_type(Jrd::jrd_tra*, const Jrd::MetaName&, const char*, SSHORT*)
{ return false; }

Jrd::dsql_rel* METD_get_view_base(Jrd::jrd_tra*, Jrd::DsqlCompilerScratch*, const char*,
    Jrd::MetaNamePairMap&)
{ return nullptr; }

bool METD_get_view_relation(Jrd::jrd_tra*, Jrd::DsqlCompilerScratch*, const Jrd::MetaName&,
    const Jrd::MetaName&, Jrd::dsql_rel*&, Jrd::dsql_prc*&)
{ return false; }

/* -----------------------------------------------------------------------
 * scl.epp stub (Jrd::UserId::findGrantedRoles)
 *
 * Defined in scl.epp (which needs gpre).  scl.h is already pulled in by
 * exe.h above, so we only need the method definition.
 * ----------------------------------------------------------------------- */
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
