/*
 * Minimal ICU utf8.h stub for Emscripten/WASM cross-compilation.
 *
 * Provides the UTF-8 macros used by Firebird's SimilarToRegex.cpp.
 * Definitions follow the ICU reference implementation semantics.
 */

#ifndef UTF8_H
#define UTF8_H

#include "unicode/umachine.h"
#include <stdint.h>

#define U8_IS_SINGLE(c)    (((c) & 0x80) == 0)
#define U8_IS_LEAD(c)      ((uint8_t)((c) - 0xc2) <= 0x32)
#define U8_IS_TRAIL(c)     (((c) & 0xc0) == 0x80)
#define U8_COUNT_TRAIL_BYTES(leadByte) \
    ((uint8_t)(leadByte) >= 0xf0 ? 3 : \
     (uint8_t)(leadByte) >= 0xe0 ? 2 : \
     (uint8_t)(leadByte) >= 0xc2 ? 1 : 0)
#define U8_LENGTH(c) \
    ((uint32_t)(c) <= 0x7f ? 1 : \
     ((uint32_t)(c) <= 0x7ff ? 2 : \
      ((uint32_t)(c) <= 0xffff ? 3 : 4)))

#define U8_NEXT_UNSAFE(s, i, c) { \
    (c) = (uint8_t)(s)[(i)++]; \
    if (!U8_IS_SINGLE(c)) { \
        if ((c) < 0xe0) { \
            (c) = (((c) & 0x1f) << 6) | ((s)[(i)++] & 0x3f); \
        } else if ((c) < 0xf0) { \
            (c) = (((c) & 0x0f) << 12) | (((s)[(i)] & 0x3f) << 6) | ((s)[(i) + 1] & 0x3f); \
            (i) += 2; \
        } else { \
            (c) = (((c) & 0x07) << 18) | (((s)[(i)] & 0x3f) << 12) | \
                  (((s)[(i) + 1] & 0x3f) << 6) | ((s)[(i) + 2] & 0x3f); \
            (i) += 3; \
        } \
    } \
}

#define U8_NEXT(s, i, length, c) { \
    (c) = (uint8_t)(s)[(i)++]; \
    if (!U8_IS_SINGLE(c)) { \
        uint8_t __count = U8_COUNT_TRAIL_BYTES(c); \
        if ((i) + __count <= (length)) { \
            uint8_t __t = 0; \
            switch (__count) { \
            case 3: \
                __t = (uint8_t)(s)[(i)]; \
                if (!U8_IS_TRAIL(__t)) { (c) = 0xfffd; break; } \
                (c) = ((c) << 6) | (__t & 0x3f); \
                ++(i); \
                /* fall through */ \
            case 2: \
                __t = (uint8_t)(s)[(i)]; \
                if (!U8_IS_TRAIL(__t)) { (c) = 0xfffd; break; } \
                (c) = ((c) << 6) | (__t & 0x3f); \
                ++(i); \
                /* fall through */ \
            case 1: \
                __t = (uint8_t)(s)[(i)]; \
                if (!U8_IS_TRAIL(__t)) { (c) = 0xfffd; break; } \
                (c) = ((c) << 6) | (__t & 0x3f); \
                ++(i); \
                (c) &= ~(0xff << (__count * 5 + 6)); \
                break; \
            default: \
                (c) = 0xfffd; \
                break; \
            } \
        } else { \
            (c) = 0xfffd; \
        } \
    } \
}

#define U8_APPEND_UNSAFE(s, i, c) { \
    if ((uint32_t)(c) <= 0x7f) { \
        (s)[(i)++] = (uint8_t)(c); \
    } else if ((uint32_t)(c) <= 0x7ff) { \
        (s)[(i)++] = (uint8_t)(((c) >> 6) | 0xc0); \
        (s)[(i)++] = (uint8_t)(((c) & 0x3f) | 0x80); \
    } else if ((uint32_t)(c) <= 0xffff) { \
        (s)[(i)++] = (uint8_t)(((c) >> 12) | 0xe0); \
        (s)[(i)++] = (uint8_t)((((c) >> 6) & 0x3f) | 0x80); \
        (s)[(i)++] = (uint8_t)(((c) & 0x3f) | 0x80); \
    } else { \
        (s)[(i)++] = (uint8_t)(((c) >> 18) | 0xf0); \
        (s)[(i)++] = (uint8_t)((((c) >> 12) & 0x3f) | 0x80); \
        (s)[(i)++] = (uint8_t)((((c) >> 6) & 0x3f) | 0x80); \
        (s)[(i)++] = (uint8_t)(((c) & 0x3f) | 0x80); \
    } \
}

#endif /* UTF8_H */
