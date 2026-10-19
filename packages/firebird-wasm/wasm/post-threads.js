// Appended inside the module's scope (--post-js), in the threaded build only.
//
// The worker pool (PTHREAD_POOL_SIZE) lives in this scope, where the loader
// cannot reach it: dropping the module left every worker running, each with
// its own compiled copy of the engine, about 400 MB a module in Node.
// disposeFirebirdWasm() calls this, after fb_dispose() has stopped the
// engine's own threads.
//
// terminateRuntime, not terminateAllThreads: the main thread also waits on its
// mailbox with Atomics.waitAsync, and that pending wait held the whole module
// (in Node, 45 MB more a load/dispose cycle).  terminateRuntime ends the
// workers, marks the main thread exited and notifies the mailbox, so the wait
// settles and the module can be collected.
Module['fbTerminateThreads'] = () => PThread.terminateRuntime();
