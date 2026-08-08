# Debugging the WASM build

## Getting a useful stack trace

The release build strips names and inlines aggressively, so a trap reports
little more than "function signature mismatch". Rebuild with assertions:

```bash
source third_party/emsdk/emsdk_env.sh
cd packages/firebird-wasm/wasm
emcmake cmake -B build -S . \
  -DFIREBIRD_SRC="$PWD/firebird-src" \
  -DFB_EPP_GENERATED_DIR="$PWD/build-native-config/epp-generated" \
  -DFB_WASM_DEBUG=ON
cmake --build build -j$(nproc)
```

`FB_WASM_DEBUG` adds `-sASSERTIONS=2`, `--profiling-funcs` (function names in
traces) and `-g`.

Line numbers need DWARF, which is far too large for the whole engine. Name
just the files under investigation:

```bash
emcmake cmake -B build -S . ... -DFB_WASM_DEBUG=ON \
  -DFB_WASM_DEBUG_SOURCES="$PWD/firebird-src/src/jrd/jrd.cpp;$PWD/firebird-src/src/jrd/Database.cpp"
```

Then map a trap address from the stack trace to a source line:

```bash
emsymbolizer -s dwarf build/firebird-embedded.wasm 0x1c4d36
```

It prints the full inline chain, innermost first.

## Reproducing without a browser

The artifact runs under Node (`ENVIRONMENT` includes `node`), which iterates
far faster than Playwright:

```js
const createFirebirdModule = require('./build/firebird-embedded.js');
const mod = await createFirebirdModule();
console.log(mod._fb_init());          // 0 = ok
// _fb_last_error() carries the engine's own message
```

## Known WASM-hostile constructs

- `invoke()` in `fun.epp` (legacy UDF dispatch) calls function pointers of
  varying arity. This makes `-sEMULATE_FUNCTION_POINTER_CASTS=1` fail Binaryen
  validation, so that flag is not usable as a blanket workaround. UDFs are
  meaningless in a browser and the path is a candidate for exclusion.
- `autoconfig.h` is generated for the 64-bit host and then patched for the
  32-bit target (`SIZEOF_LONG` 8 → 4, among others). Size and alignment
  assumptions that survive that patch are a plausible source of memory
  corruption.
