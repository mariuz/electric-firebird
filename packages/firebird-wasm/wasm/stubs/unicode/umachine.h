/*
 * Minimal ICU stub – umachine.h
 *
 * Provides the fundamental ICU type aliases and calling-convention macros
 * needed to compile Firebird sources for WASM.  Firebird loads ICU
 * dynamically at runtime, so only the type definitions are required at
 * compile time.
 */
#ifndef UMACHINE_H_STUB
#define UMACHINE_H_STUB

#include <stdint.h>

/* ── Fundamental types ──────────────────────────────────────────────────── */
typedef char16_t UChar;
typedef int32_t  UChar32;
typedef int8_t   UBool;

#ifndef TRUE
#define TRUE 1
#endif
#ifndef FALSE
#define FALSE 0
#endif

/* ── Calling-convention / linkage macros ────────────────────────────────── */
/* On Windows these resolve to __cdecl / __declspec; everywhere else they  */
/* are empty.  WASM/Emscripten is "everywhere else".                       */

#ifndef U_EXPORT
#define U_EXPORT
#endif

#ifndef U_EXPORT2
#define U_EXPORT2
#endif

#ifdef __cplusplus
#  define U_CFUNC       extern "C"
#  define U_CDECL_BEGIN extern "C" {
#  define U_CDECL_END   }
#else
#  define U_CFUNC       extern
#  define U_CDECL_BEGIN
#  define U_CDECL_END
#endif

#ifndef U_CAPI
#define U_CAPI U_CFUNC U_EXPORT
#endif

#ifndef U_STABLE
#define U_STABLE U_CAPI
#endif

#ifndef U_DRAFT
#define U_DRAFT U_CAPI
#endif

#ifndef U_CALLCONV
#define U_CALLCONV U_EXPORT2
#endif

/* ── Block-macro helpers (used by utf8.h / utf16.h macros) ─────────────── */
#ifndef UPRV_BLOCK_MACRO_BEGIN
#define UPRV_BLOCK_MACRO_BEGIN do
#endif

#ifndef UPRV_BLOCK_MACRO_END
#define UPRV_BLOCK_MACRO_END while (0)
#endif

#endif /* UMACHINE_H_STUB */
