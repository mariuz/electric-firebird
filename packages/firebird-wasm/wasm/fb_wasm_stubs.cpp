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
 * fb_get_master_interface  –  NO LONGER STUBBED
 *
 * This used to return NULL, which is why nothing could ever be built on top
 * of it.  The WASM build now compiles src/yvalve/, and
 * yvalve/MasterImplementation.cpp provides the real implementation that
 * bootstraps the provider/plugin infrastructure — which fb_wasm_api.cpp
 * depends on.  Keeping the stub here is a duplicate-symbol link error.
 * ----------------------------------------------------------------------- */

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
#include "common/classes/TriState.h"       /* Firebird::TriState (used by value) */
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

    /* IndexStatus used to be replicated here.  Firebird 6 defines it in
       jrd/Relation.h (with renamed enumerators: MET_index_active,
       MET_index_state_unknown, …), which this file includes, so a local copy
       is now a redefinition. */

}

/* From dsql/sym.h – used by MET_dsql_cache_use/release. */
#include "dsql/sym.h"

/* Firebird 6 moved two types the MET_* stubs below use by value into headers
   that this file previously only included further down:
     ElementBase::ReturnedId  – metadata-cache element id (jrd/CacheVector.h)
     IndexStatus              – index state enum (jrd/Relation.h)
   They used to be hand-replicated above; using the real declarations keeps the
   stubs in step with upstream instead of drifting again. */
#include "jrd/CacheVector.h"
#include "jrd/Relation.h"

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
 * Remote::registerRedirector  (remote/client/interface.cpp)
 *
 * yvalve/PluginManager.cpp registers the remote (network) provider at
 * startup.  src/remote/ is not compiled for WASM — a browser build has no
 * network wire protocol and talks only to the embedded engine — so the
 * registration is a no-op.  The engine provider is registered separately by
 * fb_init() in fb_wasm_api.cpp.
 * ----------------------------------------------------------------------- */

namespace Firebird { class IPluginManager; }

namespace Remote {
    void registerRedirector(Firebird::IPluginManager*) {}
}

/* -----------------------------------------------------------------------
 * EDS::ConnectionsPool  (jrd/extds/ExtDS.cpp)
 *
 * The External Data Sources subsystem is excluded from the WASM build (see
 * the extds/ filter in CMakeLists.txt), but jrd/ still calls into its
 * connection pool from configuration and shutdown paths.  No external
 * connections can exist here, so these are no-ops.
 * ----------------------------------------------------------------------- */

namespace Jrd { class thread_db; }

namespace EDS {
    class ConnectionsPool
    {
    public:
        void clearIdle(Jrd::thread_db*, bool);
        void setLifeTime(unsigned long);
        void setMaxCount(unsigned long);
    };

    void ConnectionsPool::clearIdle(Jrd::thread_db*, bool) {}
    void ConnectionsPool::setLifeTime(unsigned long) {}
    void ConnectionsPool::setMaxCount(unsigned long) {}
}

/* -----------------------------------------------------------------------
 * pthread_mutexattr_setpshared / pthread_condattr_setpshared
 *
 * Emscripten declares both but returns ENOTSUP for PTHREAD_PROCESS_SHARED:
 * there is no second process in a WASM instance to share a mutex with.
 * Firebird requests it while initialising the shared-memory structures its
 * lock manager uses for inter-process database access, and treats the failure
 * as fatal — which is what stopped fb_create_database().
 *
 * A single-process embedded engine has nothing to coordinate with, so
 * reporting success is accurate rather than merely convenient.  These
 * definitions override the libc ones at link time; a macro cannot be used
 * because <pthread.h> declares these functions and the macro would mangle the
 * declaration.
 * ----------------------------------------------------------------------- */

#include <pthread.h>

extern "C" {

int pthread_mutexattr_setpshared(pthread_mutexattr_t*, int) { return 0; }
int pthread_condattr_setpshared(pthread_condattr_t*, int) { return 0; }

} /* extern "C" */
