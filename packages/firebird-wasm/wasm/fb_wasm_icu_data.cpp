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
 * `icudt68l.dat` reduced with `icupkg` to the root collator and Unicode
 * collation weights (`coll/ucadata.icu`, `coll/root.res`, `coll/en*.res`,
 * `coll/res_index.res`): ~808 KB raw, ~270 KB gzipped. That is what Firebird's
 * UNICODE, UNICODE_CI and UNICODE_CI_AI need.
 *
 * Optional locale tailoring packs (`icudt68l-locales.dat`, built with
 * `tools/build-icu-data.sh --locales` for `LOCALE=de_DE`, `es_ES`, `fr_FR`,
 * `ja_JP`) can be lazy-loaded at runtime via `fb_wasm_register_icu_data()`
 * (`_fb_load_icu_data`) or placed at `/firebird/icu/icudt68l-locales.dat`
 * before `fb_init()`, registering a second `udata_setCommonData()` slot
 * without increasing the default WASM binary size.
 *
 * The version in the file name is not decoration: ICU only accepts data whose
 * major version matches the library, so this file and the port's TAG
 * (release-68-2) are checked together at compile time via static_assert.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <unicode/udata.h>
#include <unicode/utypes.h>
#include <unicode/uvernum.h>

static_assert(U_ICU_VERSION_MAJOR_NUM == 68,
	"Emscripten's ICU port major version changed; update icudt68l.dat in CMakeLists.txt and tools/build-icu-data.sh");

#ifndef FB_WASM_ICU_DATA_PATH
#define FB_WASM_ICU_DATA_PATH "/firebird/icu/icudt68l.dat"
#endif

#ifndef FB_WASM_ICU_LOCALE_DATA_PATH
#define FB_WASM_ICU_LOCALE_DATA_PATH "/firebird/icu/icudt68l-locales.dat"
#endif

namespace {

struct RegisteredIcuPack
{
	void*    buffer = nullptr;
	unsigned size   = 0;
};

/** Loaded once, and never freed: ICU keeps the pointers for the process. */
void* g_icuData = nullptr;
std::vector<RegisteredIcuPack> g_icuPacks;

bool registerIcuBuffer(const void* data, unsigned size, void** outBuffer = nullptr)
{
	if (!data || size == 0)
		return false;

	for (const auto& pack : g_icuPacks)
	{
		if (pack.size == size && memcmp(pack.buffer, data, size) == 0)
		{
			if (outBuffer)
				*outBuffer = pack.buffer;
			return true;
		}
	}

	// ICU requires the data to stay mapped and aligned. malloc gives suitable
	// alignment and the allocation outlives the process deliberately —
	// udata_setCommonData does not copy.
	void* buffer = malloc(static_cast<size_t>(size));
	if (!buffer)
		return false;

	memcpy(buffer, data, static_cast<size_t>(size));

	UErrorCode status = U_ZERO_ERROR;
	udata_setCommonData(buffer, &status);

	if (U_FAILURE(status))
	{
		fprintf(stderr, "[firebird-wasm] ICU rejected the collation data: %s\n",
			u_errorName(status));
		free(buffer);
		return false;
	}

	g_icuPacks.push_back(RegisteredIcuPack{buffer, size});
	if (outBuffer)
		*outBuffer = buffer;
	return true;
}

bool loadIcuFile(const char* path, bool warnIfMissing, void** outBuffer = nullptr)
{
	FILE* file = fopen(path, "rb");
	if (!file)
	{
#ifdef FB_WASM_ICU_COLLATION_DATA
		if (warnIfMissing)
		{
			fprintf(stderr, "[firebird-wasm] ICU collation data missing at %s; "
				"UNICODE collations will not work\n", path);
		}
#else
		(void) warnIfMissing;
#endif
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

	std::vector<unsigned char> temp(static_cast<size_t>(size));
	const size_t read = fread(temp.data(), 1, static_cast<size_t>(size), file);
	fclose(file);

	if (read != static_cast<size_t>(size))
		return false;

	return registerIcuBuffer(temp.data(), static_cast<unsigned>(size), outBuffer);
}

} // namespace

/**
 * Register an additional ICU `.dat` common data package (e.g., an optional
 * locale tailoring bundle for `LOCALE=de_DE`, `es_ES`, `fr_FR`, `ja_JP`) in
 * the next `udata_setCommonData()` slot.  Idempotent for identical buffers.
 */
extern "C" bool fb_wasm_register_icu_data(const void* data, unsigned size)
{
	return registerIcuBuffer(data, size);
}

/**
 * Hand the embedded (or VFS-mounted) ICU data package to ICU, plus any
 * optional locale tailoring bundle at `/firebird/icu/icudt68l-locales.dat`.
 * Safe to call more than once.
 *
 * @return true if ICU accepted the root package, or it was already loaded.
 */
extern "C" bool fb_wasm_load_icu_data()
{
	// If an optional locale tailoring pack was written to VFS before fb_init()
	// (or after), register its udata_setCommonData() slot as well.
	loadIcuFile(FB_WASM_ICU_LOCALE_DATA_PATH, false);

	if (g_icuData)
		return true;

	return loadIcuFile(FB_WASM_ICU_DATA_PATH, true, &g_icuData);
}

#else

extern "C" bool fb_wasm_register_icu_data(const void* /*data*/, unsigned /*size*/)
{
	return false;
}

extern "C" bool fb_wasm_load_icu_data()
{
	return false;
}

#endif // __EMSCRIPTEN__
