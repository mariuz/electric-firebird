/**
 * fb_wasm_mod_loader.cpp – ModuleLoader for a build with nothing to load.
 *
 * Replaces `common/os/posix/mod_loader.cpp`, which is `dlopen` and friends.
 * This build links everything statically, so there are no shared objects for
 * `dlopen` to find and it fails for every caller — plugins, UDFs, and the
 * international text module alike.
 *
 * For plugins and UDFs that is correct and unchanged: they genuinely are not
 * there. The engine plugin registers itself through `FB_PLUGIN_ENTRY_POINT`
 * instead, and UDF libraries are not something a browser database loads.
 *
 * The intl module is different. `src/intl` **is** in the binary when the build
 * is configured with `FB_WASM_FULL_INTL`; the only thing missing was a way for
 * `IntlManager` to reach it, because it looks its entry points up by name
 * through this interface. So this hands back a module whose `findSymbol` knows
 * those five names.
 *
 * Doing it here rather than by patching `IntlManager` keeps the change out of
 * Firebird's own source: the engine goes on believing it loaded a module, and
 * nothing in `jrd/` has to know that WebAssembly is different.
 */

#include "firebird.h"
#include "../common/os/mod_loader.h"
#include "../common/StatusHolder.h"
#include "../common/classes/fb_string.h"
#include "../common/classes/init.h"

#ifdef FB_WASM_STATIC_INTL

// The statically linked intl module's entry points.  Declared rather than
// included: ld_proto.h needs the intl headers, and nothing here calls them.
extern "C" {
int  LD_lookup_charset(void*, const char*, const char*);
int  LD_lookup_texttype(void*, const char*, const char*, unsigned short,
                        const unsigned char*, unsigned long, int, const char*);
int  LD_lookup_texttype_with_status(char*, unsigned long, void*, const char*,
                                    const char*, unsigned short,
                                    const unsigned char*, unsigned long, int,
                                    const char*);
unsigned long LD_setup_attributes(const char*, const char*, const char*,
                                  const unsigned char*, unsigned long,
                                  unsigned char*);
void LD_version(unsigned short*);
}

namespace {

/** One symbol of the statically linked intl module. */
struct StaticSymbol
{
	const char* name;
	void*       address;
};

const StaticSymbol INTL_SYMBOLS[] = {
	{"LD_lookup_charset",             reinterpret_cast<void*>(&LD_lookup_charset)},
	{"LD_lookup_texttype",            reinterpret_cast<void*>(&LD_lookup_texttype)},
	{"LD_lookup_texttype_with_status", reinterpret_cast<void*>(&LD_lookup_texttype_with_status)},
	{"LD_setup_attributes",           reinterpret_cast<void*>(&LD_setup_attributes)},
	{"LD_version",                    reinterpret_cast<void*>(&LD_version)},
};

/**
 * A module that was never loaded, because it was never separate.
 *
 * Deliberately not destructor-unloading anything: there is nothing to unload,
 * and the addresses stay valid for the life of the program.
 */
class StaticIntlModule final : public ModuleLoader::Module
{
public:
	StaticIntlModule(MemoryPool& pool, const Firebird::PathName& path)
		: ModuleLoader::Module(pool, path)
	{
	}

	void* findSymbol(ISC_STATUS*, const Firebird::string& symbol) override
	{
		for (const StaticSymbol& entry : INTL_SYMBOLS)
		{
			if (symbol == entry.name)
				return entry.address;
		}
		return nullptr;
	}

	bool getRealPath(const Firebird::string&, Firebird::PathName&) override
	{
		// There is no file on disk to name.  Callers use this for diagnostics
		// and treat false as "cannot tell", which is exactly the situation.
		return false;
	}
};

/** Whether `path` names the intl module, however the config spelled it. */
bool isIntlModule(const Firebird::PathName& path)
{
	// fbintl.conf writes `filename = $(this)/fbintl`, which arrives here with
	// the directory prefixed and possibly an extension appended by
	// doctorModuleExtension().  Matching the stem keeps this indifferent to
	// both.
	const char* const name = path.c_str();
	const char* const slash = strrchr(name, '/');
	const char* const stem = slash ? slash + 1 : name;

	return strncmp(stem, "fbintl", 6) == 0;
}

} // namespace

#endif // FB_WASM_STATIC_INTL

bool ModuleLoader::isLoadableModule(const Firebird::PathName& module)
{
#ifdef FB_WASM_STATIC_INTL
	return isIntlModule(module);
#else
	(void) module;
	return false;
#endif
}

/**
 * Try the platform's library extensions.
 *
 * Nothing is loaded from a file here, so there is no extension worth trying:
 * report "no more candidates" immediately rather than sending the caller
 * around a loop that cannot succeed.
 */
bool ModuleLoader::doctorModuleExtension(Firebird::PathName&, int& step)
{
	step = 0;
	return false;
}

ModuleLoader::Module* ModuleLoader::loadModule(ISC_STATUS* status,
	const Firebird::PathName& modPath)
{
#ifdef FB_WASM_STATIC_INTL
	if (isIntlModule(modPath))
		return FB_NEW StaticIntlModule(*getDefaultMemoryPool(), modPath);
#endif

	// Everything else really is absent.  Report it the way a failed dlopen
	// would, so callers log something meaningful rather than a null with no
	// explanation.
	if (status)
	{
		Firebird::Arg::Gds err(isc_random);
		err << Firebird::Arg::Str("This build links its modules statically; "
			"there is nothing to load at runtime");
		err.copyTo(status);
	}

	return nullptr;
}
