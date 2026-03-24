/*
 * Minimal ICU stub – utf_old.h
 *
 * Provides the deprecated UTF-16 surrogate-pair helper macros that
 * Firebird's unicode_util.cpp uses (conditionally included when
 * U_ICU_VERSION_MAJOR_NUM >= 51).
 *
 * Definitions are taken from the real ICU utf_old.h / utf16.h so the
 * semantics match exactly.
 */
#ifndef UTF_OLD_H_STUB
#define UTF_OLD_H_STUB

#include "unicode/umachine.h"

/* ── Surrogate constants ───────────────────────────────────────────────── */
#ifndef U16_SURROGATE_OFFSET
#define U16_SURROGATE_OFFSET ((0xd800 << 10UL) + 0xdc00 - 0x10000)
#endif

/* ── Surrogate tests ───────────────────────────────────────────────────── */
#ifndef UTF_IS_SURROGATE
#define UTF_IS_SURROGATE(uchar) (((uchar) & 0xfffff800) == 0xd800)
#endif

#ifndef UTF_IS_SURROGATE_FIRST
#define UTF_IS_SURROGATE_FIRST(uchar) (((uchar) & 0xfffffc00) == 0xd800)
#endif

#ifndef UTF_IS_LEAD
#define UTF_IS_LEAD(uchar) (((uchar) & 0xfffffc00) == 0xd800)
#endif

#ifndef UTF_IS_TRAIL
#define UTF_IS_TRAIL(uchar) (((uchar) & 0xfffffc00) == 0xdc00)
#endif

/* ── Surrogate pair ↔ code-point conversion ────────────────────────────── */
#ifndef UTF16_GET_PAIR_VALUE
#define UTF16_GET_PAIR_VALUE(first, second) \
    (((UChar32)(first) << 10UL) + (UChar32)(second) - U16_SURROGATE_OFFSET)
#endif

#ifndef UTF16_LEAD
#define UTF16_LEAD(supplementary) (UChar)(((supplementary) >> 10) + 0xd7c0)
#endif

#ifndef UTF16_TRAIL
#define UTF16_TRAIL(supplementary) (UChar)(((supplementary) & 0x3ff) | 0xdc00)
#endif

#endif /* UTF_OLD_H_STUB */
