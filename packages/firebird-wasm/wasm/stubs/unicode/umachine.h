/*
 * Minimal ICU umachine.h stub for Emscripten/WASM cross-compilation.
 *
 * Firebird loads ICU dynamically at runtime via dlopen(); only the type
 * definitions are required at compile time.  This header provides the
 * subset of ICU machine-level types used by the Firebird source tree.
 */

#ifndef UMACHINE_H
#define UMACHINE_H

#include <stdint.h>

typedef int8_t UBool;
typedef char16_t UChar;
typedef int32_t UChar32;

#ifndef TRUE
#define TRUE 1
#endif
#ifndef FALSE
#define FALSE 0
#endif

#define U_EXPORT2
#define U_STABLE extern
#define U_CAPI extern "C"

#endif /* UMACHINE_H */
