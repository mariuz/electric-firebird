/*
 * Minimal ICU stub – umachine.h
 *
 * Provides the fundamental ICU type aliases needed to compile Firebird
 * sources for WASM.  Firebird loads ICU dynamically at runtime, so only
 * the type definitions are required at compile time.
 */
#ifndef UMACHINE_H_STUB
#define UMACHINE_H_STUB

#include <stdint.h>

typedef char16_t UChar;
typedef int32_t  UChar32;
typedef int8_t   UBool;

#ifndef TRUE
#define TRUE 1
#endif
#ifndef FALSE
#define FALSE 0
#endif

#endif /* UMACHINE_H_STUB */
