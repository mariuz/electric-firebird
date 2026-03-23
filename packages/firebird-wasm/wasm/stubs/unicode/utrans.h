/*
 * Minimal ICU utrans.h stub for Emscripten/WASM cross-compilation.
 *
 * Provides transliterator type definitions used by Firebird's
 * unicode_util.cpp.
 */

#ifndef UTRANS_H
#define UTRANS_H

#include "unicode/utypes.h"

typedef struct UTransliterator UTransliterator;

typedef enum UTransDirection {
    UTRANS_FORWARD,
    UTRANS_REVERSE
} UTransDirection;

#endif /* UTRANS_H */
