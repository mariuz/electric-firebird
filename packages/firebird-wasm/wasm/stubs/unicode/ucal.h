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

typedef enum {
    UCAL_LENIENT,
    UCAL_STRICT
} UCalendarAttribute;

typedef enum {
    UCAL_TRADITIONAL,
    UCAL_DEFAULT = UCAL_TRADITIONAL,
    UCAL_GREGORIAN
} UCalendarType;

typedef enum {
    UCAL_TZ_TRANSITION_NEXT,
    UCAL_TZ_TRANSITION_NEXT_INCLUSIVE,
    UCAL_TZ_TRANSITION_PREVIOUS,
    UCAL_TZ_TRANSITION_PREVIOUS_INCLUSIVE
} UTimeZoneTransitionType;

#endif /* UCAL_H_STUB */
