/*
 * fb_wasm_api.cpp – extern "C" bridge between JavaScript and the Firebird
 *                   embedded engine compiled to WebAssembly.
 *
 * The whole file is written against Firebird's **public OO API**
 * (`firebird/Interface.h`: IMaster, IProvider, IAttachment, ITransaction,
 * IStatement, IResultSet, IMessageMetadata, …).  That is a deliberate
 * constraint: it is the interface Firebird supports for embedding, so this
 * bridge needs **no modifications to the Firebird source tree**.  The only
 * WASM-specific concession is how the engine is located — see fb_init().
 *
 * ── Handles ────────────────────────────────────────────────────────────────
 * JavaScript cannot hold C++ pointers safely across an Emscripten heap that
 * may be reallocated by ALLOW_MEMORY_GROWTH, so every object is kept in a
 * table on this side and identified by a small opaque integer.  0 is always
 * "no handle" / failure, mirroring the convention the TypeScript layer
 * already expects.
 *
 * ── Errors ─────────────────────────────────────────────────────────────────
 * Every entry point reports failure through its return value *and* records a
 * human-readable message retrievable with fb_last_error().  Returning only an
 * integer status — as the previous stub did — throws away everything Firebird
 * knows about the failure.
 *
 * ── Result encoding ────────────────────────────────────────────────────────
 * fb_query() serialises a result set to JSON:
 *
 *     {"columns":["ID","NAME"],"rows":[[1,"alpha"],[2,null]]}
 *
 * JSON cannot represent every Firebird type exactly, so the mapping below is
 * chosen to be lossless-or-explicit rather than silently approximate:
 *
 *     CHAR/VARCHAR/text BLOB      → string
 *     binary BLOB                 → base64 string
 *     SMALLINT/INTEGER            → number
 *     BIGINT/INT128               → number when exactly representable as an
 *                                   IEEE-754 double, otherwise string
 *     NUMERIC/DECIMAL (scale ≠ 0) → string (exact decimal text)
 *     FLOAT/DOUBLE PRECISION      → number (non-finite → null)
 *     DECFLOAT                    → string
 *     BOOLEAN                     → true / false
 *     DATE/TIME/TIMESTAMP (± TZ)  → ISO-8601 string
 *     anything else               → null
 *
 * Replacing JSON with a typed binary encoding is tracked in docs/roadmap.md
 * (M2); until then the rules above are the contract.
 */

#include <firebird/Interface.h>

#include <algorithm>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <condition_variable>
#include <cstring>
#include <chrono>
#include <list>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <vector>

#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#define FB_WASM_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define FB_WASM_EXPORT
#endif

using namespace Firebird;

/**
 * The engine's plugin entry point, defined by `src/jrd/jrd.cpp`, which this
 * build links in statically.  Normally the plugin loader resolves it after
 * dlopen()ing a shared library; a WASM binary has no dynamic loading, so
 * fb_init() calls it directly.  Declared here rather than pulling in Firebird's
 * internal headers, which are not consumable from outside the engine build.
 */
extern "C" void FB_PLUGIN_ENTRY_POINT(Firebird::IMaster* master);

namespace {

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

IMaster*   g_master   = nullptr;
IProvider* g_provider = nullptr;
IUtil*     g_util     = nullptr;

/**
 * The plugin set that produced g_provider, retained for the lifetime of the
 * module.  See locateProvider() for why it must outlive the provider.
 */
IPluginSet* g_pluginSet = nullptr;

/**
 * What a statement's results look like: where each column sits in the output
 * message, and the JSON describing the columns.  A prepared statement's
 * columns cannot change, so a kept statement works this out once
 * (CachedStatement::shape) rather than on every call: describing them was
 * most of what a small query cost (bench/call-cost.js, "no row, 10 columns").
 */
struct OutputShape;

/**
 * Kept statements' shapes by id, for fb_shape_columns.  An id is given once
 * and never reused, so a caller that remembers what an id meant is never
 * wrong about it: a statement whose columns change (after DDL) is prepared
 * again and gets a new shape and a new id.
 */
std::map<unsigned, OutputShape*> g_shapes;
unsigned g_nextShapeId = 1;

struct OutputShape
{
	IMessageMetadata* metadata = nullptr;   // owned
	unsigned id = 0;                        // nonzero once kept with a statement
	unsigned columnCount = 0;
	unsigned messageLength = 0;
	bool hasCursor = true;                  // EXECUTE PROCEDURE has columns but no cursor
	std::vector<unsigned> types, lengths, charSets, offsets, nullOffsets;
	std::vector<int> subTypes, scales;
	std::string header;                     // {"columns":[...],"rows":[
	std::string idHeader;                   // {"shape":N,"rows":[  (kept shapes only)

	OutputShape() = default;
	OutputShape(const OutputShape&) = delete;
	OutputShape& operator=(const OutputShape&) = delete;

	~OutputShape()
	{
		if (id)
			g_shapes.erase(id);
		if (metadata)
			metadata->release();
	}
};

/** A statement kept prepared for its SQL text (see acquireStatement). */
struct CachedStatement
{
	std::string sql;
	IStatement* statement = nullptr;
	unsigned type = 0;
	std::shared_ptr<OutputShape> shape;     // filled by the first query that runs it
};

/** An attached database, and the statements kept prepared for it, most recently used first. */
struct DbEntry
{
	IAttachment* attachment = nullptr;
	std::list<CachedStatement> statements;
	bool sharedReads = false;                  // autocommit SELECTs share readTransaction (fb_read_transaction)
	ITransaction* readTransaction = nullptr;
	std::set<std::string> writers;             // SELECTs that wrote: they get their own transaction
};

/** How many prepared statements each database keeps; 0 turns the cache off (fb_statement_cache). */
unsigned g_statementCacheSize = 64;

/** A started transaction and the database it was started on. */
struct TxEntry
{
	ITransaction* transaction = nullptr;
	int db_handle = 0;
};

std::map<int, DbEntry> g_databases;
std::map<int, TxEntry> g_transactions;

int g_nextDbHandle = 1;
int g_nextTxHandle = 1;

std::string g_lastError;
/** The last error said "attempted update during read-only transaction". */
bool g_lastErrorReadOnly = false;

/**
 * Isolation levels, mirroring the TypeScript `IsolationLevel` union.
 *
 * Integers rather than strings because they cross the WASM boundary, where a
 * string means an allocation and a parse on every transaction.
 */
enum FbIsolation
{
	FB_ISOLATION_DEFAULT                  = 0,
	FB_ISOLATION_READ_COMMITTED           = 1,
	FB_ISOLATION_SNAPSHOT                 = 2,
	FB_ISOLATION_SNAPSHOT_TABLE_STABILITY = 3
};

/**
 * Rows affected by the most recent execute.
 *
 * Reported out of band like the error text, because the C entry points return
 * a status code and there is nowhere else to put it.  Read it immediately: the
 * next execute overwrites it.
 */
ISC_INT64 g_lastAffectedRows = 0;

/**
 * Binary BLOB bytes collected during one query, for the side channel.
 *
 * Base64 inside the JSON costs 33% inflation on the wire and a decode pass in
 * JavaScript, on data that is already bytes.  With the side channel the JSON
 * carries `{"$blob":N}` and the bytes travel beside it, so the only copy left
 * is the one out of the WASM heap.
 *
 * Off unless the caller asks — `fb_query`'s flags — because the base64 form is
 * what every existing caller decodes today.
 */
/** `flags` bit for fb_query/fb_query_params: binary BLOBs out of band. */
#define FB_QUERY_BINARY_BLOBS 1

/**
 * `flags` bit for fb_query/fb_query_params: the caller understands
 * `{"shape":N,"rows":[...]}` for a kept statement, in place of the columns,
 * and asks fb_shape_columns(N) for an id it does not know yet.
 */
#define FB_QUERY_SHAPE_IDS 2

struct BlobSink
{
	bool enabled = false;
	/** Every blob's bytes, concatenated in the order they were read. */
	std::vector<unsigned char> data;
	/** Byte length of each blob, in the same order.  Offsets are the running sum. */
	std::vector<unsigned> lengths;
};

/** Set by `fb_query` when the side channel is on; owned here, freed on the next query. */
unsigned char* g_lastBlobBuffer = nullptr;
unsigned       g_lastBlobSize   = 0;

/**
 * Publish a sink as the side buffer for the query just finished.
 *
 * Layout, all little-endian, which is what WebAssembly is:
 *
 *     u32  count
 *     u32  length × count
 *     ...  bytes, concatenated in order
 *
 * Lengths rather than offsets: the offsets are the running sum, so storing
 * both would be storing the same information twice and inviting them to
 * disagree.
 *
 * The engine owns this until the next query replaces it, like the error text.
 * That is what lets the JavaScript side read it without a free() of its own —
 * and why it has to read it immediately.
 */
void publishBlobs(const BlobSink& sink)
{
	free(g_lastBlobBuffer);
	g_lastBlobBuffer = nullptr;
	g_lastBlobSize = 0;

	if (sink.lengths.empty())
		return;

	const unsigned count  = static_cast<unsigned>(sink.lengths.size());
	const unsigned header = static_cast<unsigned>(sizeof(unsigned) * (1 + count));
	const unsigned total  = header + static_cast<unsigned>(sink.data.size());

	auto* buffer = static_cast<unsigned char*>(malloc(total));
	if (!buffer)
		return;

	memcpy(buffer, &count, sizeof(count));
	memcpy(buffer + sizeof(unsigned), sink.lengths.data(), sizeof(unsigned) * count);
	memcpy(buffer + header, sink.data.data(), sink.data.size());

	g_lastBlobBuffer = buffer;
	g_lastBlobSize = total;
}

/** Buffer returned by fb_query(); freed by fb_free_result(). */
char* allocCString(const std::string& s)
{
	char* out = static_cast<char*>(malloc(s.size() + 1));
	if (!out)
		return nullptr;
	memcpy(out, s.c_str(), s.size() + 1);
	return out;
}

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

void setError(const std::string& message)
{
	g_lastError = message;
}

void clearError()
{
	g_lastError.clear();
	g_lastErrorReadOnly = false;
}

/** Whether a status vector carries the error `code` anywhere in its chain. */
bool statusHasError(IStatus* status, ISC_STATUS code)
{
	const ISC_STATUS* v = status ? status->getErrors() : nullptr;
	while (v && *v != isc_arg_end)
	{
		if (v[0] == isc_arg_gds && v[1] == code)
			return true;
		v += v[0] == isc_arg_cstring ? 3 : 2;
	}
	return false;
}

/** Turn an IStatus carrying errors into readable text. */
void setErrorFromStatus(const char* context, IStatus* status)
{
	char buffer[2048];
	buffer[0] = '\0';
	g_lastErrorReadOnly = statusHasError(status, isc_read_only_trans);

	if (g_util && status)
		g_util->formatStatus(buffer, sizeof(buffer), status);

	std::string message(context);
	if (buffer[0])
	{
		message += ": ";
		message += buffer;
	}
	setError(message);
}

/**
 * An owned IStatus plus a non-throwing wrapper around it.
 *
 * `CheckStatusWrapper` is used rather than `ThrowStatusWrapper` because this
 * is a C ABI: a C++ exception escaping into the JS caller would abort the
 * whole WASM module.  Every call site therefore has to check `failed()`
 * explicitly.
 *
 * The status vector is disposed in the destructor, so early returns on error
 * paths cannot leak it.
 */
class Status
{
public:
	Status()
		: raw(g_master ? g_master->getStatus() : nullptr),
		  wrapper(raw)
	{
	}

	~Status()
	{
		if (raw)
			raw->dispose();
	}

	Status(const Status&) = delete;
	Status& operator=(const Status&) = delete;

	/** Pointer to pass to any OO API call taking a status. */
	CheckStatusWrapper* ptr() noexcept { return &wrapper; }

	bool failed() const noexcept
	{
		return (wrapper.getState() & IStatus::STATE_ERRORS) != 0;
	}

private:
	IStatus* raw;
	CheckStatusWrapper wrapper;
};

// ---------------------------------------------------------------------------
// Handle tables
// ---------------------------------------------------------------------------

IAttachment* lookupAttachment(int handle)
{
	const auto it = g_databases.find(handle);
	return it == g_databases.end() ? nullptr : it->second.attachment;
}

ITransaction* lookupTransaction(int handle)
{
	const auto it = g_transactions.find(handle);
	return it == g_transactions.end() ? nullptr : it->second.transaction;
}

// ---------------------------------------------------------------------------
// The statement cache
// ---------------------------------------------------------------------------
//
// Preparing is most of what a cheap query costs here: a one-row primary-key
// SELECT through fb_query_params took 55-75 µs where the fetch itself takes
// 3-5 µs, and a consumer that sends the same statements every frame paid the
// prepare every time.  So each database keeps its last statements prepared,
// keyed by their SQL text, and the query and execute paths take them from here.
//
// A statement in Firebird's OO API belongs to the attachment, not to the
// transaction it was prepared in, so a kept statement runs in whichever
// transaction the next call brings.  Only plain DML, SELECT and EXECUTE
// PROCEDURE / EXECUTE BLOCK are kept.  DDL is never kept, and it empties the
// database's cache before it runs: a kept statement holds the metadata the
// DDL may be about to change (an altered procedure would otherwise keep
// running its old body here, and a dropped table could be refused as in use).
// A statement whose execution fails is dropped too, in case it went stale.

void freeStatement(IStatement* statement)
{
	Status s;
	statement->free(s.ptr());
	statement->release();
}

DbEntry* lookupEntry(int handle)
{
	const auto it = g_databases.find(handle);
	return it == g_databases.end() ? nullptr : &it->second;
}

void flushStatements(DbEntry& entry)
{
	for (auto& c : entry.statements)
		freeStatement(c.statement);
	entry.statements.clear();
}

bool cacheableType(unsigned type)
{
	switch (type)
	{
		case isc_info_sql_stmt_select:
		case isc_info_sql_stmt_insert:
		case isc_info_sql_stmt_update:
		case isc_info_sql_stmt_delete:
		case isc_info_sql_stmt_exec_procedure:
		case isc_info_sql_stmt_select_for_upd:
			return true;
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// The shared read transaction
// ---------------------------------------------------------------------------
//
// With a tx_handle of 0, a query used to start a transaction, run, and commit:
// with the statement kept prepared, that start and commit were half of what a
// cheap SELECT cost.  When fb_read_transaction(db, 1) asks for it, an autocommit
// SELECT instead runs in a READ COMMITTED READ CONSISTENCY read-only
// transaction that the database keeps open between calls.  Each statement
// still reads everything committed before it starts, as a fresh transaction
// did, and a read-only read-committed transaction holds no garbage back.
//
// Two things differ, and are why it is an option.  A SELECT that writes (a
// selectable procedure that updates a table) fails there with "attempted
// update during read-only transaction"; it is then run again in a transaction
// of its own, and its text is remembered so later calls go there directly,
// but whatever it did outside transaction control before the failed write (a
// sequence, RDB$SET_CONTEXT) happened twice on that first call.  And rows a
// SELECT leaves in an ON COMMIT DELETE ROWS temporary table stay until the
// shared transaction ends, not until the call does.

void endReadTransaction(DbEntry& entry)
{
	if (!entry.readTransaction)
		return;
	Status status;
	entry.readTransaction->commit(status.ptr());
	if (status.failed())
	{
		Status rollbackStatus;
		entry.readTransaction->rollback(rollbackStatus.ptr());
	}
	entry.readTransaction = nullptr;
}

/** The database's shared read transaction, started if need be; null if it cannot be. */
ITransaction* sharedReadTransaction(DbEntry& entry)
{
	if (entry.readTransaction)
		return entry.readTransaction;

	Status status;
	IXpbBuilder* tpb = g_util->getXpbBuilder(status.ptr(), IXpbBuilder::TPB, nullptr, 0);
	if (status.failed() || !tpb)
		return nullptr;
	tpb->insertTag(status.ptr(), isc_tpb_read_committed);
	tpb->insertTag(status.ptr(), isc_tpb_read_consistency);
	tpb->insertTag(status.ptr(), isc_tpb_read);
	ITransaction* transaction = nullptr;
	if (!status.failed())
		transaction = entry.attachment->startTransaction(status.ptr(),
			tpb->getBufferLength(status.ptr()), tpb->getBuffer(status.ptr()));
	tpb->dispose();

	entry.readTransaction = status.failed() ? nullptr : transaction;
	return entry.readTransaction;
}

/** Whether an autocommit query of `sql` should try the shared read transaction. */
bool wantsSharedRead(DbEntry* entry, const char* sql)
{
	return entry && entry->sharedReads && !entry->writers.count(sql);
}

/** `sql` wrote in the shared read transaction: it gets a transaction of its own from now on. */
void rememberWriter(DbEntry& entry, const char* sql)
{
	if (entry.writers.size() >= 1024)
		entry.writers.clear();
	entry.writers.insert(sql);
}

/**
 * DDL is about to run: drop what was built on the old metadata.  The kept
 * statements go, the shared read transaction ends, and the remembered writers
 * are forgotten (an altered procedure may no longer write).
 */
void forgetMetadata(DbEntry& entry)
{
	flushStatements(entry);
	endReadTransaction(entry);
	entry.writers.clear();
}

/**
 * The prepared statement for `sql`: the kept one if there is one, else a new
 * prepare (kept when its kind allows).  `cached` says whether the cache owns
 * it; pass it to releaseStatement() when done.  On a failed prepare, `status`
 * holds the error and the result is null.
 */
IStatement* acquireStatement(int db_handle, IAttachment* attachment, ITransaction* transaction,
	const char* sql, Status& status, bool& cached, unsigned* typeOut = nullptr)
{
	cached = false;
	if (typeOut)
		*typeOut = 0;
	DbEntry* entry = lookupEntry(db_handle);

	if (entry && g_statementCacheSize)
	{
		for (auto it = entry->statements.begin(); it != entry->statements.end(); ++it)
		{
			if (it->sql == sql)
			{
				entry->statements.splice(entry->statements.begin(), entry->statements, it);
				cached = true;
				if (typeOut)
					*typeOut = entry->statements.front().type;
				return entry->statements.front().statement;
			}
		}
	}

	IStatement* statement = attachment->prepare(status.ptr(), transaction, 0, sql,
		SQL_DIALECT_V6, IStatement::PREPARE_PREFETCH_METADATA);
	if (status.failed() || !statement)
		return nullptr;

	Status typeStatus;
	const unsigned type = statement->getType(typeStatus.ptr());
	if (typeStatus.failed())
		return statement;   // unknown kind: used once, not kept
	if (typeOut)
		*typeOut = type;

	if (type == isc_info_sql_stmt_ddl && entry)
		forgetMetadata(*entry);

	if (entry && g_statementCacheSize && cacheableType(type))
	{
		entry->statements.push_front(CachedStatement{sql, statement, type});
		cached = true;
		while (entry->statements.size() > g_statementCacheSize)
		{
			freeStatement(entry->statements.back().statement);
			entry->statements.pop_back();
		}
	}

	return statement;
}

/** Done with a statement from acquireStatement(): `failed` drops a kept one, in case it went stale. */
void releaseStatement(int db_handle, IStatement* statement, bool cached, bool failed)
{
	if (!statement)
		return;
	if (!cached)
	{
		freeStatement(statement);
		return;
	}
	if (!failed)
		return;
	DbEntry* entry = lookupEntry(db_handle);
	if (!entry)
		return;
	for (auto it = entry->statements.begin(); it != entry->statements.end(); ++it)
	{
		if (it->statement == statement)
		{
			freeStatement(statement);
			entry->statements.erase(it);
			return;
		}
	}
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

void jsonEscape(const char* data, size_t length, std::string& out)
{
	out += '"';
	for (size_t i = 0; i < length; i++)
	{
		const unsigned char c = static_cast<unsigned char>(data[i]);
		switch (c)
		{
			case '"':  out += "\\\""; break;
			case '\\': out += "\\\\"; break;
			case '\b': out += "\\b";  break;
			case '\f': out += "\\f";  break;
			case '\n': out += "\\n";  break;
			case '\r': out += "\\r";  break;
			case '\t': out += "\\t";  break;
			default:
				if (c < 0x20)
				{
					char esc[8];
					snprintf(esc, sizeof(esc), "\\u%04x", c);
					out += esc;
				}
				else
					out += static_cast<char>(c);
		}
	}
	out += '"';
}

void jsonEscape(const std::string& s, std::string& out)
{
	jsonEscape(s.data(), s.size(), out);
}

const char BASE64_ALPHABET[] =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

void base64Encode(const std::vector<unsigned char>& bytes, std::string& out)
{
	size_t i = 0;
	while (i + 2 < bytes.size())
	{
		const unsigned v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
		out += BASE64_ALPHABET[(v >> 18) & 0x3F];
		out += BASE64_ALPHABET[(v >> 12) & 0x3F];
		out += BASE64_ALPHABET[(v >> 6) & 0x3F];
		out += BASE64_ALPHABET[v & 0x3F];
		i += 3;
	}

	const size_t remaining = bytes.size() - i;
	if (remaining == 1)
	{
		const unsigned v = bytes[i] << 16;
		out += BASE64_ALPHABET[(v >> 18) & 0x3F];
		out += BASE64_ALPHABET[(v >> 12) & 0x3F];
		out += "==";
	}
	else if (remaining == 2)
	{
		const unsigned v = (bytes[i] << 16) | (bytes[i + 1] << 8);
		out += BASE64_ALPHABET[(v >> 18) & 0x3F];
		out += BASE64_ALPHABET[(v >> 12) & 0x3F];
		out += BASE64_ALPHABET[(v >> 6) & 0x3F];
		out += '=';
	}
}

/**
 * Render a scaled integer as exact decimal text.
 *
 * Firebird stores NUMERIC(p,s) as an integer scaled by 10^-s.  Dividing by a
 * double here would silently lose precision on the very types users pick
 * *because* they need precision, so the digits are shifted textually instead.
 */
// ---------------------------------------------------------------------------
// Writing values without snprintf
// ---------------------------------------------------------------------------
//
// bench/call-cost.js put the cost of writing a value at 0.5-0.65 µs against
// 0.1 µs to decode it in JS, the most for dates and timestamps: each went
// through IUtil::decodeDate/decodeTime, snprintf, a temporary string and an
// escaping pass.  These write digits straight into the result.

/** `value` in decimal, as snprintf("%lld") would. */
void appendInteger(long long value, std::string& out)
{
	char buf[24];
	const auto r = std::to_chars(buf, buf + sizeof(buf), value);
	out.append(buf, r.ptr);
}

/** `value` zero-padded to at least `width` digits, as snprintf("%0*u") would. */
void appendPadded(unsigned value, int width, std::string& out)
{
	char buf[16];
	const auto r = std::to_chars(buf, buf + sizeof(buf), value);
	const int digits = static_cast<int>(r.ptr - buf);
	if (digits < width)
		out.append(static_cast<size_t>(width - digits), '0');
	out.append(buf, r.ptr);
}

/**
 * Firebird's day number (days since 1858-11-17) as a calendar date: the
 * engine's own arithmetic (NoThrowTimeStamp::decode_date), done here rather
 * than through an IUtil call per value.
 */
void decodeDay(ISC_DATE date, unsigned& year, unsigned& month, unsigned& day)
{
	int nday = date + 2400001 - 1721119;
	const int century = (4 * nday - 1) / 146097;
	nday = 4 * nday - 1 - 146097 * century;
	int d = nday / 4;

	nday = (4 * d + 3) / 1461;
	d = 4 * d + 3 - 1461 * nday;
	d = (d + 4) / 4;

	int m = (5 * d - 3) / 153;
	d = 5 * d - 3 - 153 * m;
	d = (d + 5) / 5;

	int y = 100 * century + nday;
	if (m < 10)
		m += 3;
	else
	{
		m -= 9;
		y += 1;
	}

	year = static_cast<unsigned>(y);
	month = static_cast<unsigned>(m);
	day = static_cast<unsigned>(d);
}

/** Firebird's time of day (1/10000 s since midnight), as NoThrowTimeStamp::decode_time. */
void decodeTimeOfDay(ISC_TIME time, unsigned& hours, unsigned& minutes, unsigned& seconds,
	unsigned& fractions)
{
	hours = time / (3600 * ISC_TIME_SECONDS_PRECISION);
	time %= 3600 * ISC_TIME_SECONDS_PRECISION;
	minutes = time / (60 * ISC_TIME_SECONDS_PRECISION);
	time %= 60 * ISC_TIME_SECONDS_PRECISION;
	seconds = time / ISC_TIME_SECONDS_PRECISION;
	fractions = time % ISC_TIME_SECONDS_PRECISION;
}

void appendScaledDecimal(ISC_INT64 value, int scale, std::string& out)
{
	if (scale >= 0)
	{
		// Positive scale means the stored value must be multiplied by 10^scale.
		appendInteger(static_cast<long long>(value), out);
		out.append(static_cast<size_t>(scale), '0');
		return;
	}

	const bool negative = value < 0;
	// Build the digits from the absolute value.  Using unsigned arithmetic
	// avoids undefined behaviour when value is INT64_MIN.
	unsigned long long magnitude = negative
		? (~static_cast<unsigned long long>(value) + 1ULL)
		: static_cast<unsigned long long>(value);

	char digits[32];
	const auto written = std::to_chars(digits, digits + sizeof(digits), magnitude);
	std::string text(digits, written.ptr);

	const size_t decimals = static_cast<size_t>(-scale);
	if (text.size() <= decimals)
		text.insert(0, decimals - text.size() + 1, '0');

	text.insert(text.size() - decimals, ".");

	if (negative)
		out += '-';
	out += text;
}

/** JSON numbers are IEEE-754 doubles; beyond 2^53 integers stop being exact. */
bool exactlyRepresentableAsDouble(ISC_INT64 value)
{
	constexpr ISC_INT64 SAFE = 9007199254740991LL; // Number.MAX_SAFE_INTEGER
	return value >= -SAFE && value <= SAFE;
}

// ---------------------------------------------------------------------------
// Value decoding
// ---------------------------------------------------------------------------

void appendTimeText(unsigned hours, unsigned minutes, unsigned seconds,
	unsigned fractions, std::string& out)
{
	appendPadded(hours, 2, out);
	out += ':';
	appendPadded(minutes, 2, out);
	out += ':';
	appendPadded(seconds, 2, out);
	out += '.';
	appendPadded(fractions, 4, out);
}

void appendDateText(unsigned year, unsigned month, unsigned day, std::string& out)
{
	appendPadded(year, 4, out);
	out += '-';
	appendPadded(month, 2, out);
	out += '-';
	appendPadded(day, 2, out);
}

/** Read a text or binary BLOB in full and append it as a JSON string. */
void appendBlob(IAttachment* attachment, ITransaction* transaction,
	ISC_QUAD* blobId, int subType, std::string& out, BlobSink* sink)
{
	Status status;
	IBlob* blob = attachment->openBlob(status.ptr(), transaction, blobId, 0, nullptr);
	if (status.failed() || !blob)
	{
		out += "null";
		return;
	}

	std::vector<unsigned char> bytes;
	unsigned char segment[16384];

	for (;;)
	{
		unsigned segmentLength = 0;
		const int rc = blob->getSegment(status.ptr(), sizeof(segment), segment, &segmentLength);

		if (status.failed())
			break;

		if (segmentLength)
			bytes.insert(bytes.end(), segment, segment + segmentLength);

		if (rc == IStatus::RESULT_NO_DATA)
			break;
	}

	Status closeStatus;
	blob->close(closeStatus.ptr());
	blob->release();

	// SUB_TYPE 1 is TEXT; everything else is opaque binary.
	if (subType == 1)
	{
		jsonEscape(reinterpret_cast<const char*>(bytes.data()), bytes.size(), out);
		return;
	}

	if (sink && sink->enabled)
	{
		// Out of band: the JSON keeps a reference and the bytes go beside it.
		// The index is the blob's position in the side buffer, which is simply
		// how many have been collected so far.
		char placeholder[32];
		snprintf(placeholder, sizeof(placeholder), "{\"$blob\":%u}",
			static_cast<unsigned>(sink->lengths.size()));
		out += placeholder;

		sink->lengths.push_back(static_cast<unsigned>(bytes.size()));
		sink->data.insert(sink->data.end(), bytes.begin(), bytes.end());
		return;
	}

	out += '"';
	base64Encode(bytes, out);
	out += '"';
}

/**
 * Character-set ids from Firebird's src/intl/charsets.h, which is
 * engine-internal and not reachable from the public API headers this file is
 * written against.  UNICODE_FSS is UTF-8 limited to three bytes a character.
 */
constexpr unsigned FB_CS_UNICODE_FSS = 3;
constexpr unsigned FB_CS_UTF8 = 4;

/**
 * How many bytes of a CHAR(n) value to keep.
 *
 * Firebird pads a CHAR to its length in bytes, which for a multi-byte
 * character set is n times the widest character: a CHAR(36) in UTF-8 arrives
 * as 144 bytes.  The value is its first n characters, padding included, as
 * other Firebird drivers return it.  The attachment's character set is UTF-8,
 * so every text column arrives in UTF-8 except OCTETS and NONE, which are one
 * byte a character and kept whole.
 */
unsigned charTextLength(const unsigned char* data, unsigned length, unsigned charSet)
{
	charSet &= 0xff;   // the high byte is the collation
	const unsigned bytesPerChar =
		charSet == FB_CS_UTF8 ? 4 : charSet == FB_CS_UNICODE_FSS ? 3 : 1;
	if (bytesPerChar == 1)
		return length;

	const unsigned chars = length / bytesPerChar;
	unsigned pos = 0;
	for (unsigned n = 0; n < chars && pos < length; n++)
	{
		const unsigned char c = data[pos];
		pos += c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xe ? 3 : (c >> 3) == 0x1e ? 4 : 1;
	}
	return pos < length ? pos : length;
}

/**
 * Append one column value, already located inside the fetched message buffer,
 * as JSON.
 */
void appendValue(IAttachment* attachment, ITransaction* transaction,
	unsigned type, int subType, int scale, unsigned length, unsigned charSet,
	const unsigned char* data, std::string& out, BlobSink* sink)
{
	switch (type)
	{
		case SQL_TEXT:
			jsonEscape(reinterpret_cast<const char*>(data),
				charTextLength(data, length, charSet), out);
			break;

		case SQL_VARYING:
		{
			unsigned short varLength = 0;
			memcpy(&varLength, data, sizeof(varLength));
			jsonEscape(reinterpret_cast<const char*>(data + sizeof(varLength)),
				varLength, out);
			break;
		}

		case SQL_SHORT:
		{
			short value = 0;
			memcpy(&value, data, sizeof(value));
			if (scale)
				{ out += '"'; appendScaledDecimal(value, scale, out); out += '"'; }
			else
				appendInteger(value, out);
			break;
		}

		case SQL_LONG:
		{
			ISC_LONG value = 0;
			memcpy(&value, data, sizeof(value));
			if (scale)
				{ out += '"'; appendScaledDecimal(value, scale, out); out += '"'; }
			else
				appendInteger(value, out);
			break;
		}

		case SQL_INT64:
		{
			ISC_INT64 value = 0;
			memcpy(&value, data, sizeof(value));
			if (scale)
				{ out += '"'; appendScaledDecimal(value, scale, out); out += '"'; }
			else if (exactlyRepresentableAsDouble(value))
				appendInteger(static_cast<long long>(value), out);
			else
			{
				// Emitting a JSON number here would silently round the value.
				out += '"';
				appendInteger(static_cast<long long>(value), out);
				out += '"';
			}
			break;
		}

		case SQL_INT128:
		{
			Status status;
			IInt128* int128 = g_util->getInt128(status.ptr());
			char buf[IInt128::STRING_SIZE];
			buf[0] = '\0';
			if (!status.failed() && int128)
			{
				int128->toString(status.ptr(), reinterpret_cast<const FB_I128*>(data),
					scale, sizeof(buf), buf);
			}
			if (status.failed() || !buf[0])
				out += "null";
			else
				jsonEscape(buf, strlen(buf), out);
			break;
		}

		case SQL_FLOAT:
		{
			float value = 0;
			memcpy(&value, data, sizeof(value));
			if (!std::isfinite(value))
				out += "null"; // JSON has no Infinity/NaN
			else
			{
				char buf[32];
				snprintf(buf, sizeof(buf), "%.9g", static_cast<double>(value));
				out += buf;
			}
			break;
		}

		case SQL_DOUBLE:
		case SQL_D_FLOAT:
		{
			double value = 0;
			memcpy(&value, data, sizeof(value));
			if (!std::isfinite(value))
				out += "null";
			else
			{
				// The shortest text that reads back as this very double: what
				// %.17g guaranteed, in fewer digits (0.1, not 0.10000000000000001).
				char buf[32];
				const auto r = std::to_chars(buf, buf + sizeof(buf), value);
				out.append(buf, r.ptr);
			}
			break;
		}

		case SQL_DEC16:
		{
			Status status;
			IDecFloat16* dec = g_util->getDecFloat16(status.ptr());
			char buf[IDecFloat16::STRING_SIZE];
			buf[0] = '\0';
			if (!status.failed() && dec)
				dec->toString(status.ptr(), reinterpret_cast<const FB_DEC16*>(data), sizeof(buf), buf);
			if (status.failed() || !buf[0])
				out += "null";
			else
				jsonEscape(buf, strlen(buf), out);
			break;
		}

		case SQL_DEC34:
		{
			Status status;
			IDecFloat34* dec = g_util->getDecFloat34(status.ptr());
			char buf[IDecFloat34::STRING_SIZE];
			buf[0] = '\0';
			if (!status.failed() && dec)
				dec->toString(status.ptr(), reinterpret_cast<const FB_DEC34*>(data), sizeof(buf), buf);
			if (status.failed() || !buf[0])
				out += "null";
			else
				jsonEscape(buf, strlen(buf), out);
			break;
		}

		case SQL_BOOLEAN:
			out += (data[0] ? "true" : "false");
			break;

		case SQL_TYPE_DATE:
		{
			ISC_DATE value = 0;
			memcpy(&value, data, sizeof(value));
			unsigned year = 0, month = 0, day = 0;
			decodeDay(value, year, month, day);
			out += '"';
			appendDateText(year, month, day, out);
			out += '"';
			break;
		}

		case SQL_TYPE_TIME:
		{
			ISC_TIME value = 0;
			memcpy(&value, data, sizeof(value));
			unsigned hours = 0, minutes = 0, seconds = 0, fractions = 0;
			decodeTimeOfDay(value, hours, minutes, seconds, fractions);
			out += '"';
			appendTimeText(hours, minutes, seconds, fractions, out);
			out += '"';
			break;
		}

		case SQL_TIMESTAMP:
		{
			ISC_TIMESTAMP value;
			memcpy(&value, data, sizeof(value));
			unsigned year = 0, month = 0, day = 0;
			unsigned hours = 0, minutes = 0, seconds = 0, fractions = 0;
			decodeDay(value.timestamp_date, year, month, day);
			decodeTimeOfDay(value.timestamp_time, hours, minutes, seconds, fractions);
			out += '"';
			appendDateText(year, month, day, out);
			out += 'T';
			appendTimeText(hours, minutes, seconds, fractions, out);
			out += '"';
			break;
		}

		case SQL_TIME_TZ:
		{
			Status status;
			ISC_TIME_TZ value;
			memcpy(&value, data, sizeof(value));
			unsigned hours = 0, minutes = 0, seconds = 0, fractions = 0;
			char zone[64] = {0};
			g_util->decodeTimeTz(status.ptr(), &value, &hours, &minutes, &seconds,
				&fractions, sizeof(zone), zone);
			if (status.failed())
				{ out += "null"; break; }
			std::string text;
			appendTimeText(hours, minutes, seconds, fractions, text);
			text += ' ';
			text += zone;
			jsonEscape(text, out);
			break;
		}

		case SQL_TIMESTAMP_TZ:
		{
			Status status;
			ISC_TIMESTAMP_TZ value;
			memcpy(&value, data, sizeof(value));
			unsigned year = 0, month = 0, day = 0;
			unsigned hours = 0, minutes = 0, seconds = 0, fractions = 0;
			char zone[64] = {0};
			g_util->decodeTimeStampTz(status.ptr(), &value, &year, &month, &day,
				&hours, &minutes, &seconds, &fractions, sizeof(zone), zone);
			if (status.failed())
				{ out += "null"; break; }
			std::string text;
			appendDateText(year, month, day, text);
			text += 'T';
			appendTimeText(hours, minutes, seconds, fractions, text);
			text += ' ';
			text += zone;
			jsonEscape(text, out);
			break;
		}

		case SQL_BLOB:
		{
			ISC_QUAD blobId;
			memcpy(&blobId, data, sizeof(blobId));
			appendBlob(attachment, transaction, &blobId, subType, out, sink);
			break;
		}

		default:
			// Unmapped types (ARRAY, QUAD, …) are reported as null rather than
			// guessed at.  See the type table at the top of this file.
			out += "null";
			break;
	}
}

// ---------------------------------------------------------------------------
// Statement parameters
// ---------------------------------------------------------------------------
//
// Parameters arrive from JavaScript as one packed buffer rather than JSON, so
// this side needs no parser and there is no escaping to get wrong:
//
//     u32  count
//     per parameter:
//       u8   flags         bit 0: SQL NULL; bit 1: a binary form follows the text
//       u32  byteLength    (absent when NULL)
//       ...  UTF-8 bytes   (absent when NULL)
//       u8   kind          (only with bit 1) 1: INT64, 2: DOUBLE
//       8    the value     (only with bit 1) little-endian
//
// Every value is sent as text and the input message is described as VARCHAR
// UTF-8, letting Firebird convert to the column's actual type.  That is what
// makes one code path work for integers, dates and strings alike; the
// alternative is reimplementing Firebird's conversion rules in the binding
// layer and getting them subtly wrong.

/**
 * One bound parameter: SQL NULL, or text for the engine to convert, with the
 * number it came from beside it when the caller had one (a JavaScript number
 * or bigint).  The text is what every destination but a floating-point or
 * whole-number column gets, so a NUMERIC(18,2) still sees "1.1" and a VARCHAR
 * "1.5"; those two kinds of column take the binary form, exactly.
 */
struct ParamValue
{
	bool          isNull = true;
	std::string   text;
	/** 0: text only; 1: the value is in `i64`; 2: in `dbl`. */
	unsigned char binaryKind = 0;
	ISC_INT64     i64 = 0;
	double        dbl = 0;
};

/** Read a little-endian u32 without assuming alignment. */
unsigned readU32(const unsigned char* p)
{
	return static_cast<unsigned>(p[0]) |
	       (static_cast<unsigned>(p[1]) << 8) |
	       (static_cast<unsigned>(p[2]) << 16) |
	       (static_cast<unsigned>(p[3]) << 24);
}

/**
 * Decode the packed parameter buffer.
 *
 * Every length is checked against the remaining bytes: this data crosses the
 * JS/WASM boundary, and a malformed buffer must produce an error rather than
 * an out-of-bounds read.
 */
bool parseParamsAt(const unsigned char* data, unsigned length, unsigned& pos,
	std::vector<ParamValue>& out)
{
	out.clear();

	if (pos + 4 > length)
		return false;

	const unsigned count = readU32(data + pos);
	pos += 4;

	out.reserve(count);

	for (unsigned i = 0; i < count; i++)
	{
		if (pos + 1 > length)
			return false;

		ParamValue value;
		const unsigned char flags = data[pos++];
		value.isNull = (flags & 1) != 0;

		if (!value.isNull)
		{
			if (pos + 4 > length)
				return false;

			const unsigned len = readU32(data + pos);
			pos += 4;

			if (pos + len > length)
				return false;

			value.text.assign(reinterpret_cast<const char*>(data + pos), len);
			pos += len;
		}

		if (flags & 2)
		{
			if (pos + 9 > length)
				return false;

			value.binaryKind = data[pos++];
			// wasm32 is little-endian, as the buffer is: the bytes are the value
			if (value.binaryKind == 1)
				memcpy(&value.i64, data + pos, sizeof(value.i64));
			else if (value.binaryKind == 2)
				memcpy(&value.dbl, data + pos, sizeof(value.dbl));
			else
				return false;
			pos += 8;
		}

		out.push_back(std::move(value));
	}

	return true;
}

bool parseParams(const unsigned char* data, unsigned length,
	std::vector<ParamValue>& out)
{
	out.clear();

	if (!data || length < 4)
		return length == 0;   // no parameters at all is valid

	unsigned pos = 0;
	return parseParamsAt(data, length, pos, out);
}

/**
 * An input message built from bound parameters.
 *
 * Owns the metadata and the buffer, and releases them together — the engine
 * reads both while the statement executes.
 */
class InputMessage
{
public:
	InputMessage() = default;

	~InputMessage()
	{
		if (metadata)
			metadata->release();
	}

	InputMessage(const InputMessage&) = delete;
	InputMessage& operator=(const InputMessage&) = delete;

	/**
	 * Where a BLOB parameter's value is written: the attachment and the
	 * transaction the statement executes in.  Without them a BLOB parameter
	 * is refused, as it always was.
	 */
	void writeBlobsTo(IAttachment* toAttachment, ITransaction* toTransaction) noexcept
	{
		blobAttachment = toAttachment;
		blobTransaction = toTransaction;
	}

	/** Whether any parameter is a BLOB (known after describe()). */
	bool hasBlobParameter() const noexcept
	{
		for (const Field& f : fields)
			if (f.type == SQL_BLOB)
				return true;
		return false;
	}

	IMessageMetadata* meta() const noexcept { return metadata; }
	void* data() noexcept { return buffer.empty() ? nullptr : buffer.data(); }
	unsigned parameterCount() const noexcept { return expected; }
	unsigned size() const noexcept { return static_cast<unsigned>(buffer.size()); }

	/** The message's stride in a batch buffer: its length rounded up to its alignment. */
	unsigned alignedLength()
	{
		Status status;
		const unsigned length = metadata ? metadata->getAlignedLength(status.ptr()) : 0;
		return status.failed() ? 0 : length;
	}

	/**
	 * Take the statement's input message format: the parameter count, the
	 * message length and each parameter's descriptor.  Once per statement;
	 * fill() then packs a set of values into it, as many times as there are
	 * rows to execute.
	 */
	bool describe(IStatement* statement)
	{
		Status status;

		// The statement's own input metadata is used unchanged, so the engine
		// receives exactly the message format it prepared for.  An earlier
		// attempt rebuilt the metadata as VARCHAR via IMetadataBuilder and the
		// engine rejected the result with "internal error"; describing the
		// message is the engine's business, converting the values is ours.
		metadata = statement->getInputMetadata(status.ptr());
		if (status.failed() || !metadata)
		{
			setErrorFromStatus("could not read parameter metadata", status.ptr());
			return false;
		}

		expected = metadata->getCount(status.ptr());
		if (status.failed())
		{
			setErrorFromStatus("could not count parameters", status.ptr());
			return false;
		}

		if (expected == 0)
			return true;   // nothing to bind, ever

		const unsigned messageLength = metadata->getMessageLength(status.ptr());
		if (status.failed())
		{
			setErrorFromStatus("could not size the parameter message", status.ptr());
			return false;
		}

		buffer.assign(messageLength, 0);
		fields.resize(expected);

		for (unsigned i = 0; i < expected; i++)
		{
			fields[i].type       = metadata->getType(status.ptr(), i) & ~1u;
			fields[i].scale      = metadata->getScale(status.ptr(), i);
			fields[i].length     = metadata->getLength(status.ptr(), i);
			fields[i].offset     = metadata->getOffset(status.ptr(), i);
			fields[i].nullOffset = metadata->getNullOffset(status.ptr(), i);

			if (status.failed())
			{
				setErrorFromStatus("could not read a parameter descriptor", status.ptr());
				return false;
			}
		}

		return true;
	}

	/**
	 * Pack `values` into the message described.
	 *
	 * A value's text is presented as VARCHAR and Firebird converts it to the
	 * declared type — the same conversion SQL string literals get, so
	 * integers, decimals, dates and booleans all follow the engine's own rules
	 * rather than a reimplementation of them.  A value that came with its
	 * binary form (a JavaScript number or bigint) is presented as DOUBLE or
	 * INT64 instead where the destination is floating-point, or a whole number
	 * of scale 0: no text is parsed on the way, and a double arrives bit for
	 * bit (text-to-double conversion is off by an ulp for about one value in
	 * six).  Everything else — NUMERIC and DECIMAL with their exact decimal
	 * conversion, text, dates — keeps the text.
	 */
	bool fill(const std::vector<ParamValue>& values)
	{
		Status status;

		if (expected != values.size())
		{
			char message[128];
			snprintf(message, sizeof(message),
				"statement expects %u parameter(s) but %u were supplied",
				expected, static_cast<unsigned>(values.size()));
			setError(message);
			return false;
		}

		for (unsigned i = 0; i < expected; i++)
		{
			const Field& f = fields[i];

			const short nullFlag = values[i].isNull ? -1 : 0;
			memcpy(buffer.data() + f.nullOffset, &nullFlag, sizeof(nullFlag));

			if (values[i].isNull)
				continue;

			if (f.type == SQL_BLOB)
			{
				// Firebird converts no value to a BLOB in the message: a BLOB
				// parameter takes a blob's id.  So the text is written as a
				// blob in the statement's transaction, and its id bound.
				ISC_QUAD blobId;
				if (!writeBlob(values[i].text, blobId, i))
					return false;
				memcpy(buffer.data() + f.offset, &blobId, sizeof(blobId));
				continue;
			}

			const bool floating = f.type == SQL_DOUBLE || f.type == SQL_FLOAT || f.type == SQL_D_FLOAT;
			const bool whole    = (f.type == SQL_SHORT || f.type == SQL_LONG || f.type == SQL_INT64) && f.scale == 0;

			if (values[i].binaryKind == 2 && floating)
			{
				g_util->convert(status.ptr(),
					SQL_DOUBLE, 0, sizeof(double), &values[i].dbl,
					f.type, f.scale, f.length, buffer.data() + f.offset);
			}
			else if (values[i].binaryKind == 1 && (floating || whole))
			{
				g_util->convert(status.ptr(),
					SQL_INT64, 0, sizeof(ISC_INT64), &values[i].i64,
					f.type, f.scale, f.length, buffer.data() + f.offset);
			}
			else
			{
				const std::string& text = values[i].text;

				if (text.size() > 0xFFFF)
				{
					setError("parameter is too long to bind as text");
					return false;
				}

				std::vector<unsigned char> source(sizeof(unsigned short) + text.size());
				const unsigned short textLength = static_cast<unsigned short>(text.size());
				memcpy(source.data(), &textLength, sizeof(textLength));
				memcpy(source.data() + sizeof(textLength), text.data(), text.size());

				g_util->convert(status.ptr(),
					SQL_VARYING, 0,
					static_cast<unsigned>(source.size()), source.data(),
					f.type, f.scale, f.length, buffer.data() + f.offset);
			}

			if (status.failed())
			{
				char context[160];
				snprintf(context, sizeof(context),
					"could not convert parameter %u (\"%.60s\")", i, values[i].text.c_str());
				setErrorFromStatus(context, status.ptr());
				return false;
			}
		}

		return true;
	}

	/** describe() and fill() in one: the single-statement case. */
	bool build(IStatement* statement, const std::vector<ParamValue>& values)
	{
		return describe(statement) && fill(values);
	}

private:
	struct Field
	{
		unsigned type = 0;
		int      scale = 0;
		unsigned length = 0;
		unsigned offset = 0;
		unsigned nullOffset = 0;
	};

	/** Write `text` as a new blob in the bound transaction; its id into `id`. */
	bool writeBlob(const std::string& text, ISC_QUAD& id, unsigned index)
	{
		if (!blobAttachment || !blobTransaction)
		{
			char message[96];
			snprintf(message, sizeof(message), "parameter %u is a BLOB, which this call cannot write", index);
			setError(message);
			return false;
		}

		Status status;
		IBlob* blob = blobAttachment->createBlob(status.ptr(), blobTransaction, &id, 0, nullptr);
		if (status.failed() || !blob)
		{
			setErrorFromStatus("could not create a blob for a parameter", status.ptr());
			return false;
		}

		// Segments are at most 64 KB; 32 KB keeps well inside that.
		constexpr size_t SEGMENT = 32 * 1024;
		for (size_t at = 0; at < text.size() && !status.failed(); at += SEGMENT)
		{
			const size_t n = std::min(SEGMENT, text.size() - at);
			blob->putSegment(status.ptr(), static_cast<unsigned>(n), text.data() + at);
		}

		if (status.failed())
		{
			setErrorFromStatus("could not write a blob parameter", status.ptr());
			Status cancelStatus;
			blob->cancel(cancelStatus.ptr());
			return false;
		}

		blob->close(status.ptr());   // releases the blob too
		if (status.failed())
		{
			setErrorFromStatus("could not close a blob parameter", status.ptr());
			return false;
		}
		return true;
	}

	IMessageMetadata*          metadata = nullptr;
	IAttachment*               blobAttachment = nullptr;
	ITransaction*              blobTransaction = nullptr;
	unsigned                   expected = 0;
	std::vector<Field>         fields;
	std::vector<unsigned char> buffer;
};

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * A subscription to one or more Firebird events.
 *
 * Firebird delivers events by calling back on one of its own threads.  That
 * thread knows nothing about this file's handle tables, the JavaScript heap,
 * or Emscripten's main-thread invariants, so the callback does the least work
 * that is correct: copy the counts under a mutex and set a flag.  Everything
 * else — reporting to JavaScript, re-arming the queue — happens later, on the
 * thread that calls fb_events_poll().
 *
 * Two details of Firebird's event API drive the shape of this, and the first
 * one cost an event before a test caught it:
 *
 *  - The counts in the block passed to queEvents() are the counts the caller
 *    has *already seen*, and the engine calls back when its own count moves
 *    past them.  Re-arming with zeros would therefore re-deliver everything
 *    immediately, forever.  eventBlock() encodes the last seen counts.
 *  - Registration **does** produce a baseline callback, and it is absorbed.
 *    An earlier revision of this comment said the opposite, on the strength of
 *    "one POST_EVENT produced exactly one callback carrying a count of 1" —
 *    which was measured when delivery was broken and exactly one callback was
 *    all any subscription ever got.  With delivery fixed the two are easy to
 *    tell apart: a subscription to an event that is never posted still gets
 *    one delivery of 1.  What that earlier revision got right is the cost of
 *    guessing wrong, which is silently discarding the first event of every
 *    subscription.
 *  - The baseline callback is not synchronous with queEvents().  With threads,
 *    queEvents() only wakes the event manager's watcher thread, which delivers
 *    later; without them (patch 0006) it delivers inline.  Absorbing "whatever
 *    the first callback says" is only right if nothing was posted in between:
 *    a POST_EVENT committed after queEvents() returned but before the watcher
 *    ran arrives folded into the baseline (count 2 instead of 1) and is lost.
 *    That was the intermittent "live query never refreshed" in the browser
 *    tests, about one run in three.  fb_events_subscribe() therefore waits for
 *    the baseline before returning, so everything posted after a subscription
 *    exists is news.
 *
 *  A delivery also disarms the queue: until queEvents() is called again,
 *  further posts are counted but not delivered.  Re-arming from inside the
 *  callback would mean calling into the engine from the engine's own callback
 *  thread, so fb_events_poll() does it instead.
 */
class EventSubscription final :
	public IEventCallbackImpl<EventSubscription, CheckStatusWrapper>
{
public:
	explicit EventSubscription(std::vector<std::string> names)
		: m_names(std::move(names)),
		  m_seen(m_names.size(), 0),
		  m_reported(m_names.size(), 0)
	{
	}

	// ── IReferenceCounted ──────────────────────────────────────────────
	void addRef() override
	{
		std::lock_guard<std::mutex> guard(m_mutex);
		++m_refs;
	}

	int release() override
	{
		int remaining;
		{
			std::lock_guard<std::mutex> guard(m_mutex);
			remaining = --m_refs;
		}
		if (remaining == 0)
			delete this;
		return remaining;
	}

	/**
	 * Called by the engine, on an engine thread.
	 *
	 * `events` is an event block in the same layout as the one passed to
	 * queEvents, with each event's count updated.  The counts are cumulative
	 * since the database was attached, so a delta against the baseline is what
	 * says how many times something actually fired.
	 */
	void eventCallbackFunction(unsigned length, const unsigned char* events) override
	{
		if (!events || length == 0)
			return;

		std::lock_guard<std::mutex> guard(m_mutex);
		parseCounts(events, length, m_seen);

		// Registering produces one delivery before anything has been posted:
		// queEvents() is armed with "I have seen zero of these", the engine's
		// own counter for a never-posted event is already 1, and it reports the
		// difference immediately.  Measured with a subscription to an event
		// nothing ever posts: exactly one delivery of 1, then silence.
		//
		// So the first counts are a starting point, not news.  Adopting them as
		// already-reported means the caller hears about what happens next,
		// which is what subscribing means.
		if (!m_baselined)
		{
			m_baselined = true;
			m_reported = m_seen;
			m_baselineArrived.notify_all();
		}

		m_disarmed = true;
	}

	/**
	 * Wait until the registration's baseline delivery has been absorbed.
	 *
	 * Returns false if it did not arrive in time.  Without threads the engine
	 * delivers inside queEvents(), so it has always arrived by now.
	 */
	bool waitForBaseline(std::chrono::milliseconds timeout)
	{
		std::unique_lock<std::mutex> guard(m_mutex);
#ifdef __EMSCRIPTEN_PTHREADS__
		return m_baselineArrived.wait_for(guard, timeout, [this] { return m_baselined; });
#else
		(void) timeout;
		return m_baselined;
#endif
	}

	/** Names, in the order their counts appear in the event block. */
	const std::vector<std::string>& names() const { return m_names; }

	/** Take the counts that have arrived since the last call. */
	void takeDeltas(std::vector<unsigned>& out, bool& needsRearm)
	{
		std::lock_guard<std::mutex> guard(m_mutex);

		needsRearm = m_disarmed;
		m_disarmed = false;

		out.resize(m_names.size());
		for (size_t i = 0; i < m_names.size(); ++i)
		{
			// Unsigned subtraction is correct across wraparound, which is the
			// only way a count can appear to go backwards.
			out[i] = m_seen[i] - m_reported[i];
			m_reported[i] = m_seen[i];
		}
	}

	/**
	 * Build the event block queEvents() expects.
	 *
	 *   [version=1] then, per event: [name length][name bytes][count: 4 bytes LE]
	 *
	 * The counts are the ones already seen, not zeros: the engine treats them
	 * as "I know about this many" and calls back when it has more.
	 *
	 * Built here rather than with isc_event_block(), whose varargs signature is
	 * awkward to call safely with a runtime-sized list.
	 */
	std::vector<unsigned char> eventBlock() const
	{
		std::lock_guard<std::mutex> guard(m_mutex);

		std::vector<unsigned char> block;
		block.push_back(1);   // EPB_version1

		for (size_t i = 0; i < m_names.size(); ++i)
		{
			const std::string& name = m_names[i];
			block.push_back(static_cast<unsigned char>(name.size()));
			block.insert(block.end(), name.begin(), name.end());

			const unsigned count = m_seen[i];
			block.push_back(static_cast<unsigned char>(count & 0xff));
			block.push_back(static_cast<unsigned char>((count >> 8) & 0xff));
			block.push_back(static_cast<unsigned char>((count >> 16) & 0xff));
			block.push_back(static_cast<unsigned char>((count >> 24) & 0xff));
		}
		return block;
	}

private:
	static void parseCounts(const unsigned char* buffer, unsigned length,
	                        std::vector<unsigned>& counts)
	{
		unsigned pos = 1;   // skip the version byte
		size_t index = 0;

		while (pos < length && index < counts.size())
		{
			const unsigned nameLength = buffer[pos];
			pos += 1 + nameLength;
			if (pos + 4 > length)
				break;

			counts[index++] = static_cast<unsigned>(buffer[pos]) |
			                  (static_cast<unsigned>(buffer[pos + 1]) << 8) |
			                  (static_cast<unsigned>(buffer[pos + 2]) << 16) |
			                  (static_cast<unsigned>(buffer[pos + 3]) << 24);
			pos += 4;
		}
	}

	mutable std::mutex        m_mutex;
	std::condition_variable   m_baselineArrived;
	int                       m_refs = 1;
	std::vector<std::string>  m_names;
	std::vector<unsigned>     m_seen;       // latest counts from the engine
	std::vector<unsigned>     m_reported;   // counts already handed to JS
	bool                      m_disarmed  = false;
	bool                      m_baselined = false;  // first delivery absorbed
};

/** A live subscription: the callback, its queue handle, and its attachment. */
struct EventEntry
{
	EventSubscription* subscription = nullptr;
	IEvents*           queue        = nullptr;
	IAttachment*       attachment   = nullptr;
};

std::map<int, EventEntry> g_events;
int g_nextEventHandle = 1;

/** (Re-)arm the queue for a subscription.  Returns false and sets the error. */
bool armEvents(EventEntry& entry)
{
	if (entry.queue)
	{
		// Released, not cancelled.  A delivered queue is already spent; asking
		// the engine to cancel it as well is what stopped every delivery after
		// the first.
		entry.queue->release();
		entry.queue = nullptr;
	}

	Status status;
	const std::vector<unsigned char> block = entry.subscription->eventBlock();

	entry.queue = entry.attachment->queEvents(
		status.ptr(), entry.subscription,
		static_cast<unsigned>(block.size()), block.data());

	if (status.failed() || !entry.queue)
	{
		setErrorFromStatus("fb_events: could not queue events", status.ptr());
		return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Parameter blocks
// ---------------------------------------------------------------------------

/**
 * Build the DPB shared by attach and create.
 *
 * The WASM build is a single-process embedded engine with no authentication
 * plugins, so no user/password is supplied; UTF8 is forced because everything
 * crossing the JS boundary is UTF-8 anyway.
 */
IXpbBuilder* buildDpb(Status& status, bool forCreate)
{
	IXpbBuilder* dpb = g_util->getXpbBuilder(status.ptr(), IXpbBuilder::DPB, nullptr, 0);
	if (status.failed() || !dpb)
		return nullptr;

	dpb->insertInt(status.ptr(), isc_dpb_sql_dialect, SQL_DIALECT_V6);
	dpb->insertString(status.ptr(), isc_dpb_lc_ctype, "UTF8");
	// Garbage collection by the statements that meet old record versions,
	// not by a thread of its own.  The engine's default in Super, "combined",
	// has the statement and the collector thread work the same pages, and
	// here every handoff between them is a futex wait and wake between Web
	// Workers: updating and reading 300 rows cost 16.7 ms a round under
	// "combined" and 2.6 under "cooperative" (docs/plans/sab-free-build.md).
	// It is also one thread fewer per database.  GCPolicy is a per-database
	// setting, applied by the attachment that opens the database; a second
	// attachment to an open one gets a warning, not an error.
	dpb->insertString(status.ptr(), isc_dpb_config, "GCPolicy = cooperative");

	if (forCreate)
	{
		dpb->insertInt(status.ptr(), isc_dpb_page_size, 8192);
		dpb->insertString(status.ptr(), isc_dpb_set_db_charset, "UTF8");
		// Databases live in Emscripten's in-memory FS and are flushed to
		// IndexedDB by the TypeScript layer, so the engine's own forced writes
		// would only cost time.
		dpb->insertInt(status.ptr(), isc_dpb_force_write, 0);
	}

	return dpb;
}

/** Locate the statically linked engine provider. */
IProvider* locateProvider()
{
	Status status;

	// The WASM binary links the engine in statically, so the plugin manager is
	// asked for it by name rather than being allowed to search for a shared
	// library it will never find.  The name changed across major versions.
	IPluginManager* pluginManager = g_master->getPluginManager();
	if (pluginManager)
	{
		IPluginSet* plugins = pluginManager->getPlugins(status.ptr(),
			IPluginManager::TYPE_PROVIDER, "Engine14,Engine13,Engine12", nullptr);

		if (!status.failed() && plugins)
		{
			// The plugin set was filtered by TYPE_PROVIDER, so anything it
			// yields is an IProvider.  This is the same downcast Firebird's own
			// GetPlugins<> helper performs.
			IPluginBase* plugin = plugins->getPlugin(status.ptr());
			if (!status.failed() && plugin)
			{
				// Deliberately NOT released.  Firebird's own GetPlugins<> holds
				// the set for as long as the plugin is used: the IPluginConfig
				// handed to the plugin is created by ConfiguredPlugin::factory()
				// and its lifetime is tied to the set.  Releasing the set here
				// leaves JProvider::pluginConfig dangling, and the engine
                                // dereferences it when constructing a Database.
				g_pluginSet = plugins;

				IProvider* provider = static_cast<IProvider*>(plugin);
				// Take our own reference: this pointer is stored in g_provider
				// for the lifetime of the module, well beyond the scope that
				// produced it.  Without it the engine's provider can be
				// released and its memory handed back to Firebird's MemoryPool,
				// which then writes free-list bookkeeping over the object —
				// leaving the vtable intact but corrupting later members.
				provider->addRef();
				return provider;
			}
			plugins->release();
		}
	}

	// Fall back to the Y-valve dispatcher.  It consults the Providers config
	// setting, which needs a firebird.conf that a browser build has no reason
	// to ship — hence the direct lookup above is tried first.
	return g_master->getDispatcher();
}

/**
 * Read a prepared statement's result set and serialise it to JSON.
 *
 * Shared by fb_query() and fb_query_params(); they differ only in whether an
 * input message is supplied.  `cursor` is an out-parameter so the caller's
 * cleanup owns it on every exit path, including the error ones.
 */
/**
 * Append a JSON array describing every field of `meta`.
 *
 * The same shape the result-set encoder emits for its columns, so one decoder
 * on the JS side reads both. A null `meta` — which is what a statement with no
 * parameters or no output reports — is an empty array, not an error.
 */
bool describeMetadata(IMessageMetadata* meta, std::string& json)
{
	Status status;

	json += '[';

	if (meta)
	{
		const unsigned count = meta->getCount(status.ptr());
		if (status.failed())
		{
			setErrorFromStatus("could not read metadata count", status.ptr());
			return false;
		}

		for (unsigned i = 0; i < count; i++)
		{
			if (i)
				json += ',';

			// Prefer the alias, as the result-set encoder does. Input
			// parameters have neither, and come back as "".
			const char* name = meta->getAlias(status.ptr(), i);
			if (status.failed() || !name || !*name)
				name = meta->getField(status.ptr(), i);

			const unsigned type     = meta->getType(status.ptr(), i);
			const int      subType  = meta->getSubType(status.ptr(), i);
			const int      scale    = meta->getScale(status.ptr(), i);
			const unsigned length   = meta->getLength(status.ptr(), i);
			const FB_BOOLEAN nullable = meta->isNullable(status.ptr(), i);

			if (status.failed())
			{
				setErrorFromStatus("could not read field metadata", status.ptr());
				return false;
			}

			json += "{\"name\":";
			jsonEscape(name ? name : "", name ? strlen(name) : 0, json);

			char described[128];
			snprintf(described, sizeof(described),
				",\"type\":%u,\"subType\":%d,\"scale\":%d,\"length\":%u,\"nullable\":%s}",
				type, subType, scale, length, nullable ? "true" : "false");
			json += described;
		}
	}

	json += ']';
	return true;
}

/**
 * The shape of `statement`'s results, described from its output metadata.
 * Null on failure, with the error set; `context` names the caller in it.
 */
std::shared_ptr<OutputShape> describeOutput(IStatement* statement, const char* context)
{
	Status status;
	auto shape = std::make_shared<OutputShape>();

	shape->metadata = statement->getOutputMetadata(status.ptr());
	if (status.failed())
	{
		setErrorFromStatus((std::string(context) + ": could not read output metadata").c_str(),
			status.ptr());
		return nullptr;
	}

	IMessageMetadata* metadata = shape->metadata;
	const unsigned columnCount = metadata ? metadata->getCount(status.ptr()) : 0;
	if (status.failed())
	{
		setErrorFromStatus((std::string(context) + ": could not read column count").c_str(),
			status.ptr());
		return nullptr;
	}

	shape->columnCount = columnCount;
	shape->types.resize(columnCount);
	shape->subTypes.resize(columnCount);
	shape->scales.resize(columnCount);
	shape->lengths.resize(columnCount);
	shape->charSets.resize(columnCount);
	shape->offsets.resize(columnCount);
	shape->nullOffsets.resize(columnCount);

	std::string& json = shape->header;
	json = "{\"columns\":[";

	for (unsigned i = 0; i < columnCount; i++)
	{
		if (i)
			json += ',';

		// Prefer the alias so `SELECT COUNT(*) AS TOTAL` reports TOTAL.
		const char* name = metadata->getAlias(status.ptr(), i);
		if (status.failed() || !name || !*name)
			name = metadata->getField(status.ptr(), i);

		shape->types[i]       = metadata->getType(status.ptr(), i);
		shape->subTypes[i]    = metadata->getSubType(status.ptr(), i);
		shape->scales[i]      = metadata->getScale(status.ptr(), i);
		shape->lengths[i]     = metadata->getLength(status.ptr(), i);
		shape->charSets[i]    = metadata->getCharSet(status.ptr(), i);
		shape->offsets[i]     = metadata->getOffset(status.ptr(), i);
		shape->nullOffsets[i] = metadata->getNullOffset(status.ptr(), i);

		const FB_BOOLEAN nullable = metadata->isNullable(status.ptr(), i);

		if (status.failed())
		{
			setErrorFromStatus("could not read column metadata", status.ptr());
			return nullptr;
		}

		// Each column is described, not just named.  Without the type a
		// caller cannot tell a NUMERIC rendered as "20.25" from a VARCHAR
		// that happens to contain digits — the JSON encoding makes them
		// identical, and only the declared type separates them.
		json += "{\"name\":";
		jsonEscape(name ? name : "", name ? strlen(name) : 0, json);

		char described[128];
		snprintf(described, sizeof(described),
			",\"type\":%u,\"subType\":%d,\"scale\":%d,\"length\":%u,\"nullable\":%s}",
			shape->types[i], shape->subTypes[i], shape->scales[i], shape->lengths[i],
			nullable ? "true" : "false");
		json += described;
	}

	json += "],\"rows\":[";

	if (columnCount)
	{
		shape->messageLength = metadata->getMessageLength(status.ptr());
		if (status.failed())
		{
			setErrorFromStatus("could not size the message buffer", status.ptr());
			return nullptr;
		}

		// EXECUTE PROCEDURE has output columns but no cursor: opening one is
		// refused ("Cannot open cursor for non-SELECT statement").
		Status flagStatus;
		const unsigned statementFlags = statement->getFlags(flagStatus.ptr());
		shape->hasCursor = flagStatus.failed() || (statementFlags & IStatement::FLAG_HAS_CURSOR);
	}

	return shape;
}

/**
 * The shape of `statement`'s results: the kept statement's own if it has one,
 * else described now, and kept with the statement when the cache holds it.
 */
std::shared_ptr<OutputShape> outputShape(int db_handle, IStatement* statement, bool cached,
	const char* context)
{
	CachedStatement* kept = nullptr;
	if (cached)
	{
		if (DbEntry* entry = lookupEntry(db_handle))
		{
			// A statement just used is at the front: this is one comparison.
			for (auto& c : entry->statements)
			{
				if (c.statement == statement)
				{
					kept = &c;
					break;
				}
			}
		}
	}

	if (kept && kept->shape)
		return kept->shape;

	std::shared_ptr<OutputShape> shape = describeOutput(statement, context);
	if (shape && kept)
	{
		shape->id = g_nextShapeId++;
		shape->idHeader = "{\"shape\":" + std::to_string(shape->id) + ",\"rows\":[";
		g_shapes[shape->id] = shape.get();
		kept->shape = shape;
	}
	return shape;
}

bool serialiseCursor(IAttachment* attachment, ITransaction* transaction,
	IStatement* statement, const OutputShape& shape,
	IMessageMetadata* inMeta, void* inBuffer,
	IResultSet*& cursor, std::string& json, BlobSink* sink, bool shapeIds = false)
{
	Status status;
	const unsigned columnCount = shape.columnCount;

	// A kept shape goes by its id when the caller understands ids: the
	// columns' description is then not copied, sent, or read again.
	json = shapeIds && shape.id ? shape.idHeader : shape.header;

	// A statement with no output columns (INSERT, DDL, …) still succeeds; it
	// simply yields an empty result set rather than an error.
	//
	// It has to be *executed* to do that, which is what openCursor does for a
	// SELECT below and what nothing did here: the statement was prepared, the
	// empty result serialised, and the transaction committed, so
	// `query('INSERT …')` reported success having written nothing. The Node
	// backend has always run the same statement through `stmt.execute()`, so
	// the two backends disagreed about whether the row was there.
	if (!columnCount)
	{
		statement->execute(status.ptr(), transaction, inMeta, inBuffer, nullptr, nullptr);

		if (status.failed())
		{
			setErrorFromStatus("could not execute statement", status.ptr());
			return false;
		}

		Status affectedStatus;
		const ISC_UINT64 affected = statement->getAffectedRecords(affectedStatus.ptr());
		// DDL reports no count, which is not a failure — it simply has none.
		g_lastAffectedRows = affectedStatus.failed()
			? 0
			: static_cast<ISC_INT64>(affected);
	}
	else
	{
		std::vector<unsigned char> buffer(shape.messageLength);
		bool firstRow = true;

		const auto appendRow = [&]()
		{
			if (!firstRow)
				json += ',';
			firstRow = false;

			json += '[';
			for (unsigned i = 0; i < columnCount; i++)
			{
				if (i)
					json += ',';

				short nullFlag = 0;
				memcpy(&nullFlag, buffer.data() + shape.nullOffsets[i], sizeof(nullFlag));

				if (nullFlag == -1)
					json += "null";
				else
				{
					appendValue(attachment, transaction, shape.types[i], shape.subTypes[i],
						shape.scales[i], shape.lengths[i], shape.charSets[i],
						buffer.data() + shape.offsets[i],
						json, sink);
				}
			}
			json += ']';
		};

		if (!shape.hasCursor)
		{
			// EXECUTE PROCEDURE: it runs once and fills one row, which is its result.
			statement->execute(status.ptr(), transaction, inMeta, inBuffer,
				shape.metadata, buffer.data());

			if (status.failed())
			{
				setErrorFromStatus("could not execute statement", status.ptr());
				return false;
			}

			appendRow();
		}
		else
		{
			cursor = statement->openCursor(status.ptr(), transaction, inMeta, inBuffer,
				shape.metadata, 0);

			if (status.failed() || !cursor)
			{
				setErrorFromStatus("could not open cursor", status.ptr());
				return false;
			}

			for (;;)
			{
				const int rc = cursor->fetchNext(status.ptr(), buffer.data());

				if (status.failed())
				{
					setErrorFromStatus("fetch failed", status.ptr());
					return false;
				}

				if (rc != IStatus::RESULT_OK)
					break;

				appendRow();
			}
		}
	}

	json += "]}";
	return true;
}

} // anonymous namespace


// ===========================================================================
// C API
// ===========================================================================

extern "C" {

/**
 * Initialise the embedded engine.  Idempotent.
 * Returns 0 on success, non-zero on failure (see fb_last_error()).
 */
FB_WASM_EXPORT
int fb_init(void)
{
	clearError();

	if (g_provider)
		return 0;

#ifdef FB_WASM_STATIC_INTL
	// IntlManager scans <root>/intl for *.conf.  The artifact embeds one at
	// /firebird/intl/fbintl.conf, so the root has to be /firebird before the
	// engine initialises.  Set without overwriting: a host that has already
	// chosen a root means it deliberately.
	setenv("FIREBIRD", "/firebird", 0);
#endif

	g_master = fb_get_master_interface();
	if (!g_master)
	{
		setError("fb_init: fb_get_master_interface() returned null");
		return 1;
	}

	g_util = g_master->getUtilInterface();
	if (!g_util)
	{
		setError("fb_init: no util interface");
		return 2;
	}

	// A normal Firebird build discovers the engine by loading a plugin module
	// from disk.  There is no dynamic loading in a WASM binary, so the engine
	// — which is linked in statically — registers itself here instead.  This
	// is the plugin's own entry point, called directly rather than by the
	// plugin loader; no Firebird source change is involved.
	FB_PLUGIN_ENTRY_POINT(g_master);

	g_provider = locateProvider();
	if (!g_provider)
	{
		setError("fb_init: no Firebird provider available");
		return 3;
	}

	return 0;
}

/** Last error message, or "" when the previous call succeeded. */
FB_WASM_EXPORT
const char* fb_last_error(void)
{
	return g_lastError.c_str();
}

/**
 * Create a new database.
 * Returns a database handle (>0) on success, 0 on failure.
 */
FB_WASM_EXPORT
int fb_create_database(const char* path)
{
	clearError();

	if (!g_provider)
	{
		setError("fb_create_database: engine not initialised — call fb_init() first");
		return 0;
	}

	Status status;
	IXpbBuilder* dpb = buildDpb(status, true);
	if (status.failed() || !dpb)
	{
		setErrorFromStatus("fb_create_database: could not build DPB", status.ptr());
		return 0;
	}

	IAttachment* attachment = g_provider->createDatabase(status.ptr(), path,
		dpb->getBufferLength(status.ptr()), dpb->getBuffer(status.ptr()));

	dpb->dispose();

	if (status.failed() || !attachment)
	{
		setErrorFromStatus("fb_create_database", status.ptr());
		return 0;
	}

	const int handle = g_nextDbHandle++;
	g_databases[handle] = DbEntry{attachment};
	return handle;
}

/**
 * Attach to an existing database.
 * Returns a database handle (>0) on success, 0 on failure.
 */
FB_WASM_EXPORT
int fb_attach_database(const char* path)
{
	clearError();

	if (!g_provider)
	{
		setError("fb_attach_database: engine not initialised — call fb_init() first");
		return 0;
	}

	Status status;
	IXpbBuilder* dpb = buildDpb(status, false);
	if (status.failed() || !dpb)
	{
		setErrorFromStatus("fb_attach_database: could not build DPB", status.ptr());
		return 0;
	}

	IAttachment* attachment = g_provider->attachDatabase(status.ptr(), path,
		dpb->getBufferLength(status.ptr()), dpb->getBuffer(status.ptr()));

	dpb->dispose();

	if (status.failed() || !attachment)
	{
		setErrorFromStatus("fb_attach_database", status.ptr());
		return 0;
	}

	const int handle = g_nextDbHandle++;
	g_databases[handle] = DbEntry{attachment};
	return handle;
}

/**
 * Detach from a database, rolling back any transaction still open on it.
 * Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_detach_database(int db_handle)
{
	clearError();

	const auto it = g_databases.find(db_handle);
	if (it == g_databases.end())
	{
		setError("fb_detach_database: unknown database handle");
		return 1;
	}

	// Transactions outlive the JS objects that started them; leaving one open
	// would keep the attachment alive and the database file locked.  Only this
	// database's: every transaction used to go, so closing one database rolled
	// back work still open on another in the same engine.
	for (auto tx = g_transactions.begin(); tx != g_transactions.end(); )
	{
		if (tx->second.db_handle != db_handle)
		{
			++tx;
			continue;
		}
		Status rollbackStatus;
		tx->second.transaction->rollback(rollbackStatus.ptr());
		tx = g_transactions.erase(tx);
	}

	// Subscriptions hold a queue against this attachment.  Detaching with one
	// outstanding leaves the engine holding a callback into memory that is
	// about to go, so they are cancelled here rather than left to the caller.
	IAttachment* attachment = it->second.attachment;
	for (auto ev = g_events.begin(); ev != g_events.end(); )
	{
		if (ev->second.attachment != attachment)
		{
			++ev;
			continue;
		}

		if (ev->second.queue)
		{
			Status cancelStatus;
			ev->second.queue->cancel(cancelStatus.ptr());
			ev->second.queue->release();
		}
		if (ev->second.subscription)
			ev->second.subscription->release();

		ev = g_events.erase(ev);
	}

	// The kept statements and the shared read transaction belong to this
	// attachment and go before it does.
	flushStatements(it->second);
	endReadTransaction(it->second);

	Status status;
	attachment->detach(status.ptr());
	g_databases.erase(it);

	if (status.failed())
	{
		setErrorFromStatus("fb_detach_database", status.ptr());
		return 2;
	}

	return 0;
}

/**
 * Execute a statement that returns no rows (DDL / DML).
 *
 * `tx_handle` of 0 runs the statement in its own transaction, which is
 * committed on success and rolled back on failure.
 *
 * Returns 0 on success, non-zero on failure.
 */
/* Defined below; fb_execute is the no-parameter case of it. */
FB_WASM_EXPORT
int fb_execute_params(int db_handle, int tx_handle, const char* sql,
	const unsigned char* params, int params_length);

FB_WASM_EXPORT
int fb_execute(int db_handle, int tx_handle, const char* sql)
{
	return fb_execute_params(db_handle, tx_handle, sql, nullptr, 0);
}

/**
 * How many prepared statements each database keeps (64 by default), and
 * returns the previous size.  0 turns the cache off.  Any change empties
 * every database's cache, so it is also the way to drop statements that DDL
 * run through EXECUTE STATEMENT, which the cache cannot see, made stale.
 */
/**
 * The columns of the kept shape `id`, as `{"columns":[...]}`, for a caller of
 * fb_query with FB_QUERY_SHAPE_IDS that has not seen this id or has
 * forgotten it.  Null if no kept statement has that shape any more; asked
 * right after the query that named it, the shape is still there, since the
 * statement that ran is the cache's most recently used.  Free the result with
 * fb_free_result().
 */
FB_WASM_EXPORT
const char* fb_shape_columns(unsigned id)
{
	clearError();
	const auto it = g_shapes.find(id);
	if (it == g_shapes.end())
	{
		setError("fb_shape_columns: unknown shape");
		return nullptr;
	}
	const std::string& header = it->second->header;   // {"columns":[...],"rows":[
	const std::string rowsKey = ",\"rows\":[";
	return allocCString(header.substr(0, header.size() - rowsKey.size()) + "}");
}

FB_WASM_EXPORT
int fb_statement_cache(int size)
{
	const int previous = static_cast<int>(g_statementCacheSize);
	g_statementCacheSize = size < 0 ? 0u : static_cast<unsigned>(size);
	for (auto& db : g_databases)
		flushStatements(db.second);
	return previous;
}

/**
 * Whether a query on this database with a tx_handle of 0 that is a SELECT
 * runs in a read-only transaction the database keeps open (1), or in one of
 * its own committed after it (0, the default).  Returns the previous setting,
 * or -1 for an unknown handle.  Turning it off ends the shared transaction.
 * See "The shared read transaction" above for the two ways it differs.
 */
FB_WASM_EXPORT
int fb_read_transaction(int db_handle, int on)
{
	clearError();

	DbEntry* entry = lookupEntry(db_handle);
	if (!entry)
	{
		setError("fb_read_transaction: unknown database handle");
		return -1;
	}

	const int previous = entry->sharedReads ? 1 : 0;
	entry->sharedReads = on != 0;
	if (!entry->sharedReads)
	{
		endReadTransaction(*entry);
		entry->writers.clear();
	}
	return previous;
}

/**
 * Rows affected by the most recent fb_execute / fb_execute_params.
 *
 * Meaningful for INSERT, UPDATE and DELETE; 0 for DDL and for statements that
 * report nothing.
 */
FB_WASM_EXPORT
double fb_last_affected_rows(void)
{
	// double, not int: JavaScript numbers are doubles anyway, and this keeps
	// counts above 2^31 intact on the way out.
	return static_cast<double>(g_lastAffectedRows);
}

/**
 * Execute a query and return a JSON-encoded result set, or null on failure.
 * The caller owns the returned pointer and must release it with
 * fb_free_result().
 *
 * `tx_handle` of 0 runs the query in its own transaction, committed once the
 * cursor has been drained.
 */
/**
 * Describe a prepared statement without running it.
 *
 * Returns `{"params":[…],"columns":[…],"statementType":N}`, where both arrays
 * carry the same per-field shape the result sets already use. Input parameters
 * have no names in Firebird — they are positional `?` — so their `name` is the
 * empty string rather than an invention.
 *
 * The statement is prepared and dropped. Preparing is not free (the engine
 * parses and plans) but it is the only way to learn a statement's shape, and
 * it is what makes this answerable without side effects: nothing is executed,
 * so describing an `INSERT` inserts nothing.
 */
FB_WASM_EXPORT
const char* fb_describe(int db_handle, int tx_handle, const char* sql)
{
	clearError();

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_describe: unknown database handle");
		return nullptr;
	}

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;

	if (tx_handle)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("fb_describe: unknown transaction handle");
			return nullptr;
		}
	}
	else
	{
		Status status;
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
		if (status.failed() || !transaction)
		{
			setErrorFromStatus("fb_describe: could not start transaction", status.ptr());
			return nullptr;
		}
		ownTransaction = true;
	}

	IStatement*       statement = nullptr;
	IMessageMetadata* inMeta    = nullptr;
	IMessageMetadata* outMeta   = nullptr;

	auto cleanup = [&]()
	{
		if (inMeta)
			inMeta->release();
		if (outMeta)
			outMeta->release();
		if (statement)
			statement->free(Status().ptr());

		if (ownTransaction && transaction)
		{
			// Nothing ran, so there is nothing to commit — but the transaction
			// still has to be finished or it leaks.
			Status s;
			transaction->commit(s.ptr());
			transaction = nullptr;
		}
	};

	Status status;
	statement = attachment->prepare(status.ptr(), transaction, 0, sql, SQL_DIALECT_V6,
		IStatement::PREPARE_PREFETCH_METADATA);

	if (status.failed() || !statement)
	{
		setErrorFromStatus("fb_describe: prepare failed", status.ptr());
		cleanup();
		return nullptr;
	}

	inMeta = statement->getInputMetadata(status.ptr());
	if (status.failed())
	{
		setErrorFromStatus("fb_describe: could not read input metadata", status.ptr());
		cleanup();
		return nullptr;
	}

	outMeta = statement->getOutputMetadata(status.ptr());
	if (status.failed())
	{
		setErrorFromStatus("fb_describe: could not read output metadata", status.ptr());
		cleanup();
		return nullptr;
	}

	const unsigned statementType = statement->getType(status.ptr());
	if (status.failed())
	{
		setErrorFromStatus("fb_describe: could not read statement type", status.ptr());
		cleanup();
		return nullptr;
	}

	std::string json = "{\"params\":";
	if (!describeMetadata(inMeta, json))
	{
		cleanup();
		return nullptr;
	}

	json += ",\"columns\":";
	if (!describeMetadata(outMeta, json))
	{
		cleanup();
		return nullptr;
	}

	char tail[64];
	snprintf(tail, sizeof(tail), ",\"statementType\":%u}", statementType);
	json += tail;

	cleanup();
	return allocCString(json);
}

FB_WASM_EXPORT
const char* fb_query(int db_handle, int tx_handle, const char* sql, int flags)
{
	clearError();

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_query: unknown database handle");
		return nullptr;
	}

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;
	DbEntry* entry = lookupEntry(db_handle);
	bool shared = false;   // in the database's shared read transaction

	// A transaction of its own, committed by cleanup(true).
	auto startOwnTransaction = [&]()
	{
		Status status;
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
		if (status.failed() || !transaction)
		{
			transaction = nullptr;
			setErrorFromStatus("fb_query: could not start transaction", status.ptr());
			return false;
		}
		ownTransaction = true;
		return true;
	};

	if (tx_handle)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("fb_query: unknown transaction handle");
			return nullptr;
		}
	}
	else if (wantsSharedRead(entry, sql) && (transaction = sharedReadTransaction(*entry)))
		shared = true;
	else if (!startOwnTransaction())
		return nullptr;

	// Cleanup helper — the cursor, statement and (optional) transaction must be
	// released on every exit path, including the error ones.
	IResultSet*       cursor    = nullptr;
	IStatement*       statement = nullptr;
	bool              cached    = false;

	// `keep` leaves a kept statement kept although the call failed.
	auto cleanup = [&](bool commit, bool keep = false)
	{
		if (cursor)
		{
			Status s;
			cursor->close(s.ptr());
			cursor->release();
		}
		releaseStatement(db_handle, statement, cached, !commit && !keep);
		if (ownTransaction && transaction)
		{
			Status s;
			if (commit)
				transaction->commit(s.ptr());
			else
				transaction->rollback(s.ptr());
		}
	};

	Status status;
	unsigned type = 0;
	statement = acquireStatement(db_handle, attachment, transaction, sql, status, cached, &type);

	if (status.failed() || !statement)
	{
		setErrorFromStatus("fb_query: prepare failed", status.ptr());
		cleanup(false);
		return nullptr;
	}

	// Only a SELECT reads in the shared transaction: anything else (EXECUTE
	// PROCEDURE, SELECT ... FOR UPDATE) gets one of its own, as before.
	if (shared && type != isc_info_sql_stmt_select)
	{
		shared = false;
		transaction = nullptr;
		if (!startOwnTransaction())
		{
			cleanup(false);
			return nullptr;
		}
	}

	const std::shared_ptr<OutputShape> shape = outputShape(db_handle, statement, cached, "fb_query");
	if (!shape)
	{
		cleanup(false);
		return nullptr;
	}

	BlobSink sink;
	sink.enabled = (flags & FB_QUERY_BINARY_BLOBS) != 0;

	std::string json;
	if (!serialiseCursor(attachment, transaction, statement, *shape,
			nullptr, nullptr, cursor, json, &sink, (flags & FB_QUERY_SHAPE_IDS) != 0))
	{
		if (shared && g_lastErrorReadOnly)
		{
			// A SELECT that writes: again, in a transaction of its own.
			rememberWriter(*entry, sql);
			cleanup(false, true);
			return fb_query(db_handle, 0, sql, flags);
		}
		cleanup(false);
		if (shared)
			endReadTransaction(*entry);   // whatever failed, the next read starts afresh
		return nullptr;
	}

	cleanup(true);
	publishBlobs(sink);

	return allocCString(json);
}

/**
 * Pointer to the binary BLOB side buffer for the most recent query, or 0.
 *
 * Owned by the engine and replaced by the next query, exactly like the error
 * text — read it immediately, and do not free it.  See {@link publishBlobs}
 * for the layout.
 */
FB_WASM_EXPORT
const unsigned char* fb_last_blobs()
{
	return g_lastBlobBuffer;
}

/** Byte length of the buffer {@link fb_last_blobs} points at; 0 when there is none. */
FB_WASM_EXPORT
unsigned fb_last_blobs_size()
{
	return g_lastBlobSize;
}

/** Release a result set returned by fb_query(). */
FB_WASM_EXPORT
void fb_free_result(const char* ptr)
{
	free(const_cast<char*>(ptr));
}

/**
 * Subscribe to one or more Firebird events.
 *
 * @param names  Comma-separated event names, e.g. "notes_changed,tags_changed".
 * @return       A subscription handle, or 0 on failure.
 *
 * Firebird events are posted by the database itself — `POST_EVENT 'name'` in a
 * trigger or stored procedure — and delivered after the posting transaction
 * commits. That is what makes them usable for change notification: a
 * subscriber hears about committed data, never about a write that later rolled
 * back.
 *
 * Delivery is coalescing, not a queue of messages. Ten posts between two polls
 * arrive as a count of ten, and the count is all there is — an event carries no
 * payload. The intended use is "something you care about changed, go look".
 */
FB_WASM_EXPORT
int fb_events_subscribe(int db_handle, const char* names)
{
	g_lastError.clear();

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_events_subscribe: unknown database handle");
		return 0;
	}

	if (!names || !*names)
	{
		setError("fb_events_subscribe: no event names given");
		return 0;
	}

	std::vector<std::string> parsed;
	{
		std::string current;
		for (const char* p = names; ; ++p)
		{
			if (*p == ',' || *p == '\0')
			{
				if (!current.empty())
				{
					// Firebird's event block encodes each name's length in one
					// byte, so a longer name cannot be represented at all.
					if (current.size() > 255)
					{
						setError("fb_events_subscribe: event name longer than 255 bytes");
						return 0;
					}
					parsed.push_back(current);
					current.clear();
				}
				if (*p == '\0')
					break;
			}
			else
			{
				current.push_back(*p);
			}
		}
	}

	if (parsed.empty())
	{
		setError("fb_events_subscribe: no event names given");
		return 0;
	}

	EventEntry entry;
	entry.attachment   = attachment;
	entry.subscription = new EventSubscription(std::move(parsed));

	if (!armEvents(entry))
	{
		entry.subscription->release();
		return 0;
	}

	// Not returning until the baseline is in: anything this attachment posts
	// after the call returns must count as news, and a post that overtook the
	// watcher thread's first delivery would otherwise be folded into it.
	// Nothing on this attachment can post meanwhile, because its caller is
	// here.  The watcher answers in microseconds; the timeout is for a broken
	// engine, where reporting the failure beats a subscription that might
	// silently swallow its first event.
	if (!entry.subscription->waitForBaseline(std::chrono::seconds(10)))
	{
		Status status;
		entry.queue->cancel(status.ptr());
		entry.queue->release();
		entry.subscription->release();
		setError("fb_events_subscribe: the engine never delivered the subscription's baseline");
		return 0;
	}

	const int handle = g_nextEventHandle++;
	g_events[handle] = entry;
	return handle;
}

/**
 * Collect the events that have arrived since the last poll, and re-arm.
 *
 * @return  A JSON object of name → count, owned by the caller until
 *          fb_free_result(); or nullptr on failure.
 *
 * An empty object means nothing fired, which is the common case and is cheap.
 * Re-arming happens here rather than in the callback because the callback runs
 * on an engine thread, and calling back into the engine from it is not
 * something this build should rely on.
 */
FB_WASM_EXPORT
char* fb_events_poll(int event_handle)
{
	g_lastError.clear();

	const auto it = g_events.find(event_handle);
	if (it == g_events.end())
	{
		setError("fb_events_poll: unknown subscription handle");
		return nullptr;
	}

	EventEntry& entry = it->second;

	std::vector<unsigned> deltas;
	bool needsRearm = false;
	entry.subscription->takeDeltas(deltas, needsRearm);

	// Re-arm before reporting.  The other order leaves a window in which an
	// event posts, is counted by the engine, and is not delivered because the
	// queue is still disarmed — the caller would see it only on the poll after
	// next, or not at all if nothing else ever fires.
	if (needsRearm && !armEvents(entry))
		return nullptr;   // armEvents set the error

	std::string json = "{";
	const std::vector<std::string>& names = entry.subscription->names();
	bool first = true;
	for (size_t i = 0; i < names.size(); ++i)
	{
		if (deltas[i] == 0)
			continue;   // report what fired, not the whole subscription

		if (!first)
			json += ',';
		first = false;

		jsonEscape(names[i].c_str(), names[i].size(), json);
		json += ':';
		json += std::to_string(deltas[i]);
	}
	json += '}';

	return allocCString(json);
}

/**
 * Cancel a subscription and release it.
 *
 * Safe to call once per handle; a second call reports an unknown handle rather
 * than tearing down an unrelated subscription that reused the number.
 */
FB_WASM_EXPORT
int fb_events_cancel(int event_handle)
{
	g_lastError.clear();

	const auto it = g_events.find(event_handle);
	if (it == g_events.end())
	{
		setError("fb_events_cancel: unknown subscription handle");
		return 1;
	}

	EventEntry& entry = it->second;

	if (entry.queue)
	{
		Status status;
		entry.queue->cancel(status.ptr());
		entry.queue->release();
		entry.queue = nullptr;
	}

	if (entry.subscription)
	{
		entry.subscription->release();
		entry.subscription = nullptr;
	}

	g_events.erase(it);
	return 0;
}

/**
 * Start a transaction on the given database.
 * Returns a transaction handle (>0) on success, 0 on failure.
 */
FB_WASM_EXPORT
int fb_start_transaction_ex(int db_handle, int isolation, int read_only);

int fb_start_transaction(int db_handle)
{
	// The engine's own defaults, which is what this used to do unconditionally.
	return fb_start_transaction_ex(db_handle, FB_ISOLATION_DEFAULT, 0);
}

/**
 * Start a transaction with an explicit isolation level and access mode.
 *
 * @param isolation  One of the FB_ISOLATION_* values.
 * @param read_only  Non-zero for a read-only transaction.
 *
 * Passing a null transaction parameter buffer — which fb_start_transaction()
 * did for every transaction — silently gives the engine's defaults. That is
 * fine as a default and wrong as the *only* behaviour: the Node backend has
 * always honoured isolationLevel and readOnly, so the same call through the
 * browser backend quietly did something different.
 */
FB_WASM_EXPORT
int fb_start_transaction_ex(int db_handle, int isolation, int read_only)
{
	clearError();

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_start_transaction: unknown database handle");
		return 0;
	}

	Status status;
	ITransaction* transaction = nullptr;

	if (isolation == FB_ISOLATION_DEFAULT && !read_only)
	{
		// Nothing to say, so say nothing: a null TPB is not the same as an
		// empty one, and the engine's default is what the caller asked for.
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
	}
	else
	{
		IXpbBuilder* tpb = g_util->getXpbBuilder(status.ptr(), IXpbBuilder::TPB,
			nullptr, 0);
		if (status.failed() || !tpb)
		{
			setErrorFromStatus("fb_start_transaction: could not build a TPB",
				status.ptr());
			return 0;
		}

		switch (isolation)
		{
		case FB_ISOLATION_READ_COMMITTED:
			tpb->insertTag(status.ptr(), isc_tpb_read_committed);
			// Without a version tag the engine picks one, and which one it
			// picks has changed across releases.  Record versions is the
			// behaviour callers expect from READ COMMITTED.
			tpb->insertTag(status.ptr(), isc_tpb_rec_version);
			break;
		case FB_ISOLATION_SNAPSHOT:
			tpb->insertTag(status.ptr(), isc_tpb_concurrency);
			break;
		case FB_ISOLATION_SNAPSHOT_TABLE_STABILITY:
			tpb->insertTag(status.ptr(), isc_tpb_consistency);
			break;
		case FB_ISOLATION_DEFAULT:
			break;   // read_only alone brought us here
		default:
			tpb->dispose();
			setError("fb_start_transaction: unknown isolation level");
			return 0;
		}

		tpb->insertTag(status.ptr(), read_only ? isc_tpb_read : isc_tpb_write);

		if (status.failed())
		{
			tpb->dispose();
			setErrorFromStatus("fb_start_transaction: could not fill the TPB",
				status.ptr());
			return 0;
		}

		transaction = attachment->startTransaction(status.ptr(),
			tpb->getBufferLength(status.ptr()), tpb->getBuffer(status.ptr()));

		tpb->dispose();
	}

	if (status.failed() || !transaction)
	{
		setErrorFromStatus("fb_start_transaction", status.ptr());
		return 0;
	}

	const int handle = g_nextTxHandle++;
	g_transactions[handle] = TxEntry{transaction, db_handle};
	return handle;
}

/** Commit a transaction.  Returns 0 on success, non-zero on failure. */
FB_WASM_EXPORT
int fb_commit(int tx_handle)
{
	clearError();

	const auto it = g_transactions.find(tx_handle);
	if (it == g_transactions.end())
	{
		setError("fb_commit: unknown transaction handle");
		return 1;
	}

	Status status;
	ITransaction* transaction = it->second.transaction;
	transaction->commit(status.ptr());

	if (status.failed())
	{
		setErrorFromStatus("fb_commit", status.ptr());
		// A failed commit leaves the transaction open.  Roll it back here so
		// that the handle is dead once fb_commit() returns, whatever the
		// outcome — otherwise the caller is left holding a handle whose state
		// it cannot determine, and the attachment cannot be detached.
		Status rollbackStatus;
		transaction->rollback(rollbackStatus.ptr());
		g_transactions.erase(it);
		return 2;
	}

	g_transactions.erase(it);
	return 0;
}

/** Roll a transaction back.  Returns 0 on success, non-zero on failure. */
FB_WASM_EXPORT
int fb_rollback(int tx_handle)
{
	clearError();

	const auto it = g_transactions.find(tx_handle);
	if (it == g_transactions.end())
	{
		setError("fb_rollback: unknown transaction handle");
		return 1;
	}

	Status status;
	it->second.transaction->rollback(status.ptr());
	g_transactions.erase(it);

	if (status.failed())
	{
		setErrorFromStatus("fb_rollback", status.ptr());
		return 2;
	}

	return 0;
}

/**
 * Execute a statement that returns no rows, binding parameters.
 *
 * `params` is the packed buffer described above; pass NULL/0 for none.
 * Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_execute_params(int db_handle, int tx_handle, const char* sql,
	const unsigned char* params, int params_length)
{
	clearError();
	g_lastAffectedRows = 0;

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_execute_params: unknown database handle");
		return 1;
	}

	std::vector<ParamValue> values;
	if (!parseParams(params, static_cast<unsigned>(params_length < 0 ? 0 : params_length),
			values))
	{
		setError("fb_execute_params: malformed parameter buffer");
		return 2;
	}

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;

	if (tx_handle)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("fb_execute_params: unknown transaction handle");
			return 3;
		}
	}
	else
	{
		Status status;
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
		if (status.failed() || !transaction)
		{
			setErrorFromStatus("fb_execute_params: could not start transaction", status.ptr());
			return 4;
		}
		ownTransaction = true;
	}

	Status status;
	bool cached = false;
	IStatement* statement = acquireStatement(db_handle, attachment, transaction, sql, status, cached);

	if (status.failed() || !statement)
	{
		setErrorFromStatus("fb_execute_params: prepare failed", status.ptr());
		if (ownTransaction)
		{
			Status rollbackStatus;
			transaction->rollback(rollbackStatus.ptr());
		}
		return 5;
	}

	InputMessage input;
	input.writeBlobsTo(attachment, transaction);
	const bool bound = input.build(statement, values);

	if (bound)
	{
		statement->execute(status.ptr(), transaction, input.meta(), input.data(),
			nullptr, nullptr);

		if (!status.failed())
		{
			Status affectedStatus;
			const ISC_UINT64 affected = statement->getAffectedRecords(affectedStatus.ptr());
			// A statement that does not report a count is not an error; it
			// simply has none (DDL, for instance).
			g_lastAffectedRows = affectedStatus.failed()
				? 0
				: static_cast<ISC_INT64>(affected);
		}
	}

	releaseStatement(db_handle, statement, cached, !bound || status.failed());

	if (!bound || status.failed())
	{
		if (status.failed())
			setErrorFromStatus("fb_execute_params", status.ptr());

		if (ownTransaction)
		{
			Status rollbackStatus;
			transaction->rollback(rollbackStatus.ptr());
		}
		return 6;
	}

	if (ownTransaction)
	{
		Status commitStatus;
		transaction->commit(commitStatus.ptr());
		if (commitStatus.failed())
		{
			setErrorFromStatus("fb_execute_params: commit failed", commitStatus.ptr());
			return 7;
		}
	}

	return 0;
}

/**
 * Execute one statement once per row of parameters: prepared once, every
 * row's message packed into one buffer and run as one IBatch request, in one
 * transaction.  `rows` is a u32 row count followed by that many parameter
 * buffers (each as fb_execute_params takes one), back to back.
 *
 * With `tx_handle` 0 the rows run in their own transaction, committed when
 * every row went in and rolled back when any failed: a batch is all or
 * nothing.  Inside a caller's transaction the rows before a failure stay, as
 * statements run one by one would, and the caller decides.  The error names
 * the row.  fb_last_affected_rows() then reports the rows affected over the
 * whole batch.
 *
 * Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_execute_batch(int db_handle, int tx_handle, const char* sql,
	const unsigned char* rows, int rows_length)
{
	clearError();
	g_lastAffectedRows = 0;

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_execute_batch: unknown database handle");
		return 1;
	}

	const unsigned length = static_cast<unsigned>(rows_length < 0 ? 0 : rows_length);
	if (!rows || length < 4)
	{
		setError("fb_execute_batch: malformed row buffer");
		return 2;
	}

	unsigned pos = 0;
	const unsigned rowCount = readU32(rows);
	pos += 4;

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;

	if (tx_handle)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("fb_execute_batch: unknown transaction handle");
			return 3;
		}
	}
	else
	{
		Status status;
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
		if (status.failed() || !transaction)
		{
			setErrorFromStatus("fb_execute_batch: could not start transaction", status.ptr());
			return 4;
		}
		ownTransaction = true;
	}

	Status status;
	IStatement* statement = attachment->prepare(status.ptr(), transaction, 0, sql,
		SQL_DIALECT_V6, IStatement::PREPARE_PREFETCH_METADATA);

	if (status.failed() || !statement)
	{
		setErrorFromStatus("fb_execute_batch: prepare failed", status.ptr());
		if (ownTransaction)
		{
			Status rollbackStatus;
			transaction->rollback(rollbackStatus.ptr());
		}
		return 5;
	}

	InputMessage input;
	input.writeBlobsTo(attachment, transaction);
	bool ok = input.describe(statement);
	ISC_INT64 total = 0;
	std::vector<ParamValue> values;

	// Every row's message is packed into one buffer at the metadata's aligned
	// stride and handed to Firebird's IBatch: the rows are one request inside
	// the engine, not one statement execute each (which was measured at 13 %
	// slower than a PSQL loop over the same INSERT).  The completion state
	// carries each row's record count, or the error of the row that failed,
	// at which the batch stops (no TAG_MULTIERROR).
	const unsigned stride = ok ? input.alignedLength() : 0;
	if (ok && input.parameterCount() > 0 && stride == 0)
	{
		setError("fb_execute_batch: could not size the input message");
		ok = false;
	}

	// IBatch takes no blob ids written outside it (its default blob policy
	// is none), so a statement with a BLOB parameter runs once per row, in
	// the same transaction, as one without parameters does.
	if (ok && input.parameterCount() > 0 && !input.hasBlobParameter())
	{
		std::vector<unsigned char> messages;
		messages.reserve(static_cast<size_t>(stride) * rowCount);

		for (unsigned row = 0; ok && row < rowCount; row++)
		{
			if (!parseParamsAt(rows, length, pos, values))
			{
				setError("fb_execute_batch: malformed row buffer");
				ok = false;
				break;
			}

			if (!input.fill(values))
			{
				char context[64];
				snprintf(context, sizeof(context), "fb_execute_batch: row %u: ", row);
				setError(context + g_lastError);
				ok = false;
				break;
			}

			const unsigned char* bytes = static_cast<const unsigned char*>(input.data());
			messages.insert(messages.end(), bytes, bytes + input.size());
			messages.resize(static_cast<size_t>(stride) * (row + 1), 0);   // the alignment padding
		}

		if (ok && rowCount > 0)
		{
			// Record counts back per row, and room for every message: the
			// default budget is 16 MB, the engine's ceiling 256 MB.
			const size_t needed = messages.size() + 4096;
			IXpbBuilder* pb = g_util->getXpbBuilder(status.ptr(), IXpbBuilder::BATCH, nullptr, 0);
			if (!status.failed() && pb)
			{
				pb->insertInt(status.ptr(), IBatch::TAG_RECORD_COUNTS, 1);
				if (needed > 16u * 1024 * 1024)
					pb->insertInt(status.ptr(), IBatch::TAG_BUFFER_BYTES_SIZE,
						static_cast<int>(needed > 256u * 1024 * 1024 ? 256u * 1024 * 1024 : needed));
			}

			IBatch* batch = (status.failed() || !pb) ? nullptr
				: statement->createBatch(status.ptr(), input.meta(),
					pb->getBufferLength(status.ptr()), pb->getBuffer(status.ptr()));
			if (pb)
				pb->dispose();

			if (status.failed() || !batch)
			{
				setErrorFromStatus("fb_execute_batch: could not create the batch", status.ptr());
				ok = false;
			}
			else
			{
				batch->add(status.ptr(), rowCount, messages.data());
				IBatchCompletionState* completion = status.failed() ? nullptr
					: batch->execute(status.ptr(), transaction);

				if (status.failed() || !completion)
				{
					setErrorFromStatus("fb_execute_batch: execute failed", status.ptr());
					ok = false;
				}
				else
				{
					Status infoStatus;
					const unsigned reported = completion->getSize(infoStatus.ptr());
					for (unsigned i = 0; ok && i < reported; i++)
					{
						const int state = completion->getState(infoStatus.ptr(), i);
						if (state >= 0)
							total += state;
						else if (state == IBatchCompletionState::EXECUTE_FAILED)
						{
							Status rowStatus;
							completion->getStatus(infoStatus.ptr(), rowStatus.ptr(), i);
							char context[64];
							snprintf(context, sizeof(context), "fb_execute_batch: row %u", i);
							setErrorFromStatus(context, rowStatus.ptr());
							ok = false;
						}
						// SUCCESS_NO_INFO: executed, no count reported
					}
					completion->dispose();
				}

				Status closeStatus;
				batch->close(closeStatus.ptr());   // releases the batch too
			}
		}
	}
	else
	{
		// A statement without parameters has no message to batch, and one with
		// a BLOB parameter cannot be batched: run it once per row.
		for (unsigned row = 0; ok && row < rowCount; row++)
		{
			if (!parseParamsAt(rows, length, pos, values))
			{
				setError("fb_execute_batch: malformed row buffer");
				ok = false;
				break;
			}

			if (!input.fill(values))
			{
				char context[64];
				snprintf(context, sizeof(context), "fb_execute_batch: row %u: ", row);
				setError(context + g_lastError);
				ok = false;
				break;
			}

			statement->execute(status.ptr(), transaction, input.meta(), input.data(),
				nullptr, nullptr);

			if (status.failed())
			{
				char context[64];
				snprintf(context, sizeof(context), "fb_execute_batch: row %u", row);
				setErrorFromStatus(context, status.ptr());
				ok = false;
				break;
			}

			Status affectedStatus;
			const ISC_UINT64 affected = statement->getAffectedRecords(affectedStatus.ptr());
			if (!affectedStatus.failed())
				total += static_cast<ISC_INT64>(affected);
		}
	}

	{
		Status freeStatus;
		statement->free(freeStatus.ptr());
	}
	statement->release();

	if (!ok)
	{
		if (ownTransaction)
		{
			Status rollbackStatus;
			transaction->rollback(rollbackStatus.ptr());
		}
		return 6;
	}

	g_lastAffectedRows = total;

	if (ownTransaction)
	{
		Status commitStatus;
		transaction->commit(commitStatus.ptr());
		if (commitStatus.failed())
		{
			setErrorFromStatus("fb_execute_batch: commit failed", commitStatus.ptr());
			return 7;
		}
	}

	return 0;
}

/**
 * Execute a query with parameters and return a JSON-encoded result set, or
 * null on failure.  Release the result with fb_free_result().
 */
FB_WASM_EXPORT
const char* fb_query_params(int db_handle, int tx_handle, const char* sql,
	const unsigned char* params, int params_length, int flags)
{
	clearError();

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_query_params: unknown database handle");
		return nullptr;
	}

	std::vector<ParamValue> values;
	if (!parseParams(params, static_cast<unsigned>(params_length < 0 ? 0 : params_length),
			values))
	{
		setError("fb_query_params: malformed parameter buffer");
		return nullptr;
	}

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;
	DbEntry* entry = lookupEntry(db_handle);
	bool shared = false;   // in the database's shared read transaction

	// A transaction of its own, committed by cleanup(true).
	auto startOwnTransaction = [&]()
	{
		Status status;
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
		if (status.failed() || !transaction)
		{
			transaction = nullptr;
			setErrorFromStatus("fb_query_params: could not start transaction", status.ptr());
			return false;
		}
		ownTransaction = true;
		return true;
	};

	if (tx_handle)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("fb_query_params: unknown transaction handle");
			return nullptr;
		}
	}
	else if (wantsSharedRead(entry, sql) && (transaction = sharedReadTransaction(*entry)))
		shared = true;
	else if (!startOwnTransaction())
		return nullptr;

	IResultSet*       cursor    = nullptr;
	IStatement*       statement = nullptr;
	bool              cached    = false;

	// `keep` leaves a kept statement kept although the call failed.
	auto cleanup = [&](bool commit, bool keep = false)
	{
		if (cursor)
		{
			Status s;
			cursor->close(s.ptr());
			cursor->release();
		}
		releaseStatement(db_handle, statement, cached, !commit && !keep);
		if (ownTransaction && transaction)
		{
			Status s;
			if (commit)
				transaction->commit(s.ptr());
			else
				transaction->rollback(s.ptr());
		}
	};

	Status status;
	unsigned type = 0;
	statement = acquireStatement(db_handle, attachment, transaction, sql, status, cached, &type);

	if (status.failed() || !statement)
	{
		setErrorFromStatus("fb_query_params: prepare failed", status.ptr());
		cleanup(false);
		return nullptr;
	}

	// Only a SELECT reads in the shared transaction: anything else (EXECUTE
	// PROCEDURE, SELECT ... FOR UPDATE) gets one of its own, as before.
	if (shared && type != isc_info_sql_stmt_select)
	{
		shared = false;
		transaction = nullptr;
		if (!startOwnTransaction())
		{
			cleanup(false);
			return nullptr;
		}
	}

	InputMessage input;
	input.writeBlobsTo(attachment, transaction);
	if (!input.build(statement, values))
	{
		cleanup(false);
		return nullptr;
	}

	const std::shared_ptr<OutputShape> shape = outputShape(db_handle, statement, cached, "fb_query_params");
	if (!shape)
	{
		cleanup(false);
		return nullptr;
	}

	BlobSink sink;
	sink.enabled = (flags & FB_QUERY_BINARY_BLOBS) != 0;

	std::string json;
	if (!serialiseCursor(attachment, transaction, statement, *shape,
			input.meta(), input.data(), cursor, json, &sink, (flags & FB_QUERY_SHAPE_IDS) != 0))
	{
		if (shared && g_lastErrorReadOnly)
		{
			// A SELECT that writes: again, in a transaction of its own.
			rememberWriter(*entry, sql);
			cleanup(false, true);
			return fb_query_params(db_handle, 0, sql, params, params_length, flags);
		}
		cleanup(false);
		if (shared)
			endReadTransaction(*entry);   // whatever failed, the next read starts afresh
		return nullptr;
	}

	cleanup(true);
	publishBlobs(sink);
	return allocCString(json);
}

} /* extern "C" */
