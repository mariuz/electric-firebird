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

}

/* From dsql/sym.h – used by MET_dsql_cache_use/release. */
#include "dsql/sym.h"

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
 * scl.epp stubs  (SCL_* functions from jrd/scl_proto.h)
 *
 * Security class functions check access privileges.  In the WASM
 * embedded build no security enforcement is needed, so all checks
 * are no-ops and lookups return "not found".
 *
 * scl.h is already available via exe.h included above.
 * Signatures match Firebird v5.0.3 scl_proto.h.
 * ----------------------------------------------------------------------- */

#include "jrd/obj.h"      /* ObjectType (SSHORT) */

void SCL_check_access(Jrd::thread_db*, const Jrd::SecurityClass*,
    SLONG, const Jrd::MetaName&,
    Jrd::SecurityClass::flags_t, ObjectType, bool, const Jrd::MetaName&,
    const Jrd::MetaName&) {}

void SCL_check_create_access(Jrd::thread_db*, ObjectType) {}
void SCL_check_charset(Jrd::thread_db*, const Jrd::MetaName&, Jrd::SecurityClass::flags_t) {}
void SCL_check_collation(Jrd::thread_db*, const Jrd::MetaName&, Jrd::SecurityClass::flags_t) {}
void SCL_check_database(Jrd::thread_db*, Jrd::SecurityClass::flags_t) {}
void SCL_check_domain(Jrd::thread_db*, const Jrd::MetaName&, Jrd::SecurityClass::flags_t) {}

bool SCL_check_exception(Jrd::thread_db*, const Jrd::MetaName&, Jrd::SecurityClass::flags_t)
{ return true; }

bool SCL_check_generator(Jrd::thread_db*, const Jrd::MetaName&, Jrd::SecurityClass::flags_t)
{ return true; }

void SCL_check_index(Jrd::thread_db*, const Jrd::MetaName&, UCHAR, Jrd::SecurityClass::flags_t) {}

bool SCL_check_package(Jrd::thread_db*, const dsc*, Jrd::SecurityClass::flags_t)
{ return true; }

bool SCL_check_procedure(Jrd::thread_db*, const dsc*, Jrd::SecurityClass::flags_t)
{ return true; }

bool SCL_check_function(Jrd::thread_db*, const dsc*, Jrd::SecurityClass::flags_t)
{ return true; }

void SCL_check_filter(Jrd::thread_db*, const Jrd::MetaName&, Jrd::SecurityClass::flags_t) {}

void SCL_check_relation(Jrd::thread_db*, const dsc*, Jrd::SecurityClass::flags_t, bool) {}

bool SCL_check_view(Jrd::thread_db*, const dsc*, Jrd::SecurityClass::flags_t)
{ return true; }

void SCL_check_role(Jrd::thread_db*, const Jrd::MetaName&, Jrd::SecurityClass::flags_t) {}

Jrd::SecurityClass* SCL_get_class(Jrd::thread_db*, const TEXT*)
{ return nullptr; }

Jrd::SecurityClass::flags_t SCL_get_mask(Jrd::thread_db*, const TEXT*, const TEXT*)
{ return 0; }

void SCL_clear_classes(Jrd::thread_db*, const TEXT*) {}
void SCL_release_all(Jrd::SecurityClassList*&) {}

bool SCL_role_granted(Jrd::thread_db*, const Jrd::UserId&, const TEXT*)
{ return false; }

Jrd::SecurityClass::flags_t SCL_get_object_mask(ObjectType)
{ return 0; }

ULONG SCL_get_number(const UCHAR*)
{ return 0; }

USHORT SCL_convert_privilege(Jrd::thread_db*, Jrd::jrd_tra*, const Firebird::string&)
{ return 0; }

namespace Jrd {
typedef Firebird::Array<UCHAR> Acl;
}

bool SCL_move_priv(Jrd::SecurityClass::flags_t, Jrd::Acl&)
{ return false; }

/* -----------------------------------------------------------------------
 * ini.epp stubs  (INI_* functions from jrd/ini_proto.h)
 *
 * Initialization functions that set up system tables and relations.
 * In WASM, no system tables are created from scratch.
 * Signatures match Firebird v5.0.3 ini_proto.h.
 * ----------------------------------------------------------------------- */

namespace Jrd {
    class dsql_dbb;
}

void INI_format(Jrd::thread_db*, const Firebird::string&) {}

USHORT INI_get_trig_flags(const Jrd::MetaName&)
{ return 0; }

void INI_init(Jrd::thread_db*) {}
void INI_init_dsql(Jrd::thread_db*, Jrd::dsql_dbb*) {}

Firebird::string INI_owner_privileges()
{ return Firebird::string(); }

void INI_upgrade(Jrd::thread_db*) {}

/* -----------------------------------------------------------------------
 * grant.epp stub  (GRANT_privileges from jrd/grant_proto.h)
 *
 * Privilege granting operates on system tables.  No-op for WASM.
 * Signature matches Firebird v5.0.3 grant_proto.h.
 * ----------------------------------------------------------------------- */

void GRANT_privileges(Jrd::thread_db*, const Firebird::string&, ObjectType, Jrd::jrd_tra*) {}

/* -----------------------------------------------------------------------
 * dfw.epp stubs  (DFW_* functions from jrd/dfw_proto.h)
 *
 * Deferred Work Framework – operations queued during DDL that execute
 * at transaction commit.  In WASM, DDL is not supported so these are
 * all no-ops.
 *
 * Signatures match Firebird v5.0.3 dfw_proto.h.
 * ----------------------------------------------------------------------- */

namespace Jrd {
    /* Full dfw_t definition from jrd/tra.h (v5.0.3).
       ISO C++ forbids forward references to unscoped enums, and tra.h is not
       included here.  We replicate the definition so that DFW_post_work and
       friends can accept the enum by value. */
    enum dfw_t {
        dfw_null,
        dfw_create_relation,
        dfw_delete_relation,
        dfw_update_format,
        dfw_create_index,
        dfw_delete_index,
        dfw_compute_security,
        dfw_add_file,
        dfw_add_shadow,
        dfw_delete_shadow,
        dfw_delete_shadow_nodelete,
        dfw_modify_file,
        dfw_erase_file,
        dfw_create_field,
        dfw_delete_field,
        dfw_modify_field,
        dfw_delete_global,
        dfw_delete_rfr,
        dfw_post_event,
        dfw_create_trigger,
        dfw_delete_trigger,
        dfw_modify_trigger,
        dfw_grant,
        dfw_revoke,
        dfw_scan_relation,
        dfw_create_expression_index,
        dfw_create_procedure,
        dfw_modify_procedure,
        dfw_delete_procedure,
        dfw_delete_prm,
        dfw_create_collation,
        dfw_delete_collation,
        dfw_delete_exception,
        dfw_delete_generator,
        dfw_create_function,
        dfw_modify_function,
        dfw_delete_function,
        dfw_add_difference,
        dfw_delete_difference,
        dfw_begin_backup,
        dfw_end_backup,
        dfw_user_management,
        dfw_modify_package_header,
        dfw_drop_package_header,
        dfw_drop_package_body,
        dfw_check_not_null,
        dfw_store_view_context_type,
        dfw_set_generator,
        dfw_change_repl_state,
        /* deferred works argument types */
        dfw_arg_index_name,
        dfw_arg_partner_rel_id,
        dfw_arg_proc_name,
        dfw_arg_force_computed,
        dfw_arg_check_blr,
        dfw_arg_rel_name,
        dfw_arg_trg_type,
        dfw_arg_new_name,
        dfw_arg_field_not_null,
        dfw_db_crypt,
        dfw_set_linger,
        dfw_clear_cache
    };
}

USHORT DFW_assign_index_type(Jrd::thread_db*, const Jrd::MetaName&, SSHORT, SSHORT)
{ return 0; }

void DFW_delete_deferred(Jrd::jrd_tra*, SINT64) {}

Firebird::SortedArray<int>& DFW_get_ids(Jrd::DeferredWork* work)
{
    /* This stub should never be called in practice.  We return a
       reference to a static empty array to satisfy the linker. */
    static Firebird::SortedArray<int> dummy;
    return dummy;
}

void DFW_merge_work(Jrd::jrd_tra*, SINT64, SINT64) {}
void DFW_perform_work(Jrd::thread_db*, Jrd::jrd_tra*) {}
void DFW_perform_post_commit_work(Jrd::jrd_tra*) {}

Jrd::DeferredWork* DFW_post_work(Jrd::jrd_tra*, Jrd::dfw_t, const dsc*, USHORT,
    const Jrd::MetaName&)
{ return nullptr; }

Jrd::DeferredWork* DFW_post_work(Jrd::jrd_tra*, Jrd::dfw_t, const Firebird::string&,
    USHORT, const Jrd::MetaName&)
{ return nullptr; }

Jrd::DeferredWork* DFW_post_work_arg(Jrd::jrd_tra*, Jrd::DeferredWork*, const dsc*, USHORT)
{ return nullptr; }

Jrd::DeferredWork* DFW_post_work_arg(Jrd::jrd_tra*, Jrd::DeferredWork*, const dsc*, USHORT,
    Jrd::dfw_t)
{ return nullptr; }

void DFW_update_index(const TEXT*, USHORT, const Firebird::HalfStaticArray<float, 4>&,
    Jrd::jrd_tra*) {}

void DFW_reset_icu(Jrd::thread_db*) {}

/* -----------------------------------------------------------------------
 * dpm.epp stubs  (DPM_* functions from jrd/dpm_proto.h)
 *
 * Data Page Manager – low-level page and record operations.  These
 * are called from many places in the engine for record fetch, store,
 * delete, and sequence generation (DPM_gen_id).
 *
 * In the WASM embedded build without a real ODS (On-Disk Structure),
 * all operations are no-ops or return safe defaults.
 *
 * Signatures match Firebird v5.0.3 dpm_proto.h.
 * ----------------------------------------------------------------------- */

#include "jrd/RecordNumber.h"  /* RecordNumber (used by value in DPM_store_blob) */

/* Forward declarations for types used in DPM function signatures.
   PageNumber and PageStack are available via exe.h → Relation.h → pag.h. */
namespace Ods {
    struct pag;
    struct data_page;
}

namespace Jrd {
    class blb;
    struct record_param;
    class Record;
    struct win;

    enum RecordStorageType
    {
        DPM_primary = 1,
        DPM_secondary,
        DPM_other
    };

    enum FindNextRecordScope
    {
        DPM_next_all,
        DPM_next_data_page,
        DPM_next_pointer_page
    };

    class RelationPages;
}

Ods::pag* DPM_allocate(Jrd::thread_db*, Jrd::win*)
{ return nullptr; }

void DPM_backout(Jrd::thread_db*, Jrd::record_param*) {}
void DPM_backout_mark(Jrd::thread_db*, Jrd::record_param*, const Jrd::jrd_tra*) {}

double DPM_cardinality(Jrd::thread_db*, Jrd::jrd_rel*, const Jrd::Format*)
{ return 0.0; }

bool DPM_chain(Jrd::thread_db*, Jrd::record_param*, Jrd::record_param*)
{ return false; }

void DPM_create_relation(Jrd::thread_db*, Jrd::jrd_rel*) {}

ULONG DPM_data_pages(Jrd::thread_db*, Jrd::jrd_rel*)
{ return 0; }

void DPM_delete(Jrd::thread_db*, Jrd::record_param*, ULONG) {}
void DPM_delete_relation(Jrd::thread_db*, Jrd::jrd_rel*) {}

bool DPM_fetch(Jrd::thread_db*, Jrd::record_param*, USHORT)
{ return false; }

bool DPM_fetch_back(Jrd::thread_db*, Jrd::record_param*, USHORT, SSHORT)
{ return false; }

void DPM_fetch_fragment(Jrd::thread_db*, Jrd::record_param*, USHORT) {}

SINT64 DPM_gen_id(Jrd::thread_db*, SLONG, bool, SINT64 val)
{
    /* In the real engine this reads/writes the generator page.
       For WASM we maintain a simple in-memory counter per generator ID.
       The 'val' parameter is the increment; when non-zero we advance
       by that amount and return the new value.  When zero we just return
       the current value.  This is thread-safe enough for single-threaded
       WASM and provides unique ascending values within a session. */
    static SINT64 counter = 0;
    if (val != 0)
        counter += val;
    return counter;
}

bool DPM_get(Jrd::thread_db*, Jrd::record_param*, SSHORT)
{ return false; }

ULONG DPM_get_blob(Jrd::thread_db*, Jrd::blb*, RecordNumber, bool, ULONG)
{ return 0; }

bool DPM_next(Jrd::thread_db*, Jrd::record_param*, USHORT, Jrd::FindNextRecordScope)
{ return false; }

void DPM_pages(Jrd::thread_db*, SSHORT, int, ULONG, ULONG) {}

ULONG DPM_pointer_pages(Jrd::thread_db*, Jrd::jrd_rel*)
{ return 0; }

void DPM_scan_pages(Jrd::thread_db*) {}

void DPM_store(Jrd::thread_db*, Jrd::record_param*, Jrd::PageStack&,
    const Jrd::RecordStorageType) {}

RecordNumber DPM_store_blob(Jrd::thread_db*, Jrd::blb*, Jrd::Record*)
{ return RecordNumber(); }

void DPM_rewrite_header(Jrd::thread_db*, Jrd::record_param*) {}
void DPM_update(Jrd::thread_db*, Jrd::record_param*, Jrd::PageStack*,
    const Jrd::jrd_tra*) {}

void DPM_create_relation_pages(Jrd::thread_db*, Jrd::jrd_rel*, Jrd::RelationPages*) {}
void DPM_delete_relation_pages(Jrd::thread_db*, Jrd::jrd_rel*, Jrd::RelationPages*) {}

/* -----------------------------------------------------------------------
 * fun.epp stubs  (FUN_evaluate and IbUtil from jrd/fun_proto.h)
 *
 * User-defined function support.  In WASM, external UDFs are not
 * available.
 *
 * fun_proto.h includes Nodes.h which has heavy deps, so we replicate
 * only the IbUtil class declaration and provide method definitions.
 * ----------------------------------------------------------------------- */

namespace Jrd {
    class Function;
    class impure_value;
}

void FUN_evaluate(Jrd::thread_db*, const Jrd::Function*, const Jrd::NestValueArray&,
    Jrd::impure_value*, Firebird::Array<UCHAR>&) {}

/* IbUtil class – replicated from fun_proto.h to avoid pulling in Nodes.h.
   Only the static method definitions are needed by the linker. */
class IbUtil
{
public:
    static void initialize();
    static void* alloc(long size);
    static bool free(void* ptr);
};

void IbUtil::initialize() {}

void* IbUtil::alloc(long size)
{ return malloc(size > 0 ? (size_t)size : 1); }

bool IbUtil::free(void* ptr)
{ ::free(ptr); return true; }

/* -----------------------------------------------------------------------
 * dyn_util.epp stubs  (DYN_UTIL_* functions from jrd/dyn_ut_proto.h)
 *
 * Dynamic utility functions for DDL operations (generating names,
 * checking uniqueness, etc.).  In WASM, DDL is not supported.
 *
 * Signatures match Firebird v5.0.3 dyn_ut_proto.h.
 * ----------------------------------------------------------------------- */

void DYN_UTIL_store_check_constraints(Jrd::thread_db*, Jrd::jrd_tra*,
    const Jrd::MetaName&, const Jrd::MetaName&) {}

bool DYN_UTIL_find_field_source(Jrd::thread_db*, Jrd::jrd_tra*,
    const Jrd::MetaName&, USHORT, const TEXT*, TEXT*)
{ return false; }

void DYN_UTIL_generate_generator_name(Jrd::thread_db*, Jrd::MetaName&) {}
void DYN_UTIL_generate_trigger_name(Jrd::thread_db*, Jrd::jrd_tra*, Jrd::MetaName&) {}
void DYN_UTIL_generate_index_name(Jrd::thread_db*, Jrd::jrd_tra*, Jrd::MetaName&, UCHAR) {}
void DYN_UTIL_generate_field_position(Jrd::thread_db*, const Jrd::MetaName&, SLONG*) {}

void DYN_UTIL_generate_field_name(Jrd::thread_db*, TEXT*) {}

void DYN_UTIL_generate_field_name(Jrd::thread_db*, Jrd::MetaName&) {}

void DYN_UTIL_generate_constraint_name(Jrd::thread_db*, Jrd::MetaName&) {}

void DYN_UTIL_check_unique_name(Jrd::thread_db*, Jrd::jrd_tra*,
    const Jrd::MetaName&, int) {}

SINT64 DYN_UTIL_gen_unique_id(Jrd::thread_db*, SSHORT, const char*)
{ return 0; }

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

        /* Called from cds::Initialize() (inline in cds/init.h) to record
           whether HP statistics collection was compiled in.  No-op in WASM. */
        void CDS_EXPORT_API check_hpstat_enabled(bool /*enabled*/) {}

    } // namespace details

    namespace backoff {
        /*static*/ size_t exponential_runtime_traits::lower_bound = 16;
        /*static*/ size_t exponential_runtime_traits::upper_bound = 16 * 1024;
        /*static*/ unsigned delay_runtime_traits::timeout = 5;
    } // namespace backoff

} // namespace cds

/* -----------------------------------------------------------------------
 * yvalve/gds.cpp stubs  (gds__sqlcode, fb_sqlstate, fb_print_blr)
 *
 * StmtNodes.cpp references gds__sqlcode and fb_sqlstate to translate
 * internal error codes to SQL-standard codes.  dsql.cpp references
 * fb_print_blr for debug pretty-printing of BLR buffers.
 * All are no-ops / safe defaults in the WASM embedded build.
 *
 * Signatures match Firebird v5.0.3 src/yvalve/gds.cpp.
 * ----------------------------------------------------------------------- */

extern "C"
SLONG API_ROUTINE gds__sqlcode(const ISC_STATUS* status_vector)
{
    if (!status_vector)
        return -999;  /* GENERIC_SQLCODE: no SQL code known */
    /* Scan for isc_arg_gds / isc_arg_sql_int in the status vector and
       return the SQL code stored there.  For the WASM stub we just
       return a generic "unknown" code; SQL-code mapping requires the
       full Firebird error-message tables which are absent in the
       embedded WASM build. */
    return -999;  /* GENERIC_SQLCODE */
}

extern "C"
void API_ROUTINE fb_sqlstate(char* sqlstate, const ISC_STATUS* /*status_vector*/)
{
    /* FB_SQLSTATE_SIZE = 6 (5 chars + NUL terminator) */
    if (sqlstate)
        /* HY000 = general error – the correct default when no mapping is
           available (mirrors the yvalve/gds.cpp fallback string). */
        strncpy(sqlstate, "HY000", 6);
}

extern "C"
int API_ROUTINE fb_print_blr(const UCHAR* /*blr*/, ULONG /*blr_length*/,
    FPTR_PRINT_CALLBACK /*routine*/, void* /*user_arg*/, SSHORT /*language*/)
{
    /* BLR pretty-printer not supported in WASM embedded build. */
    return -1; /* FB_FAILURE */
}

/* -----------------------------------------------------------------------
 * scl.epp stub  (UserId::setRoleTrusted)
 *
 * setRoleTrusted() promotes the current SQL role to the "trusted role"
 * slot so it survives role-switching.  In WASM there is no real security
 * enforcement, so a no-op is safe.
 * ----------------------------------------------------------------------- */

void Jrd::UserId::setRoleTrusted() {}

/* -----------------------------------------------------------------------
 * Function.epp stubs  (Jrd::Function virtual methods + static lookup)
 *
 * Function.epp (jrd/Function.epp) is an embedded-preprocessor source
 * file that requires gpre to generate a .cpp.  It is NOT compiled in
 * the WASM build.  Defining the non-inline virtual methods here causes
 * the compiler to emit the vtable for Jrd::Function in this translation
 * unit, satisfying the linker.
 *
 * Signatures match Firebird v5.0.3 jrd/Function.h.
 * ----------------------------------------------------------------------- */

#include "jrd/Function.h"

namespace Jrd {

/* Static lookup – returns nullptr (no metadata scanning in WASM). */
Function* Function::lookup(thread_db* /*tdbb*/, const QualifiedName& /*name*/,
    bool /*noscan*/)
{ return nullptr; }

/* Virtual methods – no-op / safe-default implementations. */
bool Function::checkCache(thread_db* /*tdbb*/) const { return false; }
void Function::clearCache(thread_db* /*tdbb*/) {}
bool Function::reload(thread_db* /*tdbb*/) { return false; }

/* Second static lookup overload – by numeric ID.  Returns nullptr. */
Function* Function::lookup(thread_db* /*tdbb*/, USHORT /*id*/,
    bool /*return_deleted*/, bool /*noscan*/, USHORT /*flags*/)
{ return nullptr; }

/* Releases existence lock and marks function for reclamation.
   No-op in WASM (no lock manager). */
void Function::releaseLocks(thread_db* /*tdbb*/) {}

} // namespace Jrd

/* -----------------------------------------------------------------------
 * DdlNodes.epp stubs  (all concrete DDL node execute/checkPermission/
 *                       internalPrint + DdlNode helper methods)
 *
 * DdlNodes.epp and PackageNodes.epp are embedded-preprocessor sources
 * that are NOT compiled in the WASM build (they require gpre).  Each
 * concrete DDL node class declares its execute(), checkPermission(), and
 * internalPrint() methods non-inline; these are the "key functions" that
 * drive vtable emission in the Itanium C++ ABI.  Without them, the
 * vtable for every DDL node class is absent from the binary and the
 * linker fails.
 *
 * In WASM, DDL is not supported – all execute() / checkPermission()
 * methods are no-ops.  internalPrint() returns the class name string.
 *
 * Signatures match Firebird v5.0.3 dsql/DdlNodes.h and
 * dsql/PackageNodes.h.
 * ----------------------------------------------------------------------- */

#include "dsql/DdlNodes.h"
#include "dsql/PackageNodes.h"

namespace Jrd {

/* ------- DdlNode base-class helper methods (non-virtual, non-inline) --- */

/* Static overload: fires DDL triggers; no-op in WASM. */
void DdlNode::executeDdlTrigger(thread_db* /*tdbb*/, jrd_tra* /*transaction*/,
    DdlNode::DdlTriggerWhen /*when*/, int /*action*/,
    const MetaName& /*objectName*/, const MetaName& /*oldNewObjectName*/,
    const Firebird::string& /*sqlText*/) {}

/* Protected instance overload (no sqlText parameter). */
void DdlNode::executeDdlTrigger(thread_db* /*tdbb*/,
    DsqlCompilerScratch* /*dsqlScratch*/, jrd_tra* /*transaction*/,
    DdlTriggerWhen /*when*/, int /*action*/,
    const MetaName& /*objectName*/, const MetaName& /*oldNewObjectName*/) {}

/* Helpers used during CREATE/ALTER TABLE, CREATE PROCEDURE, etc. */
void DdlNode::storeGlobalField(thread_db* /*tdbb*/, jrd_tra* /*transaction*/,
    MetaName& /*name*/, const TypeClause* /*field*/,
    const Firebird::string& /*computedSource*/,
    const BlrDebugWriter::BlrData& /*computedValue*/) {}

bool DdlNode::deleteSecurityClass(thread_db* /*tdbb*/, jrd_tra* /*transaction*/,
    const MetaName& /*secClass*/)
{ return false; }

void DdlNode::storePrivileges(thread_db* /*tdbb*/, jrd_tra* /*transaction*/,
    const MetaName& /*name*/, int /*type*/, const char* /*privileges*/) {}

void DdlNode::deletePrivilegesByRelName(thread_db* /*tdbb*/,
    jrd_tra* /*transaction*/, const MetaName& /*name*/, int /*type*/) {}

/* ------- ExecInSecurityDb ------------------------------------------------ */

void ExecInSecurityDb::executeInSecurityDb(jrd_tra* /*tra*/) {}

/* ------- ParameterClause constructor ------------------------------------- */

ParameterClause::ParameterClause(Firebird::MemoryPool& /*pool*/,
    dsql_fld* field, const MetaName& /*aCollate*/,
    ValueSourceClause* aDefaultClause, ValueExprNode* aParameterExpr)
    : type(field),
      defaultClause(aDefaultClause),
      parameterExpr(aParameterExpr)
{}

Firebird::string ParameterClause::internalPrint(NodePrinter& /*printer*/) const
{ return "ParameterClause"; }

/* ------- AlterCharSetNode ------------------------------------------------ */

Firebird::string AlterCharSetNode::internalPrint(NodePrinter& /*p*/) const
{ return "AlterCharSetNode"; }
void AlterCharSetNode::checkPermission(thread_db*, jrd_tra*) {}
void AlterCharSetNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- AlterEDSPoolSetNode --------------------------------------------- */

void AlterEDSPoolSetNode::checkPermission(thread_db*, jrd_tra*) {}
Firebird::string AlterEDSPoolSetNode::internalPrint(NodePrinter& /*p*/) const
{ return "AlterEDSPoolSetNode"; }
void AlterEDSPoolSetNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- AlterEDSPoolClearNode ------------------------------------------- */

void AlterEDSPoolClearNode::checkPermission(thread_db*, jrd_tra*) {}
Firebird::string AlterEDSPoolClearNode::internalPrint(NodePrinter& /*p*/) const
{ return "AlterEDSPoolClearNode"; }
void AlterEDSPoolClearNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CommentOnNode --------------------------------------------------- */

Firebird::string CommentOnNode::internalPrint(NodePrinter& /*p*/) const
{ return "CommentOnNode"; }
void CommentOnNode::checkPermission(thread_db*, jrd_tra*) {}
void CommentOnNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CreateAlterFunctionNode ----------------------------------------- */

Firebird::string CreateAlterFunctionNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateAlterFunctionNode"; }
DdlNode* CreateAlterFunctionNode::dsqlPass(DsqlCompilerScratch* s)
{ return DdlNode::dsqlPass(s); }
void CreateAlterFunctionNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateAlterFunctionNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- AlterExternalFunctionNode --------------------------------------- */

Firebird::string AlterExternalFunctionNode::internalPrint(NodePrinter& /*p*/) const
{ return "AlterExternalFunctionNode"; }
void AlterExternalFunctionNode::checkPermission(thread_db*, jrd_tra*) {}
void AlterExternalFunctionNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropFunctionNode ------------------------------------------------ */

Firebird::string DropFunctionNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropFunctionNode"; }
DdlNode* DropFunctionNode::dsqlPass(DsqlCompilerScratch* s)
{ return DdlNode::dsqlPass(s); }
void DropFunctionNode::checkPermission(thread_db*, jrd_tra*) {}
void DropFunctionNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CreateAlterProcedureNode ---------------------------------------- */

Firebird::string CreateAlterProcedureNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateAlterProcedureNode"; }
DdlNode* CreateAlterProcedureNode::dsqlPass(DsqlCompilerScratch* s)
{ return DdlNode::dsqlPass(s); }
void CreateAlterProcedureNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateAlterProcedureNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropProcedureNode ----------------------------------------------- */

Firebird::string DropProcedureNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropProcedureNode"; }
DdlNode* DropProcedureNode::dsqlPass(DsqlCompilerScratch* s)
{ return DdlNode::dsqlPass(s); }
void DropProcedureNode::checkPermission(thread_db*, jrd_tra*) {}
void DropProcedureNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CreateAlterTriggerNode ------------------------------------------ */

Firebird::string CreateAlterTriggerNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateAlterTriggerNode"; }
DdlNode* CreateAlterTriggerNode::dsqlPass(DsqlCompilerScratch* s)
{ return DdlNode::dsqlPass(s); }
void CreateAlterTriggerNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateAlterTriggerNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropTriggerNode ------------------------------------------------- */

Firebird::string DropTriggerNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropTriggerNode"; }
DdlNode* DropTriggerNode::dsqlPass(DsqlCompilerScratch* s)
{ return DdlNode::dsqlPass(s); }
void DropTriggerNode::checkPermission(thread_db*, jrd_tra*) {}
void DropTriggerNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CreateCollationNode --------------------------------------------- */

Firebird::string CreateCollationNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateCollationNode"; }
DdlNode* CreateCollationNode::dsqlPass(DsqlCompilerScratch* s)
{ return DdlNode::dsqlPass(s); }
void CreateCollationNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateCollationNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropCollationNode ----------------------------------------------- */

Firebird::string DropCollationNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropCollationNode"; }
void DropCollationNode::checkPermission(thread_db*, jrd_tra*) {}
void DropCollationNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CreateDomainNode ------------------------------------------------ */

Firebird::string CreateDomainNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateDomainNode"; }
void CreateDomainNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateDomainNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- AlterDomainNode ------------------------------------------------- */

Firebird::string AlterDomainNode::internalPrint(NodePrinter& /*p*/) const
{ return "AlterDomainNode"; }
void AlterDomainNode::checkPermission(thread_db*, jrd_tra*) {}
void AlterDomainNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropDomainNode -------------------------------------------------- */

Firebird::string DropDomainNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropDomainNode"; }
void DropDomainNode::checkPermission(thread_db*, jrd_tra*) {}
void DropDomainNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CreateAlterExceptionNode ---------------------------------------- */

Firebird::string CreateAlterExceptionNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateAlterExceptionNode"; }
void CreateAlterExceptionNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateAlterExceptionNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropExceptionNode ----------------------------------------------- */

Firebird::string DropExceptionNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropExceptionNode"; }
void DropExceptionNode::checkPermission(thread_db*, jrd_tra*) {}
void DropExceptionNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CreateAlterSequenceNode ----------------------------------------- */

Firebird::string CreateAlterSequenceNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateAlterSequenceNode"; }
void CreateAlterSequenceNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateAlterSequenceNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}
void CreateAlterSequenceNode::putErrorPrefix(Firebird::Arg::StatusVector& /*sv*/) {}

/* ------- DropSequenceNode ------------------------------------------------ */

Firebird::string DropSequenceNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropSequenceNode"; }
void DropSequenceNode::checkPermission(thread_db*, jrd_tra*) {}
void DropSequenceNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CreateRelationNode ---------------------------------------------- */

Firebird::string CreateRelationNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateRelationNode"; }
void CreateRelationNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateRelationNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- AlterRelationNode ----------------------------------------------- */

Firebird::string AlterRelationNode::internalPrint(NodePrinter& /*p*/) const
{ return "AlterRelationNode"; }
void AlterRelationNode::checkPermission(thread_db*, jrd_tra*) {}
void AlterRelationNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropRelationNode ------------------------------------------------ */

Firebird::string DropRelationNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropRelationNode"; }
void DropRelationNode::checkPermission(thread_db*, jrd_tra*) {}
void DropRelationNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}
void DropRelationNode::deleteGlobalField(thread_db* /*tdbb*/,
    jrd_tra* /*transaction*/, const MetaName& /*globalName*/) {}

/* ------- CreateAlterViewNode --------------------------------------------- */

Firebird::string CreateAlterViewNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateAlterViewNode"; }
DdlNode* CreateAlterViewNode::dsqlPass(DsqlCompilerScratch* s)
{ return DdlNode::dsqlPass(s); }
void CreateAlterViewNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateAlterViewNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CreateIndexNode ------------------------------------------------- */

Firebird::string CreateIndexNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateIndexNode"; }
void CreateIndexNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateIndexNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- AlterIndexNode -------------------------------------------------- */

Firebird::string AlterIndexNode::internalPrint(NodePrinter& /*p*/) const
{ return "AlterIndexNode"; }
void AlterIndexNode::checkPermission(thread_db*, jrd_tra*) {}
void AlterIndexNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- SetStatisticsNode ----------------------------------------------- */

Firebird::string SetStatisticsNode::internalPrint(NodePrinter& /*p*/) const
{ return "SetStatisticsNode"; }
void SetStatisticsNode::checkPermission(thread_db*, jrd_tra*) {}
void SetStatisticsNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropIndexNode --------------------------------------------------- */

Firebird::string DropIndexNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropIndexNode"; }
void DropIndexNode::checkPermission(thread_db*, jrd_tra*) {}
void DropIndexNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}
bool DropIndexNode::deleteSegmentRecords(thread_db* /*tdbb*/,
    jrd_tra* /*transaction*/, const MetaName& /*name*/)
{ return false; }

/* ------- CreateFilterNode ------------------------------------------------ */

Firebird::string CreateFilterNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateFilterNode"; }
void CreateFilterNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateFilterNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropFilterNode -------------------------------------------------- */

Firebird::string DropFilterNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropFilterNode"; }
void DropFilterNode::checkPermission(thread_db*, jrd_tra*) {}
void DropFilterNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CreateShadowNode ------------------------------------------------ */

Firebird::string CreateShadowNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateShadowNode"; }
void CreateShadowNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateShadowNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropShadowNode -------------------------------------------------- */

Firebird::string DropShadowNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropShadowNode"; }
void DropShadowNode::checkPermission(thread_db*, jrd_tra*) {}
void DropShadowNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CreateAlterRoleNode --------------------------------------------- */

Firebird::string CreateAlterRoleNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateAlterRoleNode"; }
void CreateAlterRoleNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateAlterRoleNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- MappingNode ----------------------------------------------------- */

Firebird::string MappingNode::internalPrint(NodePrinter& /*p*/) const
{ return "MappingNode"; }
void MappingNode::checkPermission(thread_db*, jrd_tra*) {}
void MappingNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}
void MappingNode::validateAdmin() {}
void MappingNode::runInSecurityDb(SecDbContext* /*ctx*/) {}

/* ------- DropRoleNode ---------------------------------------------------- */

Firebird::string DropRoleNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropRoleNode"; }
void DropRoleNode::checkPermission(thread_db*, jrd_tra*) {}
void DropRoleNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- UserNode base --------------------------------------------------- */

MetaName UserNode::upper(const MetaName& str) { return str; }

/* ------- CreateAlterUserNode --------------------------------------------- */

Firebird::string CreateAlterUserNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateAlterUserNode"; }
void CreateAlterUserNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateAlterUserNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropUserNode ---------------------------------------------------- */

Firebird::string DropUserNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropUserNode"; }
void DropUserNode::checkPermission(thread_db*, jrd_tra*) {}
void DropUserNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- GrantRevokeNode ------------------------------------------------- */

Firebird::string GrantRevokeNode::internalPrint(NodePrinter& /*p*/) const
{ return "GrantRevokeNode"; }
void GrantRevokeNode::checkPermission(thread_db*, jrd_tra*) {}
void GrantRevokeNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}
void GrantRevokeNode::runInSecurityDb(SecDbContext* /*ctx*/) {}

/* ------- AlterDatabaseNode ----------------------------------------------- */

Firebird::string AlterDatabaseNode::internalPrint(NodePrinter& /*p*/) const
{ return "AlterDatabaseNode"; }
void AlterDatabaseNode::checkPermission(thread_db*, jrd_tra*) {}
void AlterDatabaseNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* -----------------------------------------------------------------------
 * PackageNodes.epp stubs  (CreateAlterPackageNode, DropPackageNode,
 *                           CreatePackageBodyNode, DropPackageBodyNode)
 * ----------------------------------------------------------------------- */

/* ------- CreateAlterPackageNode ------------------------------------------ */

DdlNode* CreateAlterPackageNode::dsqlPass(DsqlCompilerScratch* s)
{ return DdlNode::dsqlPass(s); }
Firebird::string CreateAlterPackageNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreateAlterPackageNode"; }
void CreateAlterPackageNode::checkPermission(thread_db*, jrd_tra*) {}
void CreateAlterPackageNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropPackageNode ------------------------------------------------- */

Firebird::string DropPackageNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropPackageNode"; }
void DropPackageNode::checkPermission(thread_db*, jrd_tra*) {}
void DropPackageNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- CreatePackageBodyNode ------------------------------------------- */

DdlNode* CreatePackageBodyNode::dsqlPass(DsqlCompilerScratch* s)
{ return DdlNode::dsqlPass(s); }
Firebird::string CreatePackageBodyNode::internalPrint(NodePrinter& /*p*/) const
{ return "CreatePackageBodyNode"; }
void CreatePackageBodyNode::checkPermission(thread_db*, jrd_tra*) {}
void CreatePackageBodyNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- DropPackageBodyNode --------------------------------------------- */

Firebird::string DropPackageBodyNode::internalPrint(NodePrinter& /*p*/) const
{ return "DropPackageBodyNode"; }
void DropPackageBodyNode::checkPermission(thread_db*, jrd_tra*) {}
void DropPackageBodyNode::execute(thread_db*, DsqlCompilerScratch*, jrd_tra*) {}

/* ------- RelationNode constructor ---------------------------------------- */
/* RelationNode::RelationNode() is defined in DdlNodes.epp (not compiled).
   Provide a minimal constructor that initialises all members. */

RelationNode::RelationNode(MemoryPool& p, RelationSourceNode* aDsqlNode)
    : DdlNode(p),
      dsqlNode(aDsqlNode),
      name(p),
      clauses(p)
{}

} // namespace Jrd

/* -----------------------------------------------------------------------
 * jrd_prc::reload stub  (met.epp)
 *
 * jrd_prc::checkCache and jrd_prc::clearCache are implemented in
 * jrd/Routine.cpp which IS compiled for WASM; those are NOT stubbed here.
 * jrd_prc::reload is implemented in met.epp which is NOT compiled for
 * WASM (requires the gpre preprocessor).  A no-op stub is provided here
 * to satisfy the linker; the vtable is already anchored by Routine.cpp.
 * ----------------------------------------------------------------------- */

namespace Jrd {

bool jrd_prc::reload(thread_db* /*tdbb*/) { return false; }

} // namespace Jrd

/* -----------------------------------------------------------------------
 * UserId::makeRoleName  (scl.epp stub)
 *
 * makeRoleName() normalises a SQL role name to uppercase for dialect 1,
 * and leaves it unchanged for dialect 3.  In the WASM build we skip
 * security enforcement, so a no-op is safe.
 *
 * scl.h / jrd/scl.h is pulled in transitively through jrd/exe.h.
 * ----------------------------------------------------------------------- */

namespace Jrd {

/*static*/ void UserId::makeRoleName(Firebird::MetaString& /*role*/,
    const int /*dialect*/) {}

} // namespace Jrd

/* -----------------------------------------------------------------------
 * gds__parse_bpb2  (yvalve/gds.cpp stub)
 *
 * gds__parse_bpb2 parses a Blob Parameter Block version 2 into its
 * component fields.  blb.cpp and blob_filter.cpp call it to inspect
 * blob type / sub-type information.  In the embedded WASM build blob
 * sub-types are not relevant; return 0 (no parameters found).
 *
 * Signature from src/yvalve/gds_proto.h.
 * ----------------------------------------------------------------------- */

extern "C"
USHORT API_ROUTINE gds__parse_bpb2(USHORT bpb_length, const UCHAR* /*bpb*/,
    SSHORT* /*source_type*/, SSHORT* /*target_type*/,
    USHORT* /*source_interp*/, USHORT* /*target_interp*/,
    bool* /*source_nullable*/, bool* /*target_nullable*/,
    bool* /*db_key_scope*/, bool* /*expected_scope*/)
{
    (void) bpb_length;
    return 0;
}

/* -----------------------------------------------------------------------
 * UserId::sclInit / UserId::populateDpb  (scl.epp stubs)
 *
 * sclInit() initialises the security-class list for a new attachment by
 * scanning RDB$USER_PRIVILEGES.  In the embedded WASM build there is no
 * security database and we skip this step.
 *
 * populateDpb() injects user/role credentials into a DPB (Database
 * Parameter Block) before opening a remote connection.  In the WASM
 * build external data sources are disabled (jrd/extds/ is not compiled),
 * so this stub should never be reached; it is provided for completeness
 * in case any residual reference appears.
 *
 * Both are instance methods of Jrd::UserId declared in jrd/scl.h and
 * implemented in scl.epp (not compiled for WASM).
 * ----------------------------------------------------------------------- */

namespace Jrd {

void UserId::sclInit(thread_db* /*tdbb*/, bool /*create*/) {}
void UserId::populateDpb(Firebird::ClumpletWriter& /*dpb*/, bool /*embeddedSupport*/) {}

} // namespace Jrd

/* -----------------------------------------------------------------------
 * EDS (External Data Sources) stubs
 *
 * jrd/extds/ is excluded from the WASM build because it requires the
 * legacy isc_* client API and UserId::populateDpb.  However the
 * following compiled files still call EDS:: symbols:
 *
 *   dsql/StmtNodes.cpp  – EDS::Manager::getConnection,
 *                         EDS::Connection::createStatement,
 *                         EDS::Statement::{bindToRequest, prepare,
 *                           setTimeout, open, execute, fetch, close}
 *                         EDS::Transaction::getTransaction
 *   jrd/SysFunction.cpp – EDS::Manager::getConnPool
 *   jrd/exe.cpp         – EDS::Statement::close
 *   jrd/jrd.cpp         – EDS::Transaction::jrdTransactionEnd,
 *                         EDS::Manager::{jrdAttachmentEnd, shutdown}
 *
 * All stubs are no-ops / null returns.  We forward-declare minimal class
 * skeletons rather than including ExtDS.h directly (that header pulls in
 * the legacy isc_* interface).
 *
 * The parameter types used below are all available transitively via the
 * jrd/exe.h include already present above:
 *   Jrd::thread_db, Jrd::jrd_tra, Jrd::MetaName, Jrd::ValueListNode,
 *   Firebird::string (= StringBase<StringComparator>), Firebird::Array.
 *
 * Jrd::Attachment and Jrd::Request are not provided by exe.h, so we
 * forward-declare them here.
 * ----------------------------------------------------------------------- */

namespace Jrd {
    class Attachment;
    class Request;
}

namespace EDS {

/* TraScope enum – must match ExtDS.h exactly so that callers compiled
   with the real header link against the same mangled names. */
enum TraScope { traNotSet = 0, traAutonomous, traCommon, traTwoPhase };

/* ParamNumbers – typedef from ExtDS.h line ~673 */
typedef Firebird::Array<USHORT> ParamNumbers;

/* ---- Minimal class skeletons (stubs only – no inheritance needed) ---- */

class ConnectionsPool;
class Connection;
class Transaction;

class Manager {
public:
    static Connection* getConnection(Jrd::thread_db*,
        const Firebird::string&, const Firebird::string&,
        const Firebird::string&, const Firebird::string&, TraScope);
    static ConnectionsPool* getConnPool(bool);
    static void jrdAttachmentEnd(Jrd::thread_db*, Jrd::Attachment*, bool);
    static int shutdown();
};

class Connection {
public:
    class Statement* createStatement(const Firebird::string&);
};

class Transaction {
public:
    static Transaction* getTransaction(Jrd::thread_db*, Connection*, TraScope);
    static void jrdTransactionEnd(Jrd::thread_db*, Jrd::jrd_tra*, bool, bool, bool);
};

class Statement {
public:
    void bindToRequest(Jrd::Request*, Statement**);
    void prepare(Jrd::thread_db*, Transaction*, const Firebird::string&, bool);
    void setTimeout(Jrd::thread_db*, unsigned int);
    void open(Jrd::thread_db*, Transaction*,
              const Jrd::MetaName* const*, const Jrd::ValueListNode*,
              const ParamNumbers*, bool);
    void execute(Jrd::thread_db*, Transaction*,
                 const Jrd::MetaName* const*, const Jrd::ValueListNode*,
                 const ParamNumbers*, const Jrd::ValueListNode*);
    bool fetch(Jrd::thread_db*, const Jrd::ValueListNode*);
    void close(Jrd::thread_db*, bool = false);
};

/* ---- Manager stubs ---- */

/*static*/ Connection* Manager::getConnection(Jrd::thread_db*, const Firebird::string&,
    const Firebird::string&, const Firebird::string&, const Firebird::string&, TraScope)
{ return nullptr; }

/*static*/ ConnectionsPool* Manager::getConnPool(bool) { return nullptr; }

/*static*/ void Manager::jrdAttachmentEnd(Jrd::thread_db*, Jrd::Attachment*, bool) {}

/*static*/ int Manager::shutdown() { return 0; }

/* ---- Connection stub ---- */

Statement* Connection::createStatement(const Firebird::string&) { return nullptr; }

/* ---- Transaction stubs ---- */

/*static*/ Transaction* Transaction::getTransaction(Jrd::thread_db*, Connection*, TraScope)
{ return nullptr; }

/*static*/ void Transaction::jrdTransactionEnd(Jrd::thread_db*, Jrd::jrd_tra*, bool, bool, bool) {}

/* ---- Statement stubs ---- */

void Statement::bindToRequest(Jrd::Request*, Statement**) {}

void Statement::prepare(Jrd::thread_db*, Transaction*, const Firebird::string&, bool) {}

void Statement::setTimeout(Jrd::thread_db*, unsigned int) {}

void Statement::open(Jrd::thread_db*, Transaction*,
    const Jrd::MetaName* const*, const Jrd::ValueListNode*,
    const ParamNumbers*, bool) {}

void Statement::execute(Jrd::thread_db*, Transaction*,
    const Jrd::MetaName* const*, const Jrd::ValueListNode*,
    const ParamNumbers*, const Jrd::ValueListNode*) {}

bool Statement::fetch(Jrd::thread_db*, const Jrd::ValueListNode*) { return false; }

void Statement::close(Jrd::thread_db*, bool) {}

} // namespace EDS

/* -----------------------------------------------------------------------
 * Service utility entry-point stubs  (jrd/svc.cpp references)
 *
 * jrd/svc.cpp registers the following entry points in its service table,
 * but the corresponding utility source trees (burp/, alice/, utilities/)
 * are not compiled for the WASM build.  All stubs return 1 (failure).
 *
 * Signatures come from the respective proto headers at v5.0.3:
 *   BURP_main   – burp/burp_proto.h
 *   ALICE_main  – alice/alice_proto.h
 *   GSEC_main   – utilities/gsec/gsec_proto.h
 *   main_gstat  – forward-declared inline in svc.cpp (int main_gstat(...))
 *   NBACKUP_main – utilities/nbackup/nbk_proto.h
 * ----------------------------------------------------------------------- */

namespace Firebird { class UtilSvc; }

int BURP_main(Firebird::UtilSvc*) { return 1; }
int ALICE_main(Firebird::UtilSvc*) { return 1; }
int GSEC_main(Firebird::UtilSvc*) { return 1; }
int main_gstat(Firebird::UtilSvc*) { return 1; }
int NBACKUP_main(Firebird::UtilSvc*) { return 1; }

/* -----------------------------------------------------------------------
 * fb_shutdown / fb_database_crypt_callback  (yvalve/why.cpp stubs)
 *
 * jrd/svc.cpp calls fb_shutdown (graceful engine shutdown) and
 * fb_database_crypt_callback (encryption callback registration).
 * Neither yvalve/why.cpp nor the Client API is compiled into the WASM
 * build; no-op stubs are safe.
 *
 * Signatures from src/include/firebird/ibase.h:
 *   int fb_shutdown(unsigned int timeout_millis, const int reason);
 *   ISC_STATUS fb_database_crypt_callback(ISC_STATUS*, void* callback);
 * ----------------------------------------------------------------------- */

extern "C" {

int fb_shutdown(unsigned int /*timeout_millis*/, const int /*reason*/)
{ return 0; }

ISC_STATUS fb_database_crypt_callback(ISC_STATUS* status, void* /*callback*/)
{
    if (status) status[0] = 0;
    return 0;
}

/* -----------------------------------------------------------------------
 * gds__decode  (yvalve/gds.cpp stub)
 *
 * jrd/trace/TraceCmdLine.cpp calls gds__decode to decompose a status
 * code into facility/code parts.  Return 0 (success, unknown code).
 *
 * Signature from src/yvalve/gds_proto.h:
 *   ISC_STATUS gds__decode(ISC_STATUS code, USHORT* fac, USHORT* num);
 * ----------------------------------------------------------------------- */

ISC_STATUS API_ROUTINE gds__decode(ISC_STATUS /*code*/,
    USHORT* fac, USHORT* num)
{
    if (fac) *fac = 0;
    if (num) *num = 0;
    return 0;
}

} /* extern "C" */

