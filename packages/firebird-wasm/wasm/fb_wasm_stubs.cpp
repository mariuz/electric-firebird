/*
 * fb_wasm_stubs.cpp – the few symbols the browser engine provides itself.
 *
 * Everything the engine needs is Firebird's own code, compiled, except what
 * is here: POSIX calls Emscripten lacks or refuses (sem_timedwait, the
 * process-shared attributes), the RCU singleton libcds's signal variant would
 * define, and the entry points of what a browser build leaves out (the backup,
 * repair, security and statistics utilities behind the service manager, and
 * the network provider).  Each one says why it is accurate here, not merely
 * convenient: a stub whose reason expires keeps working just well enough to
 * hide the failure (docs/roadmap.md, "The create-database trap").
 *
 * Gone, and why:
 *   fb_get_master_interface – yvalve/MasterImplementation.cpp is compiled.
 *   MET_* and the .epp stubs – the metadata layer is compiled (gpre boot pass).
 *   libcds ThreadData       – the real init attaches the hazard-pointer GC.
 *   EDS::*                  – jrd/extds/ is compiled: the no-op stubs made
 *                             EXECUTE STATEMENT silently do nothing.
 *   fallocate               – its callers are compiled out with
 *                             HAVE_LINUX_FALLOC_H (build.sh), and it claimed
 *                             space it never allocated.
 */

#include "firebird.h"
#include "firebird/impl/types_pub.h"


/* -----------------------------------------------------------------------
 * sem_timedwait  –  POSIX semaphore wait with timeout.
 *
 * Emscripten does not provide it, so it is implemented here by polling
 * sem_trywait until the caller's absolute deadline.
 *
 * This used to try sem_trywait exactly once and then report ETIMEDOUT,
 * on the grounds that "in the single-threaded WASM environment, blocking
 * waits would deadlock".  That premise died when the build gained real
 * pthreads: the engine now has other threads that will post the semaphore,
 * and refusing to wait for them made every wait fail instantly.  It surfaced
 * as "semaphore.h: enter: sem_wait() failed -Operation timed out" during
 * database creation.
 *
 * Polling rather than a futex wait keeps this portable across Emscripten's
 * threading modes; the interval is short enough not to add noticeable latency
 * and long enough not to spin a core.
 * ----------------------------------------------------------------------- */
#include <semaphore.h>
#include <errno.h>
#include <time.h>

extern "C"
int sem_timedwait(sem_t* sem, const struct timespec* abs_timeout)
{
    for (;;)
    {
        if (sem_trywait(sem) == 0)
            return 0;

        /* Anything other than "would block" is a real error. */
        if (errno != EAGAIN)
            return -1;

        if (abs_timeout)
        {
            struct timespec now;
            clock_gettime(CLOCK_REALTIME, &now);

            if (now.tv_sec > abs_timeout->tv_sec ||
                (now.tv_sec == abs_timeout->tv_sec &&
                 now.tv_nsec >= abs_timeout->tv_nsec))
            {
                errno = ETIMEDOUT;
                return -1;
            }
        }

        struct timespec nap = { 0, 200000 };   /* 0.2 ms */
        nanosleep(&nap, nullptr);
    }
}

/* -----------------------------------------------------------------------
 * libcds  —  NO LONGER STUBBED
 *
 * The stubs here replaced cds::threading::ThreadData::init()/fini() and the
 * init_first_call()/fini_last_call() pair, on the assumption that the real
 * files pull in URCU.  They do not, and the stubbed init() skipped attaching
 * the thread to the hazard-pointer GC — which Firebird's metadata cache
 * (CacheVector -> SharedReadVector -> HazardPtr) requires.  extern/libcds
 * init.cpp, thread_data.cpp, hp.cpp and dhp.cpp are compiled instead; see
 * CMakeLists.txt.
 *
 * One symbol still needs defining here.  thread_data.cpp references the RCU
 * singleton instance pointers, and the signal-handler variant lives in
 * urcu_sh.cpp, which cannot be compiled under Emscripten — it is built on
 * POSIX signals.  Nothing in the engine's path uses RCU, so a null singleton
 * is accurate: the pointer is only ever read to find an RCU instance that was
 * never created.  urcu_gp.cpp (the non-signal variant) is compiled normally.
 * ----------------------------------------------------------------------- */

#include <cds/urcu/details/sh.h>

namespace cds { namespace urcu { namespace details {

template<> CDS_EXPORT_API singleton_vtbl*
    sh_singleton_instance<signal_buffered_tag>::s_pRCU = nullptr;

}}} // namespace cds::urcu::details

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
