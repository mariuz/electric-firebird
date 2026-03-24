/*
 * fb_wasm_api.cpp – WASM C API glue layer for the Firebird Embedded engine.
 *
 * This file provides the extern "C" functions exported to JavaScript via
 * Emscripten's -s EXPORTED_FUNCTIONS.  Each function wraps the Firebird
 * internal C++ API (isc_* / fb_* in yvalve/) into a flat, pointer-based
 * interface that the TypeScript wasm-loader can call.
 *
 * Current state: stub implementations that compile and link.  The real
 * database operations will be wired up once the full yvalve / jrd engine
 * integration is complete.
 */

#include <cstdlib>
#include <cstring>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define FB_WASM_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define FB_WASM_EXPORT
#endif

extern "C" {

/*
 * Initialise the embedded engine.
 * Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_init(void)
{
    /* TODO: call Firebird provider initialisation once yvalve is wired up */
    return 0;
}

/*
 * Create a new database at the given path.
 * Returns a database handle (>0) on success, 0 on failure.
 */
FB_WASM_EXPORT
int fb_create_database(const char* path)
{
    (void)path;
    /* TODO: call isc_create_database or equivalent */
    return 0;
}

/*
 * Attach to an existing database at the given path.
 * Returns a database handle (>0) on success, 0 on failure.
 */
FB_WASM_EXPORT
int fb_attach_database(const char* path)
{
    (void)path;
    /* TODO: call isc_attach_database or equivalent */
    return 0;
}

/*
 * Detach from a database.
 * Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_detach_database(int handle)
{
    (void)handle;
    /* TODO: call isc_detach_database */
    return 0;
}

/*
 * Execute a non-query SQL statement (DDL / DML).
 * Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_execute(int db_handle, const char* sql)
{
    (void)db_handle;
    (void)sql;
    /* TODO: call isc_dsql_execute_immediate or equivalent */
    return 0;
}

/*
 * Execute a query and return a pointer to a JSON-encoded result string.
 * The caller must free the returned pointer via fb_free_result().
 * Returns a pointer to the JSON string, or 0 on failure.
 *
 * Result format: {"columns":["COL1","COL2"],"rows":[[val1,val2],...]}
 */
FB_WASM_EXPORT
const char* fb_query(int db_handle, const char* sql)
{
    (void)db_handle;
    (void)sql;
    /* TODO: execute query via isc_dsql_*, serialise result to JSON */

    /* Return an empty result set for now */
    const char* empty = "{\"columns\":[],\"rows\":[]}";
    size_t len = strlen(empty) + 1;
    char* result = static_cast<char*>(malloc(len));
    if (result) {
        memcpy(result, empty, len);
    }
    return result;
}

/*
 * Free a result set returned by fb_query().
 */
FB_WASM_EXPORT
void fb_free_result(const char* ptr)
{
    free(const_cast<char*>(ptr));
}

/*
 * Start a new transaction on the given database.
 * Returns a transaction handle (>0) on success, 0 on failure.
 */
FB_WASM_EXPORT
int fb_start_transaction(int db_handle)
{
    (void)db_handle;
    /* TODO: call isc_start_transaction */
    return 0;
}

/*
 * Commit a transaction.
 * Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_commit(int tx_handle)
{
    (void)tx_handle;
    /* TODO: call isc_commit_transaction */
    return 0;
}

/*
 * Rollback a transaction.
 * Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_rollback(int tx_handle)
{
    (void)tx_handle;
    /* TODO: call isc_rollback_transaction */
    return 0;
}

} /* extern "C" */
