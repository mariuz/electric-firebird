/*
 * Minimal ICU stub – utypes.h
 *
 * Defines UErrorCode and related macros needed to compile Firebird for WASM.
 */
#ifndef UTYPES_H_STUB
#define UTYPES_H_STUB

#include "unicode/umachine.h"

typedef enum UErrorCode {
    U_ZERO_ERROR              =  0,
    U_ILLEGAL_ARGUMENT_ERROR  =  1,
    U_MISSING_RESOURCE_ERROR  =  2,
    U_INVALID_FORMAT_ERROR    =  3,
    U_FILE_ACCESS_ERROR       =  4,
    U_INTERNAL_PROGRAM_ERROR  =  5,
    U_MEMORY_ALLOCATION_ERROR =  7,
    U_INDEX_OUTOFBOUNDS_ERROR =  8,
    U_PARSE_ERROR             =  9,
    U_INVALID_CHAR_FOUND      = 10,
    U_TRUNCATED_CHAR_FOUND    = 11,
    U_ILLEGAL_CHAR_FOUND      = 12,
    U_INVALID_TABLE_FORMAT    = 13,
    U_INVALID_TABLE_FILE      = 14,
    U_BUFFER_OVERFLOW_ERROR   = 15,
    U_UNSUPPORTED_ERROR       = 16,
    U_USING_FALLBACK_WARNING  = -128,
    U_USING_DEFAULT_WARNING   = -127,
    U_ERROR_WARNING_START     = -128,
    U_ERROR_WARNING_LIMIT     =   0
} UErrorCode;

#define U_SUCCESS(x) ((x) <= U_ZERO_ERROR)
#define U_FAILURE(x) ((x) >  U_ZERO_ERROR)

#endif /* UTYPES_H_STUB */
