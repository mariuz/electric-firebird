/**
 * fb_wasm_intl_anchor.cpp – keeps the statically linked intl module reachable.
 *
 * `src/intl` is normally built as a shared object that the engine dlopen()s.
 * Compiled into the binary instead, nothing refers to its entry points, so the
 * linker discards every one of them — and with them the charset tables they
 * dispatch to. The first attempt to measure the size cost of including it
 * reported a delta of **zero bytes**, which was not a pleasant surprise about
 * how compact the tables are: it was the whole subsystem being stripped.
 *
 * Taking the addresses is enough to retain the entry points and everything
 * reachable from them.
 *
 * The declarations here are deliberately opaque. The real signatures need
 * Firebird's intl headers, and this file exists only to hold references —
 * C linkage resolves them by name, and nothing here ever calls them.
 */

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

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define FB_INTL_KEEP EMSCRIPTEN_KEEPALIVE
#else
#define FB_INTL_KEEP
#endif

/**
 * The addresses, reachable from an exported function.
 *
 * An unreferenced global is not a root for dead-code elimination, so an array
 * alone is discarded and takes the entry points with it — which is why the
 * second attempt at measuring this also reported zero. Reachability has to
 * start somewhere the linker will not touch.
 */
static void* const fb_wasm_intl_entry_points[] = {
	reinterpret_cast<void*>(&LD_lookup_charset),
	reinterpret_cast<void*>(&LD_lookup_texttype),
	reinterpret_cast<void*>(&LD_lookup_texttype_with_status),
	reinterpret_cast<void*>(&LD_setup_attributes),
	reinterpret_cast<void*>(&LD_version),
};

/** Exported, so the array above — and the whole subsystem — survives. */
extern "C" FB_INTL_KEEP const void* fb_intl_entry_point(int index)
{
	const int count =
		sizeof(fb_wasm_intl_entry_points) / sizeof(fb_wasm_intl_entry_points[0]);
	return (index >= 0 && index < count) ? fb_wasm_intl_entry_points[index] : nullptr;
}
