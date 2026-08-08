/*
 * fb_pool_probe.cpp – isolate Firebird's MemoryPool from the engine.
 *
 * Diagnostic for the create-database trap: getXpbBuilder() was observed
 * allocating a block that overlapped a live JProvider, with the new block's
 * header landing 12 bytes back inside it.  AddressSanitizer cannot see this
 * because FB_NEW allocates from MemoryPool, whose sub-allocation is invisible
 * to it.
 *
 * This takes the engine out of the picture: allocate a series of blocks from
 * the default pool, keep them all live, and check whether any two overlap or
 * whether any is returned unaligned.  ALLOC_ALIGNMENT is 16.
 *
 * Built only when -DFB_WASM_POOL_PROBE=ON; exported as _fb_pool_probe.
 */

#include "firebird.h"
#include "../common/classes/alloc.h"

#include <cstdio>
#include <cstring>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define FB_WASM_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define FB_WASM_EXPORT
#endif

namespace {

struct Block
{
	char*  ptr;
	size_t size;
};

// Sizes around the ones the engine actually used: JProvider is ~28-40 bytes
// and the XPB builder lands just after it.
const size_t PROBE_SIZES[] = {
	28, 32, 36, 40, 24, 48, 16, 64, 12, 20, 80, 8, 128, 44, 56, 96
};

constexpr size_t PROBE_COUNT = sizeof(PROBE_SIZES) / sizeof(PROBE_SIZES[0]);

} // anonymous namespace

extern "C" {

/**
 * Returns the number of problems found: overlapping blocks plus misaligned
 * returns.  0 means the pool behaved.
 */
FB_WASM_EXPORT
int fb_pool_probe(void)
{
	using namespace Firebird;

	MemoryPool& pool = *getDefaultMemoryPool();

	Block blocks[PROBE_COUNT];
	int problems = 0;

	for (size_t i = 0; i < PROBE_COUNT; i++)
	{
		const size_t n = PROBE_SIZES[i];
		char* const p = static_cast<char*>(pool.allocate(n));

		blocks[i].ptr = p;
		blocks[i].size = n;

		// Fill with a per-block byte so later corruption is visible.
		memset(p, static_cast<int>(0xA0 + i), n);

		const unsigned misalign =
			static_cast<unsigned>(reinterpret_cast<uintptr_t>(p) % ALLOC_ALIGNMENT);

		printf("  [%2u] size=%3u ptr=%p align%%%d=%u%s\n",
			static_cast<unsigned>(i), static_cast<unsigned>(n), (void*)p,
			(int)ALLOC_ALIGNMENT, misalign, misalign ? "  <-- MISALIGNED" : "");

		if (misalign)
			problems++;

		// Does this block overlap any earlier one that is still live?
		for (size_t j = 0; j < i; j++)
		{
			char* const aLo = blocks[j].ptr;
			char* const aHi = aLo + blocks[j].size;
			char* const bLo = p;
			char* const bHi = p + n;

			if (bLo < aHi && aLo < bHi)
			{
				printf("  *** OVERLAP: block %u [%p,%p) and block %u [%p,%p)\n",
					static_cast<unsigned>(j), (void*)aLo, (void*)aHi,
					static_cast<unsigned>(i), (void*)bLo, (void*)bHi);
				problems++;
			}
		}
	}

	// Every block should still hold its own fill byte.
	for (size_t i = 0; i < PROBE_COUNT; i++)
	{
		const unsigned char expected = static_cast<unsigned char>(0xA0 + i);
		for (size_t k = 0; k < blocks[i].size; k++)
		{
			if (static_cast<unsigned char>(blocks[i].ptr[k]) != expected)
			{
				printf("  *** CLOBBERED: block %u byte %u is %02x, expected %02x\n",
					static_cast<unsigned>(i), static_cast<unsigned>(k),
					static_cast<unsigned char>(blocks[i].ptr[k]), expected);
				problems++;
				break;
			}
		}
	}

	printf("fb_pool_probe: %d problem(s)\n", problems);
	return problems;
}

} /* extern "C" */
