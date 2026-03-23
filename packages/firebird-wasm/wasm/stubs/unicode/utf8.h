/*
 * Minimal ICU stub – utf8.h
 *
 * Provides the UTF-8 helper macros that Firebird source files use directly
 * (e.g. IntlUtil.cpp).  Definitions are taken verbatim from ICU so the
 * semantics match exactly.
 */
#ifndef UTF8_H_STUB
#define UTF8_H_STUB

#include "unicode/umachine.h"
#include <stdint.h>

/* ── Single-byte test ──────────────────────────────────────────────────── */
#ifndef U8_IS_SINGLE
#define U8_IS_SINGLE(c) (((c)&0x80)==0)
#endif

/* ── Forward iteration (unsafe – caller guarantees valid UTF-8) ────────── */
#ifndef U8_NEXT_UNSAFE
#define U8_NEXT_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    (c)=(uint8_t)(s)[(i)++]; \
    if(!U8_IS_SINGLE(c)) { \
        if((c)<0xe0) { \
            (c)=(((c)&0x1f)<<6)|((s)[(i)++]&0x3f); \
        } else if((c)<0xf0) { \
            (c)=(UChar)(((c)<<12)|(((s)[i]&0x3f)<<6)|((s)[(i)+1]&0x3f)); \
            (i)+=2; \
        } else { \
            (c)=(((c)&7)<<18)|(((s)[i]&0x3f)<<12)|(((s)[(i)+1]&0x3f)<<6)|((s)[(i)+2]&0x3f); \
            (i)+=3; \
        } \
    } \
} UPRV_BLOCK_MACRO_END
#endif

/* ── Code-point byte length ─────────────────────────────────────────────── */
#ifndef U8_LENGTH
#define U8_LENGTH(c) \
    ((uint32_t)(c)<=0x7f ? 1 : \
        ((uint32_t)(c)<=0x7ff ? 2 : \
            ((uint32_t)(c)<=0xffff ? 3 : 4)))
#endif

/* ── Append a code point (unsafe – caller guarantees capacity) ────────── */
#ifndef U8_APPEND_UNSAFE
#define U8_APPEND_UNSAFE(s, i, c) UPRV_BLOCK_MACRO_BEGIN { \
    uint32_t __uc=(c); \
    if(__uc<=0x7f) { \
        (s)[(i)++]=(uint8_t)__uc; \
    } else { \
        if(__uc<=0x7ff) { \
            (s)[(i)++]=(uint8_t)((__uc>>6)|0xc0); \
        } else { \
            if(__uc<=0xffff) { \
                (s)[(i)++]=(uint8_t)((__uc>>12)|0xe0); \
            } else { \
                (s)[(i)++]=(uint8_t)((__uc>>18)|0xf0); \
                (s)[(i)++]=(uint8_t)(((__uc>>12)&0x3f)|0x80); \
            } \
            (s)[(i)++]=(uint8_t)(((__uc>>6)&0x3f)|0x80); \
        } \
        (s)[(i)++]=(uint8_t)((__uc&0x3f)|0x80); \
    } \
} UPRV_BLOCK_MACRO_END
#endif

#endif /* UTF8_H_STUB */
