/*
 * Minimal ICU stub – parseerr.h
 */
#ifndef PARSEERR_H_STUB
#define PARSEERR_H_STUB

#include "unicode/utypes.h"

typedef struct UParseError {
    int32_t line;
    int32_t offset;
    UChar   preContext[16];
    UChar   postContext[16];
} UParseError;

#endif /* PARSEERR_H_STUB */
