/*
 * Minimal ICU ucol.h stub for Emscripten/WASM cross-compilation.
 *
 * Provides collation-related type definitions used by Firebird's
 * unicode_util.cpp.
 */

#ifndef UCOL_H
#define UCOL_H

#include "unicode/utypes.h"

typedef struct UCollator UCollator;
typedef struct USet USet;

typedef enum UCollationStrength {
    UCOL_PRIMARY = 0,
    UCOL_SECONDARY = 1,
    UCOL_TERTIARY = 2,
    UCOL_QUATERNARY = 3,
    UCOL_IDENTICAL = 15
} UCollationStrength;

typedef enum UColAttributeValue {
    UCOL_DEFAULT = -1,
    UCOL_PRIMARY_VALUE = 0,
    UCOL_ON = 17,
    UCOL_OFF = 16,
    UCOL_SHIFTED = 20,
    UCOL_NON_IGNORABLE = 21
} UColAttributeValue;

typedef enum UColAttribute {
    UCOL_FRENCH_COLLATION,
    UCOL_ALTERNATE_HANDLING,
    UCOL_CASE_FIRST,
    UCOL_CASE_LEVEL,
    UCOL_NORMALIZATION_MODE,
    UCOL_STRENGTH = 5,
    UCOL_NUMERIC_COLLATION = 7
} UColAttribute;

typedef enum UColBoundMode {
    UCOL_BOUND_LOWER = 0,
    UCOL_BOUND_UPPER = 1,
    UCOL_BOUND_UPPER_LONG = 2
} UColBoundMode;

typedef enum UCollationResult {
    UCOL_LESS = -1,
    UCOL_EQUAL = 0,
    UCOL_GREATER = 1
} UCollationResult;

#endif /* UCOL_H */
