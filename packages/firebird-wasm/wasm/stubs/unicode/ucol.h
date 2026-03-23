/*
 * Minimal ICU stub – ucol.h  (collation)
 */
#ifndef UCOL_H_STUB
#define UCOL_H_STUB

#include "unicode/utypes.h"
#include "unicode/parseerr.h"

typedef struct UCollator UCollator;

typedef enum {
    UCOL_LESS    = -1,
    UCOL_EQUAL   =  0,
    UCOL_GREATER =  1
} UCollationResult;

typedef enum {
    UCOL_DEFAULT          = -1,
    UCOL_PRIMARY          =  0,
    UCOL_SECONDARY        =  1,
    UCOL_TERTIARY         =  2,
    UCOL_DEFAULT_STRENGTH =  2,
    UCOL_CE_STRENGTH_LIMIT,
    UCOL_QUATERNARY       =  3,
    UCOL_IDENTICAL        = 15
} UCollationStrength;

typedef enum {
    UCOL_FRENCH_COLLATION,
    UCOL_ALTERNATE_HANDLING,
    UCOL_CASE_FIRST,
    UCOL_CASE_LEVEL,
    UCOL_NORMALIZATION_MODE,
    UCOL_DECOMPOSITION_MODE = UCOL_NORMALIZATION_MODE,
    UCOL_STRENGTH,
    UCOL_NUMERIC_COLLATION  = 7,
    UCOL_ATTRIBUTE_COUNT
} UColAttribute;

typedef enum {
    UCOL_NON_IGNORABLE = 0x15,
    UCOL_SHIFTED       = 0x14,
    UCOL_LOWER_FIRST   = 0x18,
    UCOL_UPPER_FIRST   = 0x19,
    UCOL_ON            = 0x11,
    UCOL_OFF           = 0x10,
    UCOL_DEFAULT_VALUE = -1,
    UCOL_ATTRIBUTE_VALUE_COUNT
} UColAttributeValue;

#endif /* UCOL_H_STUB */
