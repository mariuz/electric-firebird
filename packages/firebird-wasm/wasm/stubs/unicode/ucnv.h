/*
 * Minimal ICU stub – ucnv.h  (character conversion)
 *
 * Only type/enum definitions needed – Firebird resolves ucnv_* functions
 * at runtime via dlsym / GetProcAddress.
 */
#ifndef UCNV_H_STUB
#define UCNV_H_STUB

#include "unicode/utypes.h"

typedef struct UConverter UConverter;

typedef enum {
    UCNV_UNASSIGNED       = 0,
    UCNV_ILLEGAL          = 1,
    UCNV_IRREGULAR        = 2,
    UCNV_RESET            = 3,
    UCNV_CLOSE            = 4,
    UCNV_CLONE            = 5
} UConverterCallbackReason;

typedef struct {
    uint16_t size;
    UBool    flush;
    UConverter *converter;
    const UChar *source;
    const UChar *sourceLimit;
    char *target;
    const char *targetLimit;
    int32_t *offsets;
} UConverterFromUnicodeArgs;

typedef struct {
    uint16_t size;
    UBool    flush;
    UConverter *converter;
    const char *source;
    const char *sourceLimit;
    UChar *target;
    const UChar *targetLimit;
    int32_t *offsets;
} UConverterToUnicodeArgs;

typedef void (*UConverterFromUCallback)(
    const void *context,
    UConverterFromUnicodeArgs *args,
    const UChar *codeUnits,
    int32_t length,
    UChar32 codePoint,
    UConverterCallbackReason reason,
    UErrorCode *pErrorCode);

typedef void (*UConverterToUCallback)(
    const void *context,
    UConverterToUnicodeArgs *args,
    const char *codeUnits,
    int32_t length,
    UConverterCallbackReason reason,
    UErrorCode *pErrorCode);

#endif /* UCNV_H_STUB */
