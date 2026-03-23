/*
 * Minimal ICU stub – utf16.h
 *
 * Provides the UTF-16 helper macros that Firebird source files use directly
 * (e.g. unicode_util.cpp).  Definitions are taken verbatim from ICU so the
 * semantics match exactly.
 */
#ifndef UTF16_H_STUB
#define UTF16_H_STUB

#include "unicode/umachine.h"
#include <stdint.h>

/* ── Surrogate constants ───────────────────────────────────────────────── */
#ifndef U16_SURROGATE_OFFSET
#define U16_SURROGATE_OFFSET ((0xd800 << 10UL) + 0xdc00 - 0x10000)
#endif

/* ── Lead / trail surrogate tests ──────────────────────────────────────── */
#ifndef U16_IS_LEAD
#define U16_IS_LEAD(c) (((c) & 0xfffffc00) == 0xd800)
#endif

#ifndef U16_IS_TRAIL
#define U16_IS_TRAIL(c) (((c) & 0xfffffc00) == 0xdc00)
#endif

/* ── Supplementary code-point assembly ─────────────────────────────────── */
#ifndef U16_GET_SUPPLEMENTARY
#define U16_GET_SUPPLEMENTARY(lead, trail) \
    (((UChar32)(lead) << 10UL) + (UChar32)(trail) - U16_SURROGATE_OFFSET)
#endif

/* ── Forward iteration ─────────────────────────────────────────────────── */
#ifndef U16_NEXT
#define U16_NEXT(s, i, length, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(s)[(i)++]; \
    if(U16_IS_LEAD(c)) { \
        uint16_t __c2; \
        if((i)!=(length) && U16_IS_TRAIL((__c2=(s)[(i)]))) { \
            ++(i); \
            (c)=U16_GET_SUPPLEMENTARY((c), __c2); \
        } \
    } \
} UPRV_BLOCK_MACRO_END
#endif

/* ── Append a code point ───────────────────────────────────────────────── */
#ifndef U16_APPEND
#define U16_APPEND(s, i, capacity, c, isError) UPRV_BLOCK_MACRO_BEGIN { \
    if((uint32_t)(c)<=0xffff) { \
        (s)[(i)++]=(uint16_t)(c); \
    } else if((uint32_t)(c)<=0x10ffff && (i)+1<(capacity)) { \
        (s)[(i)++]=(uint16_t)(((c)>>10)+0xd7c0); \
        (s)[(i)++]=(uint16_t)(((c)&0x3ff)|0xdc00); \
    } else { \
        (isError)=TRUE; \
    } \
} UPRV_BLOCK_MACRO_END
#endif

#endif /* UTF16_H_STUB */
