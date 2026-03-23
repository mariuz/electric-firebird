/*
 * Minimal ICU utypes.h stub for Emscripten/WASM cross-compilation.
 *
 * Provides core ICU type definitions needed by Firebird at compile time.
 * No actual ICU functionality is linked – Firebird loads ICU via dlopen().
 */

#ifndef UTYPES_H
#define UTYPES_H

#include "unicode/umachine.h"
#include <stdint.h>

typedef enum UErrorCode {
    U_ZERO_ERROR = 0,
    U_ILLEGAL_ARGUMENT_ERROR = 1,
    U_MISSING_RESOURCE_ERROR = 2,
    U_INVALID_FORMAT_ERROR = 3,
    U_FILE_ACCESS_ERROR = 4,
    U_INTERNAL_PROGRAM_ERROR = 5,
    U_MEMORY_ALLOCATION_ERROR = 7,
    U_INDEX_OUTOFBOUNDS_ERROR = 8,
    U_INVALID_CHAR_FOUND = 10,
    U_TRUNCATED_CHAR_FOUND = 11,
    U_ILLEGAL_CHAR_FOUND = 12,
    U_BUFFER_OVERFLOW_ERROR = 15,
    U_UNSUPPORTED_ERROR = 16,
    U_STRING_NOT_TERMINATED_WARNING = -124,
    U_ERROR_LIMIT
} UErrorCode;

#define U_SUCCESS(x) ((x) <= U_ZERO_ERROR)
#define U_FAILURE(x) ((x) > U_ZERO_ERROR)

#endif /* UTYPES_H */
