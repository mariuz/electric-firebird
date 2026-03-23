/*
 * Minimal ICU ucal.h stub for Emscripten/WASM cross-compilation.
 *
 * Provides calendar-related type definitions used by Firebird's
 * unicode_util.h and TimeZoneUtil.cpp.
 */

#ifndef UCAL_H
#define UCAL_H

#include "unicode/utypes.h"

typedef void *UCalendar;
typedef double UDate;

typedef enum UCalendarType {
    UCAL_TRADITIONAL,
    UCAL_DEFAULT = UCAL_TRADITIONAL,
    UCAL_GREGORIAN
} UCalendarType;

typedef enum UCalendarDateFields {
    UCAL_ERA,
    UCAL_YEAR,
    UCAL_MONTH,
    UCAL_WEEK_OF_YEAR,
    UCAL_WEEK_OF_MONTH,
    UCAL_DATE,
    UCAL_DAY_OF_YEAR,
    UCAL_DAY_OF_WEEK,
    UCAL_DAY_OF_WEEK_IN_MONTH,
    UCAL_AM_PM,
    UCAL_HOUR,
    UCAL_HOUR_OF_DAY,
    UCAL_MINUTE,
    UCAL_SECOND,
    UCAL_MILLISECOND,
    UCAL_ZONE_OFFSET,
    UCAL_DST_OFFSET,
    UCAL_FIELD_COUNT
} UCalendarDateFields;

typedef enum UCalendarAttribute {
    UCAL_LENIENT,
    UCAL_FIRST_DAY_OF_WEEK,
    UCAL_MINIMAL_DAYS_IN_FIRST_WEEK,
    UCAL_REPEATED_WALL_TIME,
    UCAL_SKIPPED_WALL_TIME
} UCalendarAttribute;

typedef enum UTimeZoneTransitionType {
    UCAL_TZ_TRANSITION_NEXT,
    UCAL_TZ_TRANSITION_NEXT_INCLUSIVE,
    UCAL_TZ_TRANSITION_PREVIOUS,
    UCAL_TZ_TRANSITION_PREVIOUS_INCLUSIVE
} UTimeZoneTransitionType;

#endif /* UCAL_H */
