/**
 * fb_wasm_icu_data.cpp – give ICU the collation data it does not ship with.
 *
 * Emscripten's ICU port links `libicu_stubdata`: ICU's code without any of its
 * data. Everything that reads data therefore fails, and the failure surfaces a
 * long way from the cause — `ucol_open()` returns null, Firebird reports
 * `COLLATION UNICODE for CHARACTER SET UTF8 is not installed`, and nothing in
 * that message suggests ICU.
 *
 * Stub data exists precisely so an application can supply its own at runtime,
 * which is what this does. The package embedded alongside is ICU 68.2's own
 * `icudt68l.dat` reduced with `icupkg` to two items — `coll/root.res` and
 * `coll/ucadata.icu` — the root collator and the Unicode collation table.
 * That is what Firebird's UNICODE, UNICODE_CI and UNICODE_CI_AI need; the
 * other 168 locales in the full package are for `COLLATE ... 'LOCALE=de_DE'`
 * and cost 2.5 MB more.
 *
 * The version in the file name is not decoration: ICU only accepts data whose
 * major version matches the library, so this file and the port's TAG
 * (release-68-2) have to move together.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef FB_WASM_ICU_COLLATION_DATA

#include <unicode/udata.h>
#include <unicode/utypes.h>

namespace {

/** Loaded once, and never freed: ICU keeps the pointer for the process. */
void* g_icuData = nullptr;

} // namespace

/**
 * Hand the embedded package to ICU.  Safe to call more than once.
 *
 * @return true if ICU accepted it, or it was already loaded.
 */
extern "C" bool fb_wasm_load_icu_data()
{
	if (g_icuData)
		return true;

	FILE* file = fopen(FB_WASM_ICU_DATA_PATH, "rb");
	if (!file)
	{
		fprintf(stderr, "[firebird-wasm] ICU collation data missing at %s; "
			"UNICODE collations will not work\n", FB_WASM_ICU_DATA_PATH);
		return false;
	}

	fseek(file, 0, SEEK_END);
	const long size = ftell(file);
	fseek(file, 0, SEEK_SET);

	if (size <= 0)
	{
		fclose(file);
		return false;
	}

	// ICU requires the data to stay mapped and, on some platforms, aligned.
	// malloc gives suitable alignment and the allocation outlives the process
	// deliberately — udata_setCommonData does not copy.
	void* buffer = malloc(static_cast<size_t>(size));
	if (!buffer)
	{
		fclose(file);
		return false;
	}

	const size_t read = fread(buffer, 1, static_cast<size_t>(size), file);
	fclose(file);

	if (read != static_cast<size_t>(size))
	{
		free(buffer);
		return false;
	}

	UErrorCode status = U_ZERO_ERROR;
	udata_setCommonData(buffer, &status);

	if (U_FAILURE(status))
	{
		fprintf(stderr, "[firebird-wasm] ICU rejected the collation data: %s\n",
			u_errorName(status));
		free(buffer);
		return false;
	}

	g_icuData = buffer;

	return true;
}

#else

extern "C" bool fb_wasm_load_icu_data()
{
	return false;   // built without collation data
}

#endif // FB_WASM_ICU_COLLATION_DATA
