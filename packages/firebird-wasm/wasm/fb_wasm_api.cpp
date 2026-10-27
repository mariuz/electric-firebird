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
 *     binary BLOB, BINARY,        → base64 string (or bytes beside the JSON,
 *     VARBINARY (OCTETS)            with the side-buffer flag)
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
#include <atomic>
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
extern "C" bool fb_wasm_load_icu_data();
extern "C" bool fb_wasm_register_icu_data(const void* data, unsigned size);
extern "C" int fb_shutdown(unsigned int timeout, const int reason);   // yvalve/why.cpp (ibase.h)
#ifndef fb_shutrsn_app_stopped
#define fb_shutrsn_app_stopped -3   // firebird/impl/consts_pub.h
#endif

namespace {

// ---------------------------------------------------------------------------
// Engine state
// ---------------------------------------------------------------------------

IMaster*   g_master   = nullptr;
IProvider* g_provider = nullptr;
IUtil*     g_util     = nullptr;
/** fb_dispose() has run: the engine is shut down for good in this module. */
bool       g_disposed = false;

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
	std::vector<unsigned char> binaryHeader;   // FBR\x01 + flags=0 + column descriptors
	std::vector<unsigned char> binaryIdHeader; // FBR\x01 + flags=1 + u32 shapeId

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
	bool busy = false;                      // in use by an open cursor or running query
	int handle = 0;                         // explicit handle from fb_prepare (0 if cache-only)
	bool pinned = false;                    // pinned by fb_prepare until fb_stmt_close
};

/** An attached database, and the statements kept prepared for it, most recently used first. */
struct DbEntry
{
	IAttachment* attachment = nullptr;
	std::list<CachedStatement> statements;
	bool sharedReads = false;                  // autocommit SELECTs share readTransaction (fb_read_transaction)
	ITransaction* readTransaction = nullptr;
	std::set<std::string> writers;             // SELECTs that wrote: they get their own transaction
	unsigned long long metadataSeen = 0;       // fb_wasm_metadata_commits when the cache was last checked
	std::string path;                          // database path for sweep attachments
};

/** How many prepared statements each database keeps; 0 turns the cache off (fb_statement_cache). */
unsigned g_statementCacheSize = 64;

/** A started transaction and the database it was started on. */
struct TxEntry
{
	ITransaction* transaction = nullptr;
	int db_handle = 0;
};

/** An open streaming cursor (fb_cursor_open / fb_cursor_fetch / fb_cursor_close). */
struct CursorEntry
{
	int db_handle = 0;
	int tx_handle = 0;
	IAttachment* attachment = nullptr;
	ITransaction* transaction = nullptr;
	bool ownTransaction = false;
	IStatement* statement = nullptr;
	bool cached = false;
	std::shared_ptr<OutputShape> shape;
	IResultSet* cursor = nullptr;
	std::vector<unsigned char> singleRowBuffer;
	bool singleRowPending = false;
	bool eof = false;
	bool failed = false;
};

/** An open streaming BLOB (fb_blob_create / fb_blob_open_* / fb_blob_close). */
struct BlobEntry
{
	int db_handle = 0;
	int tx_handle = 0;
	IAttachment* attachment = nullptr;
	ITransaction* transaction = nullptr;
	bool ownTransaction = false;
	IBlob* blob = nullptr;
	ISC_QUAD blobId = {0, 0};
	bool isRead = false;
	bool eof = false;
};

std::map<int, DbEntry> g_databases;
std::map<int, BlobEntry> g_blobs;
int g_nextBlobHandle = 1;
std::map<int, TxEntry> g_transactions;
std::map<int, CursorEntry> g_cursors;

int g_nextDbHandle = 1;
int g_nextTxHandle = 1;
int g_nextCursorHandle = 1;
int g_nextStmtHandle = 1;

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
//
// DDL the bridge does not run itself (inside EXECUTE STATEMENT, a procedure,
// another attachment) is seen through fb_wasm_metadata_commits, which patch
// 0007 makes the engine count each time a metadata change commits: when it has
// moved since a database last looked, its cache is emptied before a statement
// is taken from it.  Without that, a kept SELECT of a table dropped through
// EXECUTE STATEMENT went on returning the dropped table's rows.

} // namespace

extern std::atomic<unsigned long long> fb_wasm_metadata_commits;   // jrd/CacheVector.cpp, patch 0007

namespace {

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
	{
		bool inUseByCursor = false;
		for (auto& kv : g_cursors)
		{
			if (kv.second.statement == c.statement)
			{
				kv.second.cached = false;
				inUseByCursor = true;
			}
		}
		if (!inUseByCursor)
			freeStatement(c.statement);
	}
	entry.statements.clear();
}

bool purgeIdleCachedStatements()
{
	bool any = false;
	for (auto& dbKv : g_databases)
	{
		auto& stmts = dbKv.second.statements;
		for (auto it = stmts.begin(); it != stmts.end(); )
		{
			bool inUseByCursor = false;
			for (auto& curKv : g_cursors)
			{
				if (curKv.second.statement == it->statement)
				{
					inUseByCursor = true;
					break;
				}
			}
			if (!it->busy && !it->pinned && !inUseByCursor)
			{
				freeStatement(it->statement);
				it = stmts.erase(it);
				any = true;
			}
			else
			{
				++it;
			}
		}
	}
	return any;
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

void noticeMetadataChanges(DbEntry& entry);

/** The database's shared read transaction, started if need be; null if it cannot be. */
ITransaction* sharedReadTransaction(DbEntry& entry)
{
	// Before it is handed out: one begun before DDL it did not see ends here,
	// not under the statement about to run in it.
	noticeMetadataChanges(entry);
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
	purgeIdleCachedStatements();
	endReadTransaction(entry);
	entry.writers.clear();
}

/** DDL committed since this database last looked (fb_wasm_metadata_commits): forget the old metadata. */
void noticeMetadataChanges(DbEntry& entry)
{
	const unsigned long long commits = fb_wasm_metadata_commits.load(std::memory_order_acquire);
	if (commits != entry.metadataSeen)
	{
		forgetMetadata(entry);
		entry.metadataSeen = commits;
	}
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

	if (entry)
		noticeMetadataChanges(*entry);

	if (entry && g_statementCacheSize)
	{
		for (auto it = entry->statements.begin(); it != entry->statements.end(); ++it)
		{
			if (!it->busy && it->sql == sql)
			{
				entry->statements.splice(entry->statements.begin(), entry->statements, it);
				entry->statements.front().busy = true;
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
		entry->statements.push_front(CachedStatement{sql, statement, type, nullptr, true, 0, false});
		cached = true;
		while (entry->statements.size() > g_statementCacheSize)
		{
			auto victim = entry->statements.end();
			for (auto it = entry->statements.end(); it != entry->statements.begin(); )
			{
				--it;
				if (!it->busy && !it->pinned)
				{
					victim = it;
					break;
				}
			}
			if (victim == entry->statements.end())
				break;
			freeStatement(victim->statement);
			entry->statements.erase(victim);
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
	DbEntry* entry = lookupEntry(db_handle);
	if (!entry)
	{
		freeStatement(statement);
		return;
	}
	for (auto it = entry->statements.begin(); it != entry->statements.end(); ++it)
	{
		if (it->statement == statement)
		{
			if (failed)
			{
				freeStatement(statement);
				entry->statements.erase(it);
			}
			else
			{
				it->busy = false;
			}
			return;
		}
	}
	freeStatement(statement);
}

/** Close an open CursorEntry, releasing its IResultSet, statement, and self-owned transaction. */
bool closeCursorEntry(CursorEntry& entry, bool commitOwnTx)
{
	if (entry.cursor)
	{
		Status s;
		entry.cursor->close(s.ptr());
		entry.cursor->release();
		entry.cursor = nullptr;
	}

	releaseStatement(entry.db_handle, entry.statement, entry.cached, entry.failed);
	entry.statement = nullptr;

	if (entry.ownTransaction && entry.transaction)
	{
		ITransaction* tx = entry.transaction;
		entry.transaction = nullptr;
		if (commitOwnTx && !entry.failed)
		{
			Status commitStatus;
			tx->commit(commitStatus.ptr());
			if (commitStatus.failed())
			{
				setErrorFromStatus("fb_cursor_close: commit failed", commitStatus.ptr());
				Status rollbackStatus;
				tx->rollback(rollbackStatus.ptr());
				return false;
			}
		}
		else
		{
			Status rollbackStatus;
			tx->rollback(rollbackStatus.ptr());
		}
	}

	return true;
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

	if (negative)
		out += '-';

	char digits[32];
	const auto written = std::to_chars(digits, digits + sizeof(digits), magnitude);
	const size_t len = static_cast<size_t>(written.ptr - digits);
	const size_t decimals = static_cast<size_t>(-scale);
	if (len <= decimals)
	{
		out += "0.";
		out.append(decimals - len, '0');
		out.append(digits, len);
	}
	else
	{
		const size_t whole = len - decimals;
		out.append(digits, whole);
		out += '.';
		out.append(digits + whole, decimals);
	}
}

/**
 * Firebird's offset time-zone encoding (TimeZoneUtil::ONE_DAY = 24 * 60 - 1):
 * zone ids 0..2878 encode a signed displacement of (zone - 1439) minutes from
 * UTC.  Named zones sit at the top of ISC_USHORT (65535 = GMT downwards).
 */
constexpr unsigned TZ_ONE_DAY = 24 * 60 - 1;
constexpr unsigned TZ_MAX_OFFSET_ID = TZ_ONE_DAY * 2;
constexpr int TICKS_PER_MINUTE = 60 * ISC_TIME_SECONDS_PRECISION;
constexpr int TICKS_PER_DAY = 24 * 3600 * ISC_TIME_SECONDS_PRECISION;

void appendOffsetText(int displacementMinutes, std::string& out)
{
	out += ' ';
	out += displacementMinutes < 0 ? '-' : '+';
	const unsigned absMinutes = static_cast<unsigned>(
		displacementMinutes < 0 ? -displacementMinutes : displacementMinutes);
	appendPadded(absMinutes / 60, 2, out);
	out += ':';
	appendPadded(absMinutes % 60, 2, out);
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

/** RDB$CHARACTER_SETS id of OCTETS, the set of BINARY and VARBINARY. */
constexpr unsigned CHARSET_OCTETS = 1;

/**
 * Append bytes as a binary value: a placeholder for the side buffer when the
 * caller asked for bytes, otherwise a base64 string.
 */
void appendBytes(const std::vector<unsigned char>& bytes, std::string& out, BlobSink* sink)
{
	if (sink && sink->enabled)
	{
		// Out of band: the JSON keeps a reference and the bytes go beside it.
		// The index is the value's position in the side buffer, which is
		// simply how many have been collected so far.
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

	appendBytes(bytes, out, sink);
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
			// OCTETS (BINARY(n), GEN_UUID()) is bytes, not text: as a binary BLOB.
			if ((charSet & 0xff) == CHARSET_OCTETS)
				appendBytes(std::vector<unsigned char>(data, data + length), out, sink);
			else
				jsonEscape(reinterpret_cast<const char*>(data),
					charTextLength(data, length, charSet), out);
			break;

		case SQL_VARYING:
		{
			unsigned short varLength = 0;
			memcpy(&varLength, data, sizeof(varLength));
			if ((charSet & 0xff) == CHARSET_OCTETS)
				appendBytes(std::vector<unsigned char>(data + sizeof(varLength), data + sizeof(varLength) + varLength),
					out, sink);
			else
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
			{
				out += '"';
				out.append(buf, strlen(buf));
				out += '"';
			}
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
				// The shortest text that reads back as this very float, written
				// straight into the result without snprintf.
				char buf[24];
				const auto r = std::to_chars(buf, buf + sizeof(buf), value);
				out.append(buf, r.ptr);
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
			{
				out += '"';
				out.append(buf, strlen(buf));
				out += '"';
			}
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
			{
				out += '"';
				out.append(buf, strlen(buf));
				out += '"';
			}
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
			ISC_TIME_TZ value;
			memcpy(&value, data, sizeof(value));
			unsigned hours = 0, minutes = 0, seconds = 0, fractions = 0;
			if (value.time_zone <= TZ_MAX_OFFSET_ID)
			{
				const int displacement = static_cast<int>(value.time_zone) - static_cast<int>(TZ_ONE_DAY);
				int localTicks = static_cast<int>(value.utc_time) + displacement * TICKS_PER_MINUTE;
				if (localTicks < 0)
					localTicks += TICKS_PER_DAY;
				else if (localTicks >= TICKS_PER_DAY)
					localTicks -= TICKS_PER_DAY;
				decodeTimeOfDay(static_cast<ISC_TIME>(localTicks), hours, minutes, seconds, fractions);
				out += '"';
				appendTimeText(hours, minutes, seconds, fractions, out);
				appendOffsetText(displacement, out);
				out += '"';
				break;
			}
			Status status;
			char zone[64] = {0};
			g_util->decodeTimeTz(status.ptr(), &value, &hours, &minutes, &seconds,
				&fractions, sizeof(zone), zone);
			if (status.failed())
				{ out += "null"; break; }
			out += '"';
			appendTimeText(hours, minutes, seconds, fractions, out);
			out += ' ';
			out += zone;
			out += '"';
			break;
		}

		case SQL_TIMESTAMP_TZ:
		{
			ISC_TIMESTAMP_TZ value;
			memcpy(&value, data, sizeof(value));
			unsigned year = 0, month = 0, day = 0;
			unsigned hours = 0, minutes = 0, seconds = 0, fractions = 0;
			if (value.time_zone <= TZ_MAX_OFFSET_ID)
			{
				const int displacement = static_cast<int>(value.time_zone) - static_cast<int>(TZ_ONE_DAY);
				ISC_DATE localDate = value.utc_timestamp.timestamp_date;
				int localTicks = static_cast<int>(value.utc_timestamp.timestamp_time)
					+ displacement * TICKS_PER_MINUTE;
				if (localTicks < 0)
				{
					localTicks += TICKS_PER_DAY;
					--localDate;
				}
				else if (localTicks >= TICKS_PER_DAY)
				{
					localTicks -= TICKS_PER_DAY;
					++localDate;
				}
				decodeDay(localDate, year, month, day);
				decodeTimeOfDay(static_cast<ISC_TIME>(localTicks), hours, minutes, seconds, fractions);
				out += '"';
				appendDateText(year, month, day, out);
				out += 'T';
				appendTimeText(hours, minutes, seconds, fractions, out);
				appendOffsetText(displacement, out);
				out += '"';
				break;
			}
			Status status;
			char zone[64] = {0};
			g_util->decodeTimeStampTz(status.ptr(), &value, &year, &month, &day,
				&hours, &minutes, &seconds, &fractions, sizeof(zone), zone);
			if (status.failed())
				{ out += "null"; break; }
			out += '"';
			appendDateText(year, month, day, out);
			out += 'T';
			appendTimeText(hours, minutes, seconds, fractions, out);
			out += ' ';
			out += zone;
			out += '"';
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
constexpr unsigned char BINARY_CELL_BOOL    = 1;
constexpr unsigned char BINARY_CELL_INT32   = 2;
constexpr unsigned char BINARY_CELL_FLOAT64 = 3;
constexpr unsigned char BINARY_CELL_UTF8    = 4;
constexpr unsigned char BINARY_CELL_BYTES   = 5;

inline void pushU16LE(std::vector<unsigned char>& out, unsigned v)
{
	out.push_back(static_cast<unsigned char>(v & 0xff));
	out.push_back(static_cast<unsigned char>((v >> 8) & 0xff));
}

inline void pushI16LE(std::vector<unsigned char>& out, int v)
{
	const unsigned u = static_cast<unsigned>(v) & 0xffffu;
	out.push_back(static_cast<unsigned char>(u & 0xff));
	out.push_back(static_cast<unsigned char>((u >> 8) & 0xff));
}

inline void pushU32LE(std::vector<unsigned char>& out, unsigned v)
{
	out.push_back(static_cast<unsigned char>(v & 0xff));
	out.push_back(static_cast<unsigned char>((v >> 8) & 0xff));
	out.push_back(static_cast<unsigned char>((v >> 16) & 0xff));
	out.push_back(static_cast<unsigned char>((v >> 24) & 0xff));
}

inline void pushI32LE(std::vector<unsigned char>& out, int v)
{
	pushU32LE(out, static_cast<unsigned>(v));
}

inline void pushF64LE(std::vector<unsigned char>& out, double v)
{
	unsigned char bytes[8];
	memcpy(bytes, &v, sizeof(bytes));
	out.insert(out.end(), bytes, bytes + sizeof(bytes));
}

inline void pushBinaryUtf8(std::vector<unsigned char>& out, const char* str, size_t len)
{
	out.push_back(BINARY_CELL_UTF8);
	pushU32LE(out, static_cast<unsigned>(len));
	if (len > 0)
		out.insert(out.end(), reinterpret_cast<const unsigned char*>(str),
			reinterpret_cast<const unsigned char*>(str) + len);
}

inline void pushBinaryBytes(std::vector<unsigned char>& out, const unsigned char* bytes, size_t len)
{
	out.push_back(BINARY_CELL_BYTES);
	pushU32LE(out, static_cast<unsigned>(len));
	if (len > 0)
		out.insert(out.end(), bytes, bytes + len);
}

/**
 * Append one non-null column value in binary wire format to `out`.
 * Returns `false` if the value could not be represented (e.g. non-finite float
 * or unreadable BLOB) and the caller should mark the column's null bit instead.
 */
bool appendBinaryValue(IAttachment* attachment, ITransaction* transaction,
	unsigned type, int subType, int scale, unsigned length, unsigned charSet,
	const unsigned char* data, std::vector<unsigned char>& out)
{
	switch (type)
	{
		case SQL_TEXT:
			if ((charSet & 0xff) == CHARSET_OCTETS)
				pushBinaryBytes(out, data, length);
			else
				pushBinaryUtf8(out, reinterpret_cast<const char*>(data),
					charTextLength(data, length, charSet));
			return true;

		case SQL_VARYING:
		{
			unsigned short varLength = 0;
			memcpy(&varLength, data, sizeof(varLength));
			const unsigned char* payload = data + sizeof(varLength);
			if ((charSet & 0xff) == CHARSET_OCTETS)
				pushBinaryBytes(out, payload, varLength);
			else
				pushBinaryUtf8(out, reinterpret_cast<const char*>(payload), varLength);
			return true;
		}

		case SQL_SHORT:
		{
			short value = 0;
			memcpy(&value, data, sizeof(value));
			if (scale)
			{
				std::string s;
				appendScaledDecimal(value, scale, s);
				pushBinaryUtf8(out, s.data(), s.size());
			}
			else
			{
				out.push_back(BINARY_CELL_INT32);
				pushI32LE(out, static_cast<int>(value));
			}
			return true;
		}

		case SQL_LONG:
		{
			ISC_LONG value = 0;
			memcpy(&value, data, sizeof(value));
			if (scale)
			{
				std::string s;
				appendScaledDecimal(value, scale, s);
				pushBinaryUtf8(out, s.data(), s.size());
			}
			else
			{
				out.push_back(BINARY_CELL_INT32);
				pushI32LE(out, static_cast<int>(value));
			}
			return true;
		}

		case SQL_INT64:
		{
			ISC_INT64 value = 0;
			memcpy(&value, data, sizeof(value));
			if (scale)
			{
				std::string s;
				appendScaledDecimal(value, scale, s);
				pushBinaryUtf8(out, s.data(), s.size());
			}
			else if (value >= -2147483648LL && value <= 2147483647LL)
			{
				out.push_back(BINARY_CELL_INT32);
				pushI32LE(out, static_cast<int>(value));
			}
			else if (exactlyRepresentableAsDouble(value))
			{
				out.push_back(BINARY_CELL_FLOAT64);
				pushF64LE(out, static_cast<double>(value));
			}
			else
			{
				std::string s;
				appendInteger(static_cast<long long>(value), s);
				pushBinaryUtf8(out, s.data(), s.size());
			}
			return true;
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
				return false;
			pushBinaryUtf8(out, buf, strlen(buf));
			return true;
		}

		case SQL_FLOAT:
		{
			float value = 0;
			memcpy(&value, data, sizeof(value));
			if (!std::isfinite(value))
				return false;
			out.push_back(BINARY_CELL_FLOAT64);
			pushF64LE(out, static_cast<double>(value));
			return true;
		}

		case SQL_DOUBLE:
		case SQL_D_FLOAT:
		{
			double value = 0;
			memcpy(&value, data, sizeof(value));
			if (!std::isfinite(value))
				return false;
			out.push_back(BINARY_CELL_FLOAT64);
			pushF64LE(out, value);
			return true;
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
				return false;
			pushBinaryUtf8(out, buf, strlen(buf));
			return true;
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
				return false;
			pushBinaryUtf8(out, buf, strlen(buf));
			return true;
		}

		case SQL_BOOLEAN:
			out.push_back(BINARY_CELL_BOOL);
			out.push_back(data[0] ? 1 : 0);
			return true;

		case SQL_TYPE_DATE:
		{
			ISC_DATE value = 0;
			memcpy(&value, data, sizeof(value));
			unsigned year = 0, month = 0, day = 0;
			decodeDay(value, year, month, day);
			std::string s;
			appendDateText(year, month, day, s);
			pushBinaryUtf8(out, s.data(), s.size());
			return true;
		}

		case SQL_TYPE_TIME:
		{
			ISC_TIME value = 0;
			memcpy(&value, data, sizeof(value));
			unsigned hours = 0, minutes = 0, seconds = 0, fractions = 0;
			decodeTimeOfDay(value, hours, minutes, seconds, fractions);
			std::string s;
			appendTimeText(hours, minutes, seconds, fractions, s);
			pushBinaryUtf8(out, s.data(), s.size());
			return true;
		}

		case SQL_TIMESTAMP:
		{
			ISC_TIMESTAMP value;
			memcpy(&value, data, sizeof(value));
			unsigned year = 0, month = 0, day = 0;
			unsigned hours = 0, minutes = 0, seconds = 0, fractions = 0;
			decodeDay(value.timestamp_date, year, month, day);
			decodeTimeOfDay(value.timestamp_time, hours, minutes, seconds, fractions);
			std::string s;
			appendDateText(year, month, day, s);
			s += 'T';
			appendTimeText(hours, minutes, seconds, fractions, s);
			pushBinaryUtf8(out, s.data(), s.size());
			return true;
		}

		case SQL_TIME_TZ:
		{
			ISC_TIME_TZ value;
			memcpy(&value, data, sizeof(value));
			unsigned hours = 0, minutes = 0, seconds = 0, fractions = 0;
			if (value.time_zone <= TZ_MAX_OFFSET_ID)
			{
				const int displacement = static_cast<int>(value.time_zone) - static_cast<int>(TZ_ONE_DAY);
				int localTicks = static_cast<int>(value.utc_time) + displacement * TICKS_PER_MINUTE;
				if (localTicks < 0)
					localTicks += TICKS_PER_DAY;
				else if (localTicks >= TICKS_PER_DAY)
					localTicks -= TICKS_PER_DAY;
				decodeTimeOfDay(static_cast<ISC_TIME>(localTicks), hours, minutes, seconds, fractions);
				std::string s;
				appendTimeText(hours, minutes, seconds, fractions, s);
				appendOffsetText(displacement, s);
				pushBinaryUtf8(out, s.data(), s.size());
				return true;
			}
			Status status;
			char zone[64] = {0};
			g_util->decodeTimeTz(status.ptr(), &value, &hours, &minutes, &seconds,
				&fractions, sizeof(zone), zone);
			if (status.failed())
				return false;
			std::string s;
			appendTimeText(hours, minutes, seconds, fractions, s);
			s += ' ';
			s += zone;
			pushBinaryUtf8(out, s.data(), s.size());
			return true;
		}

		case SQL_TIMESTAMP_TZ:
		{
			ISC_TIMESTAMP_TZ value;
			memcpy(&value, data, sizeof(value));
			unsigned year = 0, month = 0, day = 0;
			unsigned hours = 0, minutes = 0, seconds = 0, fractions = 0;
			if (value.time_zone <= TZ_MAX_OFFSET_ID)
			{
				const int displacement = static_cast<int>(value.time_zone) - static_cast<int>(TZ_ONE_DAY);
				ISC_DATE localDate = value.utc_timestamp.timestamp_date;
				int localTicks = static_cast<int>(value.utc_timestamp.timestamp_time)
					+ displacement * TICKS_PER_MINUTE;
				if (localTicks < 0)
				{
					localTicks += TICKS_PER_DAY;
					--localDate;
				}
				else if (localTicks >= TICKS_PER_DAY)
				{
					localTicks -= TICKS_PER_DAY;
					++localDate;
				}
				decodeDay(localDate, year, month, day);
				decodeTimeOfDay(static_cast<ISC_TIME>(localTicks), hours, minutes, seconds, fractions);
				std::string s;
				appendDateText(year, month, day, s);
				s += 'T';
				appendTimeText(hours, minutes, seconds, fractions, s);
				appendOffsetText(displacement, s);
				pushBinaryUtf8(out, s.data(), s.size());
				return true;
			}
			Status status;
			char zone[64] = {0};
			g_util->decodeTimeStampTz(status.ptr(), &value, &year, &month, &day,
				&hours, &minutes, &seconds, &fractions, sizeof(zone), zone);
			if (status.failed())
				return false;
			std::string s;
			appendDateText(year, month, day, s);
			s += 'T';
			appendTimeText(hours, minutes, seconds, fractions, s);
			s += ' ';
			s += zone;
			pushBinaryUtf8(out, s.data(), s.size());
			return true;
		}

		case SQL_BLOB:
		{
			ISC_QUAD blobId;
			memcpy(&blobId, data, sizeof(blobId));
			Status status;
			IBlob* blob = attachment->openBlob(status.ptr(), transaction, &blobId, 0, nullptr);
			if (status.failed() || !blob)
				return false;

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

			if (subType == 1)
				pushBinaryUtf8(out, reinterpret_cast<const char*>(bytes.data()), bytes.size());
			else
				pushBinaryBytes(out, bytes.data(), bytes.size());
			return true;
		}

		default:
			return false;
	}
}

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
	/** `text` holds bytes, not text: bound only where bytes go (a BLOB, OCTETS). */
	bool          bytes = false;
	bool          isBlobId = false;
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
		value.bytes = (flags & 4) != 0;
		value.isBlobId = (flags & 8) != 0;

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
			fields[i].charSet    = metadata->getCharSet(status.ptr(), i);

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
				if (values[i].isBlobId && values[i].text.size() == sizeof(ISC_QUAD))
					memcpy(&blobId, values[i].text.data(), sizeof(ISC_QUAD));
				else if (!writeBlob(values[i].text, blobId, i))
					return false;
				memcpy(buffer.data() + f.offset, &blobId, sizeof(blobId));
				continue;
			}

			if (values[i].bytes)
			{
				// Bytes go where bytes are kept: a BLOB (above) or a CHAR or
				// VARCHAR in OCTETS (BINARY, VARBINARY).  Anywhere else they
				// would be read as text in the connection's character set.
				const bool octets = (f.type == SQL_TEXT || f.type == SQL_VARYING) && (f.charSet & 0xff) == CHARSET_OCTETS;
				if (!octets)
				{
					char message[160];
					snprintf(message, sizeof(message),
						"parameter %u is binary; bind it to a BLOB or a BINARY/VARBINARY (OCTETS) column", i);
					setError(message);
					return false;
				}

				// No conversion: IUtil::convert reads its source as text in a
				// character set and refused bytes that are not.  The message
				// holds an OCTETS value as the bytes themselves.
				const std::string& bytes = values[i].text;
				if (bytes.size() > f.length)
				{
					char message[160];
					snprintf(message, sizeof(message),
						"parameter %u is %u bytes, longer than its column's %u", i,
						static_cast<unsigned>(bytes.size()), f.length);
					setError(message);
					return false;
				}
				unsigned char* at = buffer.data() + f.offset;
				if (f.type == SQL_VARYING)
				{
					const unsigned short n = static_cast<unsigned short>(bytes.size());
					memcpy(at, &n, sizeof(n));
					memcpy(at + sizeof(n), bytes.data(), bytes.size());
				}
				else
				{
					// BINARY(n) is padded with zero bytes, as Firebird pads it.
					memset(at, 0, f.length);
					memcpy(at, bytes.data(), bytes.size());
				}
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
		unsigned charSet = 0;
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
	std::vector<unsigned char>& binHdr = shape->binaryHeader;
	binHdr = {0x46, 0x42, 0x52, 0x01, 0x00};
	pushU16LE(binHdr, columnCount);

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
		const size_t nameLen = name ? strlen(name) : 0;
		pushU16LE(binHdr, static_cast<unsigned>(nameLen));
		if (nameLen > 0)
			binHdr.insert(binHdr.end(), reinterpret_cast<const unsigned char*>(name),
				reinterpret_cast<const unsigned char*>(name) + nameLen);
		pushU16LE(binHdr, shape->types[i]);
		pushI16LE(binHdr, shape->subTypes[i]);
		pushI16LE(binHdr, shape->scales[i]);
		pushU32LE(binHdr, shape->lengths[i]);
		binHdr.push_back(nullable ? 1 : 0);
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
		shape->binaryIdHeader = {0x46, 0x42, 0x52, 0x01, 0x01};
		pushU32LE(shape->binaryIdHeader, shape->id);
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

bool serialiseCursorBinary(IAttachment* attachment, ITransaction* transaction,
	IStatement* statement, const OutputShape& shape,
	IMessageMetadata* inMeta, void* inBuffer,
	IResultSet*& cursor, std::vector<unsigned char>& out, bool shapeIds = false)
{
	Status status;
	const unsigned columnCount = shape.columnCount;
	const std::vector<unsigned char>& hdr = (shapeIds && shape.id)
		? shape.binaryIdHeader
		: shape.binaryHeader;

	out = hdr;
	const size_t rowCountPos = out.size();
	pushU32LE(out, 0);

	unsigned rowCount = 0;

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
		g_lastAffectedRows = affectedStatus.failed()
			? 0
			: static_cast<ISC_INT64>(affected);
	}
	else
	{
		std::vector<unsigned char> buffer(shape.messageLength);
		const unsigned maskByteLen = (columnCount + 7u) >> 3;

		const auto appendRow = [&]()
		{
			++rowCount;
			const size_t maskPos = out.size();
			out.insert(out.end(), maskByteLen, 0);

			for (unsigned i = 0; i < columnCount; i++)
			{
				short nullFlag = 0;
				memcpy(&nullFlag, buffer.data() + shape.nullOffsets[i], sizeof(nullFlag));

				if (nullFlag == -1 ||
					!appendBinaryValue(attachment, transaction, shape.types[i], shape.subTypes[i],
						shape.scales[i], shape.lengths[i], shape.charSets[i],
						buffer.data() + shape.offsets[i], out))
				{
					out[maskPos + (i >> 3)] |= static_cast<unsigned char>(1u << (i & 7));
				}
			}
		};

		if (!shape.hasCursor)
		{
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

	out[rowCountPos]     = static_cast<unsigned char>(rowCount & 0xff);
	out[rowCountPos + 1] = static_cast<unsigned char>((rowCount >> 8) & 0xff);
	out[rowCountPos + 2] = static_cast<unsigned char>((rowCount >> 16) & 0xff);
	out[rowCountPos + 3] = static_cast<unsigned char>((rowCount >> 24) & 0xff);
	return true;
}

unsigned char* allocBinaryBuffer(const std::vector<unsigned char>& buf, unsigned* out_byte_length)
{
	if (out_byte_length)
		*out_byte_length = static_cast<unsigned>(buf.size());
	const size_t sz = buf.empty() ? 1 : buf.size();
	auto* out = static_cast<unsigned char*>(malloc(sz));
	if (!out)
		return nullptr;
	if (!buf.empty())
		memcpy(out, buf.data(), buf.size());
	return out;
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

	if (g_disposed)
	{
		setError("fb_init: this module's engine was disposed (fb_dispose); load a new module");
		return 4;
	}

	if (g_provider)
		return 0;

#ifdef FB_WASM_STATIC_INTL
	// IntlManager scans <root>/intl for *.conf.  The artifact embeds one at
	// /firebird/intl/fbintl.conf, so the root has to be /firebird before the
	// engine initialises.  Set without overwriting: a host that has already
	// chosen a root means it deliberately.
	setenv("FIREBIRD", "/firebird", 0);
#endif

	// Before anything touches ICU: the engine's UNICODE collations open a
	// collator during database creation, and ICU only reads its data once.
	fb_wasm_load_icu_data();

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

/**
 * Register an optional ICU `.dat` common data bundle (such as a locale
 * tailoring pack for `LOCALE=de_DE`, `es_ES`, `fr_FR`, `ja_JP`) in a second
 * `udata_setCommonData()` slot without increasing the default WASM binary
 * size.  Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_load_icu_data(const unsigned char* data, unsigned size)
{
	clearError();
	if (!data || size == 0)
	{
		setError("fb_load_icu_data: empty ICU data buffer");
		return 1;
	}
	if (!fb_wasm_register_icu_data(data, size))
	{
		setError("fb_load_icu_data: ICU rejected the collation data package");
		return 2;
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
	g_databases[handle].path = path ? path : "";
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
	g_databases[handle].path = path ? path : "";
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

	// Close any streaming cursors still open on this database before rolling
	// back transactions or freeing statements.
	for (auto cur = g_cursors.begin(); cur != g_cursors.end(); )
	{
		if (cur->second.db_handle != db_handle)
		{
			++cur;
			continue;
		}
		closeCursorEntry(cur->second, false);
		cur = g_cursors.erase(cur);
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
 * End the engine for good, before the module is dropped: every database is
 * detached (its transactions rolled back, its events cancelled, as
 * fb_detach_database does), and Firebird is shut down (fb_shutdown), which
 * stops the threads the engine started.  Without it a dropped module took
 * attachments and engine threads with it mid-flight.  After it fb_init()
 * fails: load a new module instead.  Idempotent.
 *
 * Returns 0, or non-zero when a detach or the shutdown failed (see
 * fb_last_error()); the engine is disposed either way.
 */
FB_WASM_EXPORT
int fb_dispose(void)
{
	clearError();
	if (g_disposed)
		return 0;

	int rc = 0;
	std::string firstError;
	std::vector<int> handles;
	for (const auto& db : g_databases)
		handles.push_back(db.first);
	for (int handle : handles)
	{
		if (fb_detach_database(handle) != 0 && !rc)
		{
			rc = 1;
			firstError = g_lastError;
		}
	}

	g_disposed = true;
	if (g_provider && fb_shutdown(5000, fb_shutrsn_app_stopped) != 0 && !rc)
	{
		rc = 2;
		firstError = "fb_dispose: fb_shutdown failed";
	}
	g_provider = nullptr;

	if (rc)
		setError(firstError.c_str());
	else
		clearError();
	return rc;
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
 * every database's cache.  DDL from anywhere empties a database's cache by
 * itself, through fb_metadata_commits().
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

/**
 * How many metadata changes have committed in this process (patch 0007), as a
 * double.  A database's kept statements are emptied when it has moved; plain
 * reads and writes never move it.
 */
FB_WASM_EXPORT
void fb_wasm_purge_cached_statements()
{
	purgeIdleCachedStatements();
}

FB_WASM_EXPORT
double fb_metadata_commits()
{
	return static_cast<double>(fb_wasm_metadata_commits.load(std::memory_order_acquire));
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
const char* fb_prepare(int db_handle, int tx_handle, const char* sql)
{
	clearError();

	DbEntry* entry = lookupEntry(db_handle);
	IAttachment* attachment = entry ? entry->attachment : nullptr;
	if (!attachment)
	{
		setError("fb_prepare: unknown database handle");
		return nullptr;
	}

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;

	if (tx_handle)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("fb_prepare: unknown transaction handle");
			return nullptr;
		}
	}
	else
	{
		Status status;
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
		if (status.failed() || !transaction)
		{
			setErrorFromStatus("fb_prepare: could not start transaction", status.ptr());
			return nullptr;
		}
		ownTransaction = true;
	}

	Status status;
	bool cached = false;
	unsigned statementType = 0;
	IStatement* statement = acquireStatement(db_handle, attachment, transaction, sql, status, cached, &statementType);
	if (status.failed() || !statement)
	{
		setErrorFromStatus("fb_prepare: prepare failed", status.ptr());
		if (ownTransaction && transaction)
		{
			Status s;
			transaction->commit(s.ptr());
		}
		return nullptr;
	}

	IMessageMetadata* inMeta = nullptr;
	IMessageMetadata* outMeta = nullptr;

	auto cleanup = [&](bool failed)
	{
		if (inMeta)
			inMeta->release();
		if (outMeta)
			outMeta->release();

		releaseStatement(db_handle, statement, cached, failed);

		if (ownTransaction && transaction)
		{
			Status s;
			transaction->commit(s.ptr());
			transaction = nullptr;
		}
	};

	inMeta = statement->getInputMetadata(status.ptr());
	if (status.failed())
	{
		setErrorFromStatus("fb_prepare: could not read input metadata", status.ptr());
		cleanup(true);
		return nullptr;
	}

	outMeta = statement->getOutputMetadata(status.ptr());
	if (status.failed())
	{
		setErrorFromStatus("fb_prepare: could not read output metadata", status.ptr());
		cleanup(true);
		return nullptr;
	}

	if (!statementType)
	{
		statementType = statement->getType(status.ptr());
		if (status.failed())
		{
			setErrorFromStatus("fb_prepare: could not read statement type", status.ptr());
			cleanup(true);
			return nullptr;
		}
	}

	int stmtHandle = 0;
	if (entry && cached)
	{
		for (auto& c : entry->statements)
		{
			if (c.statement == statement)
			{
				if (!c.handle)
					c.handle = g_nextStmtHandle++;
				c.pinned = true;
				stmtHandle = c.handle;
				break;
			}
		}
	}

	std::string json = "{\"handle\":";
	appendInteger(stmtHandle, json);
	json += ",\"params\":";
	if (!describeMetadata(inMeta, json))
	{
		cleanup(true);
		return nullptr;
	}

	json += ",\"columns\":";
	if (!describeMetadata(outMeta, json))
	{
		cleanup(true);
		return nullptr;
	}

	char tail[64];
	snprintf(tail, sizeof(tail), ",\"statementType\":%u}", statementType);
	json += tail;

	cleanup(false);
	return allocCString(json);
}

FB_WASM_EXPORT
int fb_stmt_close(int stmt_handle)
{
	clearError();
	if (stmt_handle <= 0)
		return 0;

	for (auto& kv : g_databases)
	{
		DbEntry& entry = kv.second;
		for (auto it = entry.statements.begin(); it != entry.statements.end(); ++it)
		{
			if (it->handle == stmt_handle)
			{
				it->pinned = false;
				it->handle = 0;
				if (!it->busy)
				{
					freeStatement(it->statement);
					entry.statements.erase(it);
				}
				return 0;
			}
		}
	}
	return 0;
}

FB_WASM_EXPORT
const char* fb_explain(int db_handle, int tx_handle, const char* sql, int detailed)
{
	clearError();

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_explain: unknown database handle");
		return nullptr;
	}

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;

	if (tx_handle)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("fb_explain: unknown transaction handle");
			return nullptr;
		}
	}
	else
	{
		Status status;
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
		if (status.failed() || !transaction)
		{
			setErrorFromStatus("fb_explain: could not start transaction", status.ptr());
			return nullptr;
		}
		ownTransaction = true;
	}

	IStatement* statement = nullptr;

	auto cleanup = [&]()
	{
		if (statement)
			statement->free(Status().ptr());

		if (ownTransaction && transaction)
		{
			Status s;
			transaction->commit(s.ptr());
			transaction = nullptr;
		}
	};

	Status status;
	const unsigned prefetchFlags = detailed
		? IStatement::PREPARE_PREFETCH_DETAILED_PLAN
		: IStatement::PREPARE_PREFETCH_LEGACY_PLAN;
	statement = attachment->prepare(status.ptr(), transaction, 0, sql, SQL_DIALECT_V6, prefetchFlags);

	if (status.failed() || !statement)
	{
		setErrorFromStatus("fb_explain: prepare failed", status.ptr());
		cleanup();
		return nullptr;
	}

	const char* rawPlan = statement->getPlan(status.ptr(), detailed ? FB_TRUE : FB_FALSE);
	if (status.failed())
	{
		setErrorFromStatus("fb_explain: could not read execution plan", status.ptr());
		cleanup();
		return nullptr;
	}

	std::string plan = rawPlan ? rawPlan : "";
	while (!plan.empty() && (plan.front() == '\n' || plan.front() == '\r'))
		plan.erase(plan.begin());
	while (!plan.empty() && (plan.back() == '\n' || plan.back() == '\r'))
		plan.pop_back();

	cleanup();
	return allocCString(plan);
}

/**
 * Return database storage, ODS, memory pool, I/O, and OIT/OAT/OST transaction
 * health diagnostics (`IAttachment::getInfo`) as a JSON object.
 *
 * Caller frees the returned buffer with `fb_free_result`.
 */
FB_WASM_EXPORT
const char* fb_database_info(int db_handle)
{
	clearError();

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_database_info: unknown database handle");
		return nullptr;
	}

	constexpr unsigned char INFO_END            = 1;   // isc_info_end
	constexpr unsigned char INFO_TRUNCATED      = 2;   // isc_info_truncated
	constexpr unsigned char INFO_READS          = 5;   // isc_info_reads
	constexpr unsigned char INFO_WRITES         = 6;   // isc_info_writes
	constexpr unsigned char INFO_FETCHES        = 7;   // isc_info_fetches
	constexpr unsigned char INFO_MARKS          = 8;   // isc_info_marks
	constexpr unsigned char INFO_PAGE_SIZE      = 14;  // isc_info_page_size
	constexpr unsigned char INFO_NUM_BUFFERS    = 15;  // isc_info_num_buffers
	constexpr unsigned char INFO_CURRENT_MEMORY = 17;  // isc_info_current_memory
	constexpr unsigned char INFO_MAX_MEMORY     = 18;  // isc_info_max_memory
	constexpr unsigned char INFO_ALLOCATION     = 21;  // isc_info_allocation
	constexpr unsigned char INFO_ODS_VERSION    = 32;  // isc_info_ods_version
	constexpr unsigned char INFO_ODS_MINOR      = 33;  // isc_info_ods_minor_version
	constexpr unsigned char INFO_OLDEST_TX      = 104; // isc_info_oldest_transaction
	constexpr unsigned char INFO_OLDEST_ACTIVE  = 105; // isc_info_oldest_active
	constexpr unsigned char INFO_OLDEST_SNAP    = 106; // isc_info_oldest_snapshot
	constexpr unsigned char INFO_NEXT_TX        = 107; // isc_info_next_transaction

	const unsigned char items[] = {
		INFO_PAGE_SIZE,
		INFO_ALLOCATION,
		INFO_ODS_VERSION,
		INFO_ODS_MINOR,
		INFO_OLDEST_TX,
		INFO_OLDEST_ACTIVE,
		INFO_OLDEST_SNAP,
		INFO_NEXT_TX,
		INFO_CURRENT_MEMORY,
		INFO_MAX_MEMORY,
		INFO_NUM_BUFFERS,
		INFO_READS,
		INFO_WRITES,
		INFO_FETCHES,
		INFO_MARKS
	};

	unsigned char buffer[512] = {};
	Status status;
	attachment->getInfo(status.ptr(), sizeof(items), items, sizeof(buffer), buffer);
	if (status.failed())
	{
		setErrorFromStatus("fb_database_info: getInfo failed", status.ptr());
		return nullptr;
	}

	auto readPortableInt = [](const unsigned char* p, unsigned len) -> long long
	{
		unsigned long long value = 0;
		const unsigned n = len > 8 ? 8 : len;
		for (unsigned i = 0; i < n; i++)
			value |= static_cast<unsigned long long>(p[i]) << (8 * i);
		return static_cast<long long>(value);
	};

	long long pageSize = 0;
	long long allocatedPages = 0;
	long long odsVersion = 0;
	long long odsMinorVersion = 0;
	long long oldestTransaction = 0;
	long long oldestActive = 0;
	long long oldestSnapshot = 0;
	long long nextTransaction = 0;
	long long currentMemory = 0;
	long long maxMemory = 0;
	long long pageBuffers = 0;
	long long reads = 0;
	long long writes = 0;
	long long fetches = 0;
	long long marks = 0;

	size_t pos = 0;
	while (pos < sizeof(buffer))
	{
		const unsigned char tag = buffer[pos++];
		if (tag == 0 || tag == INFO_END || tag == INFO_TRUNCATED)
			break;
		if (pos + 2 > sizeof(buffer))
			break;
		const unsigned len = static_cast<unsigned>(buffer[pos]) |
			(static_cast<unsigned>(buffer[pos + 1]) << 8);
		pos += 2;
		if (pos + len > sizeof(buffer))
			break;
		const long long val = readPortableInt(buffer + pos, len);
		pos += len;

		switch (tag)
		{
			case INFO_PAGE_SIZE:      pageSize = val; break;
			case INFO_ALLOCATION:     allocatedPages = val; break;
			case INFO_ODS_VERSION:    odsVersion = val; break;
			case INFO_ODS_MINOR:      odsMinorVersion = val; break;
			case INFO_OLDEST_TX:      oldestTransaction = val; break;
			case INFO_OLDEST_ACTIVE:  oldestActive = val; break;
			case INFO_OLDEST_SNAP:    oldestSnapshot = val; break;
			case INFO_NEXT_TX:        nextTransaction = val; break;
			case INFO_CURRENT_MEMORY: currentMemory = val; break;
			case INFO_MAX_MEMORY:     maxMemory = val; break;
			case INFO_NUM_BUFFERS:    pageBuffers = val; break;
			case INFO_READS:          reads = val; break;
			case INFO_WRITES:         writes = val; break;
			case INFO_FETCHES:        fetches = val; break;
			case INFO_MARKS:          marks = val; break;
			default: break;
		}
	}

	if (oldestActive <= 0 && oldestTransaction > 0)
		oldestActive = oldestTransaction;
	if (oldestSnapshot <= 0 && oldestActive > 0)
		oldestSnapshot = oldestActive;
	if (nextTransaction <= 0 && oldestActive > 0)
		nextTransaction = oldestActive;

	const long long databaseSizeBytes = pageSize * allocatedPages;
	const long long transactionGap = nextTransaction >= oldestActive
		? (nextTransaction - oldestActive)
		: 0;

	char json[640];
	snprintf(json, sizeof(json),
		"{\"pageSize\":%lld,\"allocatedPages\":%lld,\"databaseSizeBytes\":%lld,"
		"\"odsVersion\":%lld,\"odsMinorVersion\":%lld,"
		"\"oldestTransaction\":%lld,\"oldestActive\":%lld,"
		"\"oldestSnapshot\":%lld,\"nextTransaction\":%lld,\"transactionGap\":%lld,"
		"\"currentMemory\":%lld,\"maxMemory\":%lld,\"pageBuffers\":%lld,"
		"\"reads\":%lld,\"writes\":%lld,\"fetches\":%lld,\"marks\":%lld}",
		pageSize, allocatedPages, databaseSizeBytes,
		odsVersion, odsMinorVersion,
		oldestTransaction, oldestActive,
		oldestSnapshot, nextTransaction, transactionGap,
		currentMemory, maxMemory, pageBuffers,
		reads, writes, fetches, marks);

	return allocCString(json);
}

/**
 * Trigger an immediate database garbage-collection sweep (`isc_dpb_sweep =
 * isc_dpb_records`) on the database identified by `db_handle`, advancing OIT
 * once old record versions have been collected.
 *
 * Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_sweep(int db_handle)
{
	clearError();

	DbEntry* entry = lookupEntry(db_handle);
	if (!entry || !entry->attachment)
	{
		setError("fb_sweep: unknown database handle");
		return 1;
	}

	endReadTransaction(*entry);

	if (entry->path.empty() || !g_provider)
		return 0;

	Status status;
	IXpbBuilder* dpb = buildDpb(status, false);
	if (status.failed() || !dpb)
	{
		setErrorFromStatus("fb_sweep: could not build DPB", status.ptr());
		return 2;
	}

	dpb->insertInt(status.ptr(), isc_dpb_sweep, isc_dpb_records);
	if (status.failed())
	{
		dpb->dispose();
		setErrorFromStatus("fb_sweep: could not set isc_dpb_sweep", status.ptr());
		return 3;
	}

	IAttachment* sweepAttachment = g_provider->attachDatabase(status.ptr(),
		entry->path.c_str(),
		dpb->getBufferLength(status.ptr()),
		dpb->getBuffer(status.ptr()));
	dpb->dispose();

	if (status.failed() || !sweepAttachment)
	{
		setErrorFromStatus("fb_sweep: sweep attach failed", status.ptr());
		return 4;
	}

	Status detachStatus;
	sweepAttachment->detach(detachStatus.ptr());
	return 0;
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

	for (auto cur = g_cursors.begin(); cur != g_cursors.end(); )
	{
		if (cur->second.tx_handle != tx_handle)
		{
			++cur;
			continue;
		}
		closeCursorEntry(cur->second, false);
		cur = g_cursors.erase(cur);
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

	for (auto cur = g_cursors.begin(); cur != g_cursors.end(); )
	{
		if (cur->second.tx_handle != tx_handle)
		{
			++cur;
			continue;
		}
		closeCursorEntry(cur->second, false);
		cur = g_cursors.erase(cur);
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

/**
 * Open a streaming cursor for `sql` (with optional packed `params`).
 *
 * Returns a cursor handle (>0) on success, or 0 on failure (see fb_last_error()).
 * With `tx_handle` of 0 the cursor starts its own transaction, which is
 * committed when `fb_cursor_close()` is called (or rolled back if a fetch
 * failed).  A dedicated transaction rather than the database's shared read
 * transaction is used so that writes or DDL run by the caller between batches
 * cannot end the cursor's transaction mid-stream.
 */
FB_WASM_EXPORT
int fb_cursor_open(int db_handle, int tx_handle, const char* sql,
	const unsigned char* params, int params_length)
{
	clearError();

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_cursor_open: unknown database handle");
		return 0;
	}

	std::vector<ParamValue> values;
	if (!parseParams(params, static_cast<unsigned>(params_length < 0 ? 0 : params_length),
			values))
	{
		setError("fb_cursor_open: malformed parameter buffer");
		return 0;
	}

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;

	if (tx_handle)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("fb_cursor_open: unknown transaction handle");
			return 0;
		}
	}
	else
	{
		Status status;
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
		if (status.failed() || !transaction)
		{
			setErrorFromStatus("fb_cursor_open: could not start transaction", status.ptr());
			return 0;
		}
		ownTransaction = true;
	}

	IResultSet* cursor = nullptr;
	IStatement* statement = nullptr;
	bool cached = false;

	auto cleanupOnError = [&]()
	{
		if (cursor)
		{
			Status s;
			cursor->close(s.ptr());
			cursor->release();
		}
		releaseStatement(db_handle, statement, cached, true);
		if (ownTransaction && transaction)
		{
			Status s;
			transaction->rollback(s.ptr());
		}
	};

	Status status;
	unsigned type = 0;
	statement = acquireStatement(db_handle, attachment, transaction, sql, status, cached, &type);
	if (status.failed() || !statement)
	{
		setErrorFromStatus("fb_cursor_open: prepare failed", status.ptr());
		cleanupOnError();
		return 0;
	}

	InputMessage input;
	IMessageMetadata* inMeta = nullptr;
	void* inBuffer = nullptr;
	if (params && params_length > 0)
	{
		input.writeBlobsTo(attachment, transaction);
		if (!input.build(statement, values))
		{
			cleanupOnError();
			return 0;
		}
		inMeta = input.meta();
		inBuffer = input.data();
	}

	const std::shared_ptr<OutputShape> shape = outputShape(db_handle, statement, cached, "fb_cursor_open");
	if (!shape)
	{
		cleanupOnError();
		return 0;
	}

	CursorEntry entry;
	entry.db_handle = db_handle;
	entry.tx_handle = tx_handle;
	entry.attachment = attachment;
	entry.transaction = transaction;
	entry.ownTransaction = ownTransaction;
	entry.statement = statement;
	entry.cached = cached;
	entry.shape = shape;

	if (!shape->columnCount)
	{
		statement->execute(status.ptr(), transaction, inMeta, inBuffer, nullptr, nullptr);
		if (status.failed())
		{
			setErrorFromStatus("fb_cursor_open: could not execute statement", status.ptr());
			cleanupOnError();
			return 0;
		}

		Status affectedStatus;
		const ISC_UINT64 affected = statement->getAffectedRecords(affectedStatus.ptr());
		g_lastAffectedRows = affectedStatus.failed()
			? 0
			: static_cast<ISC_INT64>(affected);
		entry.eof = true;
	}
	else if (!shape->hasCursor)
	{
		entry.singleRowBuffer.resize(shape->messageLength);
		statement->execute(status.ptr(), transaction, inMeta, inBuffer,
			shape->metadata, entry.singleRowBuffer.data());
		if (status.failed())
		{
			setErrorFromStatus("fb_cursor_open: could not execute statement", status.ptr());
			cleanupOnError();
			return 0;
		}
		entry.singleRowPending = true;
	}
	else
	{
		cursor = statement->openCursor(status.ptr(), transaction, inMeta, inBuffer,
			shape->metadata, 0);
		if (status.failed() || !cursor)
		{
			setErrorFromStatus("fb_cursor_open: could not open cursor", status.ptr());
			cleanupOnError();
			return 0;
		}
		entry.cursor = cursor;
	}

	const int handle = g_nextCursorHandle++;
	g_cursors[handle] = std::move(entry);
	return handle;
}

/**
 * Fetch up to `max_rows` rows from an open cursor and return a JSON-encoded
 * batch (`{"columns":[...],"rows":[...]}` or `{"shape":N,"rows":[...]}`), or
 * nullptr on failure.  When the cursor is exhausted, `rows` is `[]`.
 * Release the returned string with `fb_free_result()`.
 */
FB_WASM_EXPORT
const char* fb_cursor_fetch(int cursor_handle, int max_rows, int flags)
{
	clearError();

	const auto it = g_cursors.find(cursor_handle);
	if (it == g_cursors.end())
	{
		setError("fb_cursor_fetch: unknown cursor handle");
		return nullptr;
	}

	if (max_rows <= 0)
	{
		setError("fb_cursor_fetch: max_rows must be positive");
		return nullptr;
	}

	CursorEntry& entry = it->second;
	const OutputShape& shape = *entry.shape;
	const unsigned columnCount = shape.columnCount;
	const bool shapeIds = (flags & FB_QUERY_SHAPE_IDS) != 0;

	BlobSink sink;
	sink.enabled = (flags & FB_QUERY_BINARY_BLOBS) != 0;

	std::string json = shapeIds && shape.id ? shape.idHeader : shape.header;
	bool firstRow = true;

	const auto appendRowFromBuffer = [&](const unsigned char* buf)
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
			memcpy(&nullFlag, buf + shape.nullOffsets[i], sizeof(nullFlag));

			if (nullFlag == -1)
				json += "null";
			else
			{
				appendValue(entry.attachment, entry.transaction,
					shape.types[i], shape.subTypes[i],
					shape.scales[i], shape.lengths[i], shape.charSets[i],
					buf + shape.offsets[i],
					json, &sink);
			}
		}
		json += ']';
	};

	if (!entry.eof && columnCount > 0)
	{
		if (entry.singleRowPending)
		{
			entry.singleRowPending = false;
			entry.eof = true;
			appendRowFromBuffer(entry.singleRowBuffer.data());
		}
		else if (entry.cursor)
		{
			std::vector<unsigned char> buffer(shape.messageLength);
			for (int fetched = 0; fetched < max_rows; ++fetched)
			{
				Status status;
				const int rc = entry.cursor->fetchNext(status.ptr(), buffer.data());
				if (status.failed())
				{
					entry.failed = true;
					setErrorFromStatus("fb_cursor_fetch: fetch failed", status.ptr());
					return nullptr;
				}
				if (rc != IStatus::RESULT_OK)
				{
					entry.eof = true;
					break;
				}
				appendRowFromBuffer(buffer.data());
			}
		}
		else
		{
			entry.eof = true;
		}
	}
	else
	{
		entry.eof = true;
	}

	json += "]}";
	publishBlobs(sink);
	return allocCString(json);
}

/**
 * Close an open cursor, release its statement, and commit (or roll back on
 * fetch failure) any transaction that `fb_cursor_open` started for itself.
 * Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_cursor_close(int cursor_handle)
{
	clearError();

	const auto it = g_cursors.find(cursor_handle);
	if (it == g_cursors.end())
	{
		setError("fb_cursor_close: unknown cursor handle");
		return 1;
	}

	const bool ok = closeCursorEntry(it->second, true);
	g_cursors.erase(it);
	return ok ? 0 : 2;
}

/** Close an open BlobEntry and release any self-owned transaction. */
static bool closeBlobEntry(BlobEntry& entry, bool cancel)
{
	bool ok = true;
	if (entry.blob)
	{
		Status s;
		if (cancel && !entry.isRead)
			entry.blob->cancel(s.ptr());
		else
			entry.blob->close(s.ptr());
		if (s.failed())
		{
			setErrorFromStatus("fb_blob_close: failed to close blob", s.ptr());
			entry.blob->release();
			ok = false;
		}
		entry.blob = nullptr;
	}
	if (entry.ownTransaction && entry.transaction)
	{
		ITransaction* tx = entry.transaction;
		entry.transaction = nullptr;
		Status txStatus;
		if (!cancel && ok)
			tx->commit(txStatus.ptr());
		else
			tx->rollback(txStatus.ptr());
	}
	return ok;
}

/**
 * Create a new segmented BLOB in `(db_handle, tx_handle)`, writing its 8-byte
 * `ISC_QUAD` identifier into `out_blob_id` (when non-null), and return a
 * positive blob handle (or 0 on failure).
 */
FB_WASM_EXPORT
int fb_blob_create(int db_handle, int tx_handle, unsigned char* out_blob_id)
{
	clearError();
	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_blob_create: unknown database handle");
		return 0;
	}

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;
	if (tx_handle != 0)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("unknown transaction handle");
			return 0;
		}
		if (!transaction)
			return 0;
	}
	else
	{
		Status txStatus;
		transaction = attachment->startTransaction(txStatus.ptr(), 0, nullptr);
		if (txStatus.failed() || !transaction)
		{
			setErrorFromStatus("fb_blob_create: startTransaction failed", txStatus.ptr());
			return 0;
		}
		ownTransaction = true;
	}

	Status status;
	ISC_QUAD blobId = {0, 0};
	IBlob* blob = attachment->createBlob(status.ptr(), transaction, &blobId, 0, nullptr);
	if (status.failed() || !blob)
	{
		setErrorFromStatus("fb_blob_create: createBlob failed", status.ptr());
		if (ownTransaction && transaction)
		{
			Status rb;
			transaction->rollback(rb.ptr());
		}
		return 0;
	}

	if (out_blob_id)
		memcpy(out_blob_id, &blobId, sizeof(ISC_QUAD));

	BlobEntry entry;
	entry.db_handle = db_handle;
	entry.tx_handle = tx_handle;
	entry.attachment = attachment;
	entry.transaction = transaction;
	entry.ownTransaction = ownTransaction;
	entry.blob = blob;
	entry.blobId = blobId;
	entry.isRead = false;
	entry.eof = false;

	const int handle = g_nextBlobHandle++;
	g_blobs[handle] = entry;
	return handle;
}

/**
 * Write `length` bytes from `data` into an open writable BLOB handle via
 * `IBlob::putSegment`. Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_blob_put_segment(int blob_handle, const unsigned char* data, unsigned length)
{
	clearError();
	const auto it = g_blobs.find(blob_handle);
	if (it == g_blobs.end() || it->second.isRead || !it->second.blob)
	{
		setError("fb_blob_put_segment: invalid writable blob handle");
		return 1;
	}
	if (length == 0)
		return 0;

	BlobEntry& entry = it->second;
	Status status;
	constexpr unsigned MAX_SEG = 32768;
	for (unsigned at = 0; at < length; at += MAX_SEG)
	{
		const unsigned n = std::min(MAX_SEG, length - at);
		entry.blob->putSegment(status.ptr(), n, data + at);
		if (status.failed())
		{
			setErrorFromStatus("fb_blob_put_segment: putSegment failed", status.ptr());
			return 2;
		}
	}
	return 0;
}

/**
 * Open an existing BLOB by its 8-byte `ISC_QUAD` identifier (`blob_id_ptr`)
 * for segmented reading via `fb_blob_get_segment`. Returns a positive blob
 * handle, or 0 on failure.
 */
FB_WASM_EXPORT
int fb_blob_open_id(int db_handle, int tx_handle, const unsigned char* blob_id_ptr)
{
	clearError();
	if (!blob_id_ptr)
	{
		setError("fb_blob_open_id: null blob_id_ptr");
		return 0;
	}
	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_blob_open_id: unknown database handle");
		return 0;
	}

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;
	if (tx_handle != 0)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("unknown transaction handle");
			return 0;
		}
		if (!transaction)
			return 0;
	}
	else
	{
		Status txStatus;
		transaction = attachment->startTransaction(txStatus.ptr(), 0, nullptr);
		if (txStatus.failed() || !transaction)
		{
			setErrorFromStatus("fb_blob_open_id: startTransaction failed", txStatus.ptr());
			return 0;
		}
		ownTransaction = true;
	}

	ISC_QUAD blobId = {0, 0};
	memcpy(&blobId, blob_id_ptr, sizeof(ISC_QUAD));

	Status status;
	IBlob* blob = attachment->openBlob(status.ptr(), transaction, &blobId, 0, nullptr);
	if (status.failed() || !blob)
	{
		setErrorFromStatus("fb_blob_open_id: openBlob failed", status.ptr());
		if (ownTransaction && transaction)
		{
			Status rb;
			transaction->rollback(rb.ptr());
		}
		return 0;
	}

	BlobEntry entry;
	entry.db_handle = db_handle;
	entry.tx_handle = tx_handle;
	entry.attachment = attachment;
	entry.transaction = transaction;
	entry.ownTransaction = ownTransaction;
	entry.blob = blob;
	entry.blobId = blobId;
	entry.isRead = true;
	entry.eof = false;

	const int handle = g_nextBlobHandle++;
	g_blobs[handle] = entry;
	return handle;
}

/**
 * Execute `sql` (with optional packed `param_buf`), extract the 8-byte
 * `ISC_QUAD` from column `col_index` of the first row without materializing
 * the BLOB in memory, and open an `IBlob` reader handle for `fb_blob_get_segment`.
 * Returns a positive blob handle, or 0 on failure.
 */
FB_WASM_EXPORT
int fb_blob_open_query(int db_handle, int tx_handle, const char* sql,
	const unsigned char* param_buf, unsigned param_len, int col_index)
{
	clearError();
	if (!sql || !*sql)
	{
		setError("fb_blob_open_query: empty SQL");
		return 0;
	}
	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_blob_open_query: unknown database handle");
		return 0;
	}

	std::vector<ParamValue> params;
	if (!parseParams(param_buf, param_len, params))
	{
		setError("fb_blob_open_query: malformed parameter buffer");
		return 0;
	}

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;
	if (tx_handle != 0)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("unknown transaction handle");
			return 0;
		}
		if (!transaction)
			return 0;
	}
	else
	{
		Status txStatus;
		transaction = attachment->startTransaction(txStatus.ptr(), 0, nullptr);
		if (txStatus.failed() || !transaction)
		{
			setErrorFromStatus("fb_blob_open_query: startTransaction failed", txStatus.ptr());
			return 0;
		}
		ownTransaction = true;
	}

	Status status;
	bool cached = false;
	unsigned stmtType = 0;
	IStatement* statement = acquireStatement(db_handle, attachment, transaction, sql, status, cached, &stmtType);
	if (status.failed() || !statement)
	{
		setErrorFromStatus("fb_blob_open_query: prepare failed", status.ptr());
		if (ownTransaction && transaction)
		{
			Status rb;
			transaction->rollback(rb.ptr());
		}
		return 0;
	}

	InputMessage input;
	input.writeBlobsTo(attachment, transaction);
	if (!params.empty() && !input.build(statement, params))
	{
		releaseStatement(db_handle, statement, cached, false);
		if (ownTransaction && transaction)
		{
			Status rb;
			transaction->rollback(rb.ptr());
		}
		return 0;
	}

	std::shared_ptr<OutputShape> shape = outputShape(db_handle, statement, cached, "fb_blob_open_query");
	if (!shape || shape->columnCount == 0)
	{
		releaseStatement(db_handle, statement, cached, true);
		if (ownTransaction && transaction)
		{
			Status rb;
			transaction->rollback(rb.ptr());
		}
		setError("openBlobStream: query does not return any columns");
		return 0;
	}

	if (col_index < 0 || static_cast<unsigned>(col_index) >= shape->columnCount)
	{
		releaseStatement(db_handle, statement, cached, false);
		if (ownTransaction && transaction)
		{
			Status rb;
			transaction->rollback(rb.ptr());
		}
		setError("openBlobStream: column index out of range");
		return 0;
	}

	const unsigned idx = static_cast<unsigned>(col_index);
	if (shape->types[idx] != SQL_BLOB)
	{
		releaseStatement(db_handle, statement, cached, false);
		if (ownTransaction && transaction)
		{
			Status rb;
			transaction->rollback(rb.ptr());
		}
		setError("openBlobStream: selected column is not a BLOB");
		return 0;
	}

	IResultSet* rs = statement->openCursor(status.ptr(), transaction,
		input.meta(), input.data(), shape->metadata, 0);
	if (status.failed() || !rs)
	{
		setErrorFromStatus("fb_blob_open_query: openCursor failed", status.ptr());
		releaseStatement(db_handle, statement, cached, true);
		if (ownTransaction && transaction)
		{
			Status rb;
			transaction->rollback(rb.ptr());
		}
		return 0;
	}

	std::vector<unsigned char> rowBuf(shape->messageLength);
	const int rc = rs->fetchNext(status.ptr(), rowBuf.data());
	Status closeRsStatus;
	rs->close(closeRsStatus.ptr());
	rs->release();
	releaseStatement(db_handle, statement, cached, status.failed());

	if (status.failed())
	{
		setErrorFromStatus("fb_blob_open_query: fetchNext failed", status.ptr());
		if (ownTransaction && transaction)
		{
			Status rb;
			transaction->rollback(rb.ptr());
		}
		return 0;
	}
	if (rc != IStatus::RESULT_OK)
	{
		if (ownTransaction && transaction)
		{
			Status rb;
			transaction->rollback(rb.ptr());
		}
		setError("openBlobStream: query returned no rows");
		return 0;
	}

	short nullFlag = 0;
	memcpy(&nullFlag, rowBuf.data() + shape->nullOffsets[idx], sizeof(nullFlag));
	if (nullFlag == -1)
	{
		if (ownTransaction && transaction)
		{
			Status rb;
			transaction->rollback(rb.ptr());
		}
		setError("openBlobStream: BLOB column value is NULL");
		return 0;
	}

	ISC_QUAD blobId = {0, 0};
	memcpy(&blobId, rowBuf.data() + shape->offsets[idx], sizeof(ISC_QUAD));

	IBlob* blob = attachment->openBlob(status.ptr(), transaction, &blobId, 0, nullptr);
	if (status.failed() || !blob)
	{
		setErrorFromStatus("fb_blob_open_query: openBlob failed", status.ptr());
		if (ownTransaction && transaction)
		{
			Status rb;
			transaction->rollback(rb.ptr());
		}
		return 0;
	}

	BlobEntry entry;
	entry.db_handle = db_handle;
	entry.tx_handle = tx_handle;
	entry.attachment = attachment;
	entry.transaction = transaction;
	entry.ownTransaction = ownTransaction;
	entry.blob = blob;
	entry.blobId = blobId;
	entry.isRead = true;
	entry.eof = false;

	const int handle = g_nextBlobHandle++;
	g_blobs[handle] = entry;
	return handle;
}

/**
 * Read up to `max_len` bytes from an open BLOB handle into `out_buf` and store
 * the number of bytes read into `*actual_len_out`.
 * Returns:
 *   0 when `> 0` bytes were read,
 *   1 when EOF has been reached (`*actual_len_out == 0`),
 *  -1 on error.
 */
FB_WASM_EXPORT
int fb_blob_get_segment(int blob_handle, unsigned char* out_buf, unsigned max_len, unsigned* actual_len_out)
{
	clearError();
	if (actual_len_out)
		*actual_len_out = 0;

	const auto it = g_blobs.find(blob_handle);
	if (it == g_blobs.end() || !it->second.isRead || !it->second.blob)
	{
		setError("fb_blob_get_segment: invalid readable blob handle");
		return -1;
	}
	if (!out_buf || max_len == 0)
	{
		setError("fb_blob_get_segment: invalid output buffer");
		return -1;
	}

	BlobEntry& entry = it->second;
	if (entry.eof)
		return 1;

	unsigned total = 0;
	Status status;
	while (total < max_len && !entry.eof)
	{
		unsigned segLen = 0;
		const unsigned chunkCap = std::min<unsigned>(32768u, max_len - total);
		const int rc = entry.blob->getSegment(status.ptr(), chunkCap, out_buf + total, &segLen);
		if (status.failed())
		{
			setErrorFromStatus("fb_blob_get_segment: getSegment failed", status.ptr());
			return -1;
		}
		total += segLen;
		if (rc == IStatus::RESULT_NO_DATA)
		{
			entry.eof = true;
			break;
		}
	}

	if (actual_len_out)
		*actual_len_out = total;

	return (total == 0 && entry.eof) ? 1 : 0;
}

/**
 * Close (or cancel when `cancel != 0`) an open BLOB handle. If `out_blob_id`
 * is non-null, copies the 8-byte `ISC_QUAD` into `out_blob_id`.
 * Returns 0 on success, non-zero on failure.
 */
FB_WASM_EXPORT
int fb_blob_close(int blob_handle, int cancel, unsigned char* out_blob_id)
{
	clearError();
	const auto it = g_blobs.find(blob_handle);
	if (it == g_blobs.end())
	{
		setError("fb_blob_close: unknown blob handle");
		return 1;
	}

	if (out_blob_id)
		memcpy(out_blob_id, &it->second.blobId, sizeof(ISC_QUAD));

	const bool ok = closeBlobEntry(it->second, cancel != 0);
	g_blobs.erase(it);
	return ok ? 0 : 2;
}

/**
 * Run a parameterised query (`params` may be null/empty) and return a packed
 * binary result buffer (`FBR\x01`), storing its byte length in `*out_byte_length`.
 * Returns nullptr on failure. Free the returned buffer with `fb_free_result()`.
 */
FB_WASM_EXPORT
const unsigned char* fb_query_binary(int db_handle, int tx_handle, const char* sql,
	const unsigned char* params, int params_length, int flags, unsigned* out_byte_length)
{
	clearError();
	if (out_byte_length)
		*out_byte_length = 0;

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_query_binary: unknown database handle");
		return nullptr;
	}

	std::vector<ParamValue> values;
	if (!parseParams(params, static_cast<unsigned>(params_length < 0 ? 0 : params_length),
			values))
	{
		setError("fb_query_binary: malformed parameter buffer");
		return nullptr;
	}

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;
	DbEntry* entry = lookupEntry(db_handle);
	bool shared = false;

	auto startOwnTransaction = [&]()
	{
		Status status;
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
		if (status.failed() || !transaction)
		{
			transaction = nullptr;
			setErrorFromStatus("fb_query_binary: could not start transaction", status.ptr());
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
			setError("fb_query_binary: unknown transaction handle");
			return nullptr;
		}
	}
	else if (wantsSharedRead(entry, sql) && (transaction = sharedReadTransaction(*entry)))
		shared = true;
	else if (!startOwnTransaction())
		return nullptr;

	IResultSet* cursor = nullptr;
	IStatement* statement = nullptr;
	bool cached = false;

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
		setErrorFromStatus("fb_query_binary: prepare failed", status.ptr());
		cleanup(false);
		return nullptr;
	}

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
	IMessageMetadata* inMeta = nullptr;
	void* inBuffer = nullptr;
	if (!values.empty())
	{
		input.writeBlobsTo(attachment, transaction);
		if (!input.build(statement, values))
		{
			cleanup(false);
			return nullptr;
		}
		inMeta = input.meta();
		inBuffer = input.data();
	}

	const std::shared_ptr<OutputShape> shape = outputShape(db_handle, statement, cached, "fb_query_binary");
	if (!shape)
	{
		cleanup(false);
		return nullptr;
	}

	std::vector<unsigned char> binary;
	if (!serialiseCursorBinary(attachment, transaction, statement, *shape,
			inMeta, inBuffer, cursor, binary, (flags & FB_QUERY_SHAPE_IDS) != 0))
	{
		if (shared && g_lastErrorReadOnly)
		{
			rememberWriter(*entry, sql);
			cleanup(false, true);
			return fb_query_binary(db_handle, 0, sql, params, params_length, flags, out_byte_length);
		}
		cleanup(false);
		if (shared)
			endReadTransaction(*entry);
		return nullptr;
	}

	cleanup(true);
	return allocBinaryBuffer(binary, out_byte_length);
}

/**
 * Fetch up to `max_rows` rows from an open cursor and return a packed binary
 * result buffer (`FBR\x01`), storing its byte length in `*out_byte_length`.
 * Returns nullptr on failure. Free the returned buffer with `fb_free_result()`.
 */
FB_WASM_EXPORT
const unsigned char* fb_cursor_fetch_binary(int cursor_handle, int max_rows, int flags,
	unsigned* out_byte_length)
{
	clearError();
	if (out_byte_length)
		*out_byte_length = 0;

	const auto it = g_cursors.find(cursor_handle);
	if (it == g_cursors.end())
	{
		setError("fb_cursor_fetch_binary: unknown cursor handle");
		return nullptr;
	}

	if (max_rows <= 0)
	{
		setError("fb_cursor_fetch_binary: max_rows must be positive");
		return nullptr;
	}

	CursorEntry& entry = it->second;
	const OutputShape& shape = *entry.shape;
	const unsigned columnCount = shape.columnCount;
	const bool shapeIds = (flags & FB_QUERY_SHAPE_IDS) != 0;

	std::vector<unsigned char> out = (shapeIds && shape.id)
		? shape.binaryIdHeader
		: shape.binaryHeader;
	const size_t rowCountPos = out.size();
	pushU32LE(out, 0);

	unsigned rowCount = 0;
	const unsigned maskByteLen = (columnCount + 7u) >> 3;

	const auto appendRowFromBuffer = [&](const unsigned char* buf)
	{
		++rowCount;
		const size_t maskPos = out.size();
		out.insert(out.end(), maskByteLen, 0);

		for (unsigned i = 0; i < columnCount; i++)
		{
			short nullFlag = 0;
			memcpy(&nullFlag, buf + shape.nullOffsets[i], sizeof(nullFlag));

			if (nullFlag == -1 ||
				!appendBinaryValue(entry.attachment, entry.transaction,
					shape.types[i], shape.subTypes[i],
					shape.scales[i], shape.lengths[i], shape.charSets[i],
					buf + shape.offsets[i], out))
			{
				out[maskPos + (i >> 3)] |= static_cast<unsigned char>(1u << (i & 7));
			}
		}
	};

	if (!entry.eof && columnCount > 0)
	{
		if (entry.singleRowPending)
		{
			entry.singleRowPending = false;
			entry.eof = true;
			appendRowFromBuffer(entry.singleRowBuffer.data());
		}
		else if (entry.cursor)
		{
			std::vector<unsigned char> buffer(shape.messageLength);
			for (int fetched = 0; fetched < max_rows; ++fetched)
			{
				Status status;
				const int rc = entry.cursor->fetchNext(status.ptr(), buffer.data());
				if (status.failed())
				{
					entry.failed = true;
					setErrorFromStatus("fb_cursor_fetch_binary: fetch failed", status.ptr());
					return nullptr;
				}
				if (rc != IStatus::RESULT_OK)
				{
					entry.eof = true;
					break;
				}
				appendRowFromBuffer(buffer.data());
			}
		}
		else
		{
			entry.eof = true;
		}
	}
	else
	{
		entry.eof = true;
	}

	out[rowCountPos]     = static_cast<unsigned char>(rowCount & 0xff);
	out[rowCountPos + 1] = static_cast<unsigned char>((rowCount >> 8) & 0xff);
	out[rowCountPos + 2] = static_cast<unsigned char>((rowCount >> 16) & 0xff);
	out[rowCountPos + 3] = static_cast<unsigned char>((rowCount >> 24) & 0xff);
	return allocBinaryBuffer(out, out_byte_length);
}

} /* extern "C" */
