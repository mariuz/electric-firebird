/*
 * Minimal ICU ucnv.h stub for Emscripten/WASM cross-compilation.
 *
 * Provides converter-related type definitions used by Firebird's
 * unicode_util.h function-pointer declarations.
 */

#ifndef UCNV_H
#define UCNV_H

#include "unicode/utypes.h"

typedef struct UConverter UConverter;

typedef enum UConverterCallbackReason {
    UCNV_UNASSIGNED = 0,
    UCNV_ILLEGAL = 1,
    UCNV_IRREGULAR = 2,
    UCNV_RESET = 3,
    UCNV_CLOSE = 4,
    UCNV_CLONE = 5
} UConverterCallbackReason;

typedef struct UConverterToUnicodeArgs {
    uint16_t size;
    UBool flush;
    UConverter *converter;
    const char *source;
    const char *sourceLimit;
    UChar *target;
    const UChar *targetLimit;
    int32_t *offsets;
} UConverterToUnicodeArgs;

typedef struct UConverterFromUnicodeArgs {
    uint16_t size;
    UBool flush;
    UConverter *converter;
    const UChar *source;
    const UChar *sourceLimit;
    char *target;
    const char *targetLimit;
    int32_t *offsets;
} UConverterFromUnicodeArgs;

typedef void (*UConverterToUCallback)(
    const void *context,
    UConverterToUnicodeArgs *toUArgs,
    const char *codeUnits,
    int32_t length,
    UConverterCallbackReason reason,
    UErrorCode *err);

typedef void (*UConverterFromUCallback)(
    const void *context,
    UConverterFromUnicodeArgs *fromUArgs,
    const UChar *codeUnits,
    int32_t length,
    UChar32 codePoint,
    UConverterCallbackReason reason,
    UErrorCode *err);

#endif /* UCNV_H */
