/*
 * Minimal ICU stub – ucal.h  (calendar / timezone)
 */
#ifndef UCAL_H_STUB
#define UCAL_H_STUB

#include "unicode/utypes.h"

typedef void* UCalendar;
typedef double UDate;

typedef enum {
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

/* Wall-time handling attributes used by ucal_setAttribute() */
typedef enum {
    UCAL_LENIENT,
    UCAL_FIRST_DAY_OF_WEEK,
    UCAL_MINIMAL_DAYS_IN_FIRST_WEEK,
    UCAL_REPEATED_WALL_TIME,
    UCAL_SKIPPED_WALL_TIME
} UCalendarAttribute;

/* Wall-time option values */
typedef enum {
    UCAL_WALLTIME_LAST,
    UCAL_WALLTIME_FIRST,
    UCAL_WALLTIME_NEXT_VALID
} UCalendarWallTimeOption;

typedef enum {
    UCAL_TRADITIONAL,
    UCAL_DEFAULT = UCAL_TRADITIONAL,
    UCAL_GREGORIAN
} UCalendarType;

/* Milliseconds-per-minute constant used by TimeZoneUtil.cpp */
#define U_MILLIS_PER_MINUTE 60000

typedef enum {
    UCAL_TZ_TRANSITION_NEXT,
    UCAL_TZ_TRANSITION_NEXT_INCLUSIVE,
    UCAL_TZ_TRANSITION_PREVIOUS,
    UCAL_TZ_TRANSITION_PREVIOUS_INCLUSIVE
} UTimeZoneTransitionType;

#endif /* UCAL_H_STUB */
