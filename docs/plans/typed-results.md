# Plan: finishing the typed result encoding

The roadmap's M2 entry says *"Replace the JSON ABI with a typed encoding"*.
This plan argues for **not doing that**, and for doing three smaller things
instead that deliver what the entry was actually after.

Written against measurements rather than intuition, because the intuition was
wrong.

---

## What the measurement says

10,000 rows × 5 columns (`INTEGER`, `VARCHAR(40)`, `NUMERIC(18,4)`, `BIGINT`,
`TIMESTAMP`), through the current path:

| Stage | Time |
|---|---|
| Engine executes the query | 73 ms |
| `UTF8ToString` (heap → JS string) | 5 ms |
| `JSON.parse` | 8 ms |
| **Building row objects** | **33 ms** |
| Decode total | 45 ms — 38% of end-to-end |

JSON is 0.72 MB for that result set.

**`JSON.parse` is 8 ms of a 45 ms decode.** Replacing the wire format attacks
the 13 ms of reading and parsing and leaves the 33 ms untouched, because a
binary encoding still has to build the same JavaScript objects at the end.

And that 33 ms is the cheapest thing on the list to fix:

| Row construction | Time (10k × 5) |
|---|---|
| `Object.fromEntries` (current) | 12 ms |
| Generated constructor | 1 ms |
| Columnar, no per-row objects | 1 ms |
| Lazy `Proxy` rows | 2 ms |

A generated constructor is **12×** faster than what we do now and changes no
ABI at all.

> The conclusion is uncomfortable for the roadmap entry: the wire format was
> never the expensive part. It was assumed to be.

---

## What is actually worth doing

Three separable pieces, in the order their value/cost ratio justifies.

### 1. Fast row construction — no ABI change

Replace `Object.fromEntries(fields.map(...))` per row in `decodeResultSet` with
a constructor generated once per result set from the column names.

- **Cost:** ~10 lines in `engine-transport.ts`.
- **Win:** the largest single decode cost, cut by ~12×.
- **Risk:** near zero. Same output shape, same values. Column names come from
  the engine, so a generated function has to escape them properly — use a
  lookup over an array rather than interpolating names into source, so a column
  called `constructor` or `__proto__` cannot do anything surprising.
- **Test:** existing suites cover the output; add one with awkward column names.

Do this first regardless of what happens to the rest.

> **Done** — see the commit that added `rowBuilder` to `engine-transport.ts`.
> Two things the plan got wrong, both found by measuring the implementation
> rather than the sketch:
>
> - **Computed keys are not an option.** The plan suggested them as the safe
>   way to interpolate names. They force dictionary-mode objects and measured
>   14.7 ms against `Object.fromEntries`'s 15.2 ms — no win at all. Literal
>   keys with a `__proto__` guard is the only shape that pays.
> - **Caching is required, not an optimisation.** Building a constructor per
>   result set turns 2.5 ms into 5.5 ms across 2000 one-row queries. Cached, it
>   is 1.1 ms. Without the cache the change would have been a regression for
>   small queries, which are most of them.
>
> Measured after: 12.2 → 2.2 ms on 10,000 rows, 12.2 → 0.7 ms on 100-row pages
> repeated 200 times.

### 2. Typed values — opt-in, decode-side

The values callers actually want, without a new wire format. Each is a decision
about a type contract, not a serialisation problem:

| Firebird | Today | Proposed | Note |
|---|---|---|---|
| `BIGINT` | `number`, or `string` past 2⁵³ | `bigint` | **Always** `bigint`, never "number if small". A type that changes with the value is worse than either type. |
| `NUMERIC` / `DECIMAL` | exact decimal `string` | `string` (unchanged), or `{ unscaled: bigint, scale: number }` | JavaScript has no decimal. A string is lossless and useless for arithmetic; the pair is lossless and computable but bespoke. Offer the pair, keep the string default. |
| `DECFLOAT`, `INT128` | `string` | `string` | Same reasoning; no better target exists. |
| `TIMESTAMP` | ISO-8601 `string` | `Date` **opt-in** | Firebird keeps 100 µs; `Date` keeps 1 ms. Converting **loses precision**, so it cannot be the default without silently truncating data. |
| `TIMESTAMP WITH TIME ZONE` | ISO-8601 `string` | `string` | `Date` has no zone. Converting would discard it. |
| `BLOB SUB_TYPE BINARY` | base64 `string` | `Uint8Array` | The one unambiguous win — see §3. |

Shape: `new FirebirdBrowser(name, { types: { bigint: true, dates: true } })`,
defaulting to today's behaviour. Changing what `rows` contains is breaking, and
a database library that changes value types under a patch release is not one
anybody should trust.

- **Cost:** decode-side only; `FieldInfo` already carries `type`, `subType` and
  `scale`, which is everything the mapping needs.
- **Win:** ergonomics. No correctness change — the current path is lossless,
  just awkward.

> **Done.** Three things the table above had wrong, found by looking at what
> the engine actually emits:
>
> - **`TIME` cannot be a `Date` at all.** `new Date('11:22:33.4567')` is
>   `Invalid Date`. The plan listed only the time-zone types as unconvertible.
> - **`TIMESTAMP WITH TIME ZONE` arrives as `...4567 Europe/Bucharest`** — a
>   named zone, which `Date` cannot parse either, so it is `Invalid Date` rather
>   than merely lossy.
> - **`DATE` and `TIMESTAMP` disagree about zones under JavaScript's own
>   parsing.** A bare date is UTC; a bare date-time is local. Two types that
>   should behave alike would not have. The implementation appends `Z` and
>   documents UTC, so a stored value gives the same `Date` on every machine.
>
> Conversion happens in `FirebirdBrowser`, not in the transport, so it works
> the same through `DirectTransport`, `WorkerTransport` and
> `SharedEngineTransport` — `bigint`, `Date` and `Uint8Array` all survive
> structured cloning, which was the thing that made this placement possible.

### 3. Binary BLOBs — the only place framing genuinely pays

Base64 costs 33% inflation on the wire and a decode pass, on data that is
already bytes. This is where a binary path earns its complexity, and it can be
added *beside* JSON rather than replacing it:

- The engine emits binary BLOB values out-of-band: JSON carries a placeholder
  (`{"$blob": <index>}`), and a side buffer holds the bytes with an offset
  table.
- `fb_query` returns both pointers; the JS side wraps the side buffer in
  `Uint8Array` views with **no copy**.
- With `WorkerTransport`, the side buffer is *transferred* rather than cloned —
  which structured cloning of a base64 string can never be.

- **Cost:** the largest of the three. New C-side buffer management and a
  second pointer through the ABI.
- **Win:** proportional to how binary the workload is. Zero for the benchmark
  above; large for one storing images.
- **Do this only when there is a workload asking for it.** Nothing in the
  demo, the tests, or any reported use touches binary BLOBs today.

---

## What not to do

**Do not replace the JSON wire format wholesale.** It buys ~13 ms of a 45 ms
decode on a large result set, in exchange for a hand-written binary encoder in
C, a decoder in TypeScript, and a versioning problem between them. Every value
mapping people actually want (§2) is achievable without touching it.

**Do not make row values change type by magnitude.** The current
`BIGINT`→`number`-or-`string` rule already has this flaw. `typeof row.ID`
depending on how big the id happens to be is a bug generator.

**Do not convert `TIMESTAMP` to `Date` by default.** It truncates 100 µs to
1 ms. Losing precision silently to make a nicer type is the wrong trade for a
database.

---

## Sequence

1. **Fast row construction.** Independent, safe, largest measured win. Ship in
   a patch release.
2. **Benchmark in CI**, so the numbers above stop being a one-off. A regression
   test on decode time for a fixed result set.

   > **Done** — `packages/firebird-wasm/bench/decode-bench.js`, run by CI after
   > the build and uploaded as an artifact. Three things this needed that "a
   > regression test on decode time" does not suggest:
   >
   > - **Decode time cannot be asserted on.** A shared runner is several times
   >   slower than a developer machine and varies between runs, so any wall-clock
   >   limit is either too loose to catch a regression or too tight to survive a
   >   noisy neighbour. Every check is a ratio between two measurements taken in
   >   the same process — the current decoder against a copy of the
   >   `Object.fromEntries` construction it replaced. Absolute times are recorded
   >   for reading a trend and never gate the build.
   > - **One measurement cannot see both failure modes.** Losing the generated
   >   constructor collapses the large and paged scenarios to ~1.0×. Losing the
   >   *cache* does not touch them — one compile amortised over a result set
   >   costs nothing, and both still measured 2.2–2.4× with the cache disabled.
   >   That failure is caught by a separate scenario timing one column signature
   >   against 200 of them: 2.0–2.3× when builders are reused, ~1.2× when they
   >   are not. Both modes were verified by breaking the built code and watching
   >   the right guard fire, and the floors hold on Node 20 through 25 — the
   >   spread between versions is wider than the spread between runs, and CI's
   >   Node 20 is the most favourable of them.
   > - **At one row the win is invisible end-to-end.** `JSON.parse` of the column
   >   metadata is about three quarters of a single-row decode, so the whole
   >   decode measures 0.99–1.23× against the old construction — the 12× is real
   >   but lands on a quarter of the time. That scenario is reported, not
   >   asserted: no floor fits between it and noise. It earns its place by
   >   dropping to 0.69× when the cache breaks, which is the regression for small
   >   queries §1 warns about, made visible.
3. **Typed values behind `types:`**, defaulting off. Ship in a minor.
4. **Flip the defaults** in the next major, once the options have been exercised.

   > The benchmark now reports what this would cost, which the plan never
   > estimated: converting two of five columns — `BIGINT` to `bigint`,
   > `TIMESTAMP` to `Date` — adds **175–190% on top of a 10,000-row decode**,
   > steady across Node 20 through 25.
   > Conversion is more expensive than the entire decode it follows, because
   > `BigInt()` and `new Date()` per cell are both dearer than reading a value
   > out of parsed JSON. That does not settle the question — ergonomics may well
   > be worth tripling a 3 ms decode — but "flip the defaults" is no longer a
   > free change, and whoever makes it should quote the number.
5. **Binary BLOBs** only when a workload needs them.

## Open questions

- Is `{ unscaled: bigint, scale: number }` the right shape for exact decimals,
  or should this wait for a decimal proposal to land in JS? Worth checking what
  PGlite settled on for `numeric` before inventing one.
- Should columnar output be offered (`rows` as arrays plus a name index)? It was
  as fast as the generated constructor and avoids per-row objects entirely, but
  it is a second result shape to document and support.
- The engine query itself is 73 ms of the 118 ms end-to-end. Nothing here
  touches that, and it may be the better target.
