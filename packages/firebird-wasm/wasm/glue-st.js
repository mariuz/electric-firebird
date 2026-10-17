// Appended after the module factory (--extern-post-js): tells the loader
// which build this glue is before it is called.  See FB_WASM_THREADS.
createFirebirdModule.threads = false;
