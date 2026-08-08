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

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
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

/** An attached database plus the transaction used for auto-commit work. */
struct DbEntry
{
	IAttachment* attachment = nullptr;
};

std::map<int, DbEntry>       g_databases;
std::map<int, ITransaction*> g_transactions;

int g_nextDbHandle = 1;
int g_nextTxHandle = 1;

std::string g_lastError;

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
}

/** Turn an IStatus carrying errors into readable text. */
void setErrorFromStatus(const char* context, IStatus* status)
{
	char buffer[2048];
	buffer[0] = '\0';

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
	return it == g_transactions.end() ? nullptr : it->second;
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
void appendScaledDecimal(ISC_INT64 value, int scale, std::string& out)
{
	if (scale >= 0)
	{
		// Positive scale means the stored value must be multiplied by 10^scale.
		char buf[32];
		snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(value));
		out += buf;
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
	const int written = snprintf(digits, sizeof(digits), "%llu", magnitude);
	std::string text(digits, written > 0 ? static_cast<size_t>(written) : 0);

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
	char buf[32];
	snprintf(buf, sizeof(buf), "%02u:%02u:%02u.%04u",
		hours, minutes, seconds, fractions);
	out += buf;
}

void appendDateText(unsigned year, unsigned month, unsigned day, std::string& out)
{
	char buf[16];
	snprintf(buf, sizeof(buf), "%04u-%02u-%02u", year, month, day);
	out += buf;
}

/** Read a text or binary BLOB in full and append it as a JSON string. */
void appendBlob(IAttachment* attachment, ITransaction* transaction,
	ISC_QUAD* blobId, int subType, std::string& out)
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
		jsonEscape(reinterpret_cast<const char*>(bytes.data()), bytes.size(), out);
	else
	{
		out += '"';
		base64Encode(bytes, out);
		out += '"';
	}
}

/**
 * Append one column value, already located inside the fetched message buffer,
 * as JSON.
 */
void appendValue(IAttachment* attachment, ITransaction* transaction,
	unsigned type, int subType, int scale, unsigned length,
	const unsigned char* data, std::string& out)
{
	switch (type)
	{
		case SQL_TEXT:
			jsonEscape(reinterpret_cast<const char*>(data), length, out);
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
			{
				char buf[16];
				snprintf(buf, sizeof(buf), "%d", static_cast<int>(value));
				out += buf;
			}
			break;
		}

		case SQL_LONG:
		{
			ISC_LONG value = 0;
			memcpy(&value, data, sizeof(value));
			if (scale)
				{ out += '"'; appendScaledDecimal(value, scale, out); out += '"'; }
			else
			{
				char buf[16];
				snprintf(buf, sizeof(buf), "%d", static_cast<int>(value));
				out += buf;
			}
			break;
		}

		case SQL_INT64:
		{
			ISC_INT64 value = 0;
			memcpy(&value, data, sizeof(value));
			if (scale)
				{ out += '"'; appendScaledDecimal(value, scale, out); out += '"'; }
			else if (exactlyRepresentableAsDouble(value))
			{
				char buf[32];
				snprintf(buf, sizeof(buf), "%lld", static_cast<long long>(value));
				out += buf;
			}
			else
			{
				// Emitting a JSON number here would silently round the value.
				char buf[32];
				snprintf(buf, sizeof(buf), "\"%lld\"", static_cast<long long>(value));
				out += buf;
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
				char buf[32];
				snprintf(buf, sizeof(buf), "%.17g", value);
				out += buf;
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
			g_util->decodeDate(value, &year, &month, &day);
			std::string text;
			appendDateText(year, month, day, text);
			jsonEscape(text, out);
			break;
		}

		case SQL_TYPE_TIME:
		{
			ISC_TIME value = 0;
			memcpy(&value, data, sizeof(value));
			unsigned hours = 0, minutes = 0, seconds = 0, fractions = 0;
			g_util->decodeTime(value, &hours, &minutes, &seconds, &fractions);
			std::string text;
			appendTimeText(hours, minutes, seconds, fractions, text);
			jsonEscape(text, out);
			break;
		}

		case SQL_TIMESTAMP:
		{
			ISC_TIMESTAMP value;
			memcpy(&value, data, sizeof(value));
			unsigned year = 0, month = 0, day = 0;
			unsigned hours = 0, minutes = 0, seconds = 0, fractions = 0;
			g_util->decodeDate(value.timestamp_date, &year, &month, &day);
			g_util->decodeTime(value.timestamp_time, &hours, &minutes, &seconds, &fractions);
			std::string text;
			appendDateText(year, month, day, text);
			text += 'T';
			appendTimeText(hours, minutes, seconds, fractions, text);
			jsonEscape(text, out);
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
			appendBlob(attachment, transaction, &blobId, subType, out);
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
				return static_cast<IProvider*>(plugin);
			}
			plugins->release();
		}
	}

	// Fall back to the Y-valve dispatcher.  It consults the Providers config
	// setting, which needs a firebird.conf that a browser build has no reason
	// to ship — hence the direct lookup above is tried first.
	return g_master->getDispatcher();
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
	// would keep the attachment alive and the database file locked.
	for (auto tx = g_transactions.begin(); tx != g_transactions.end(); )
	{
		Status rollbackStatus;
		tx->second->rollback(rollbackStatus.ptr());
		tx = g_transactions.erase(tx);
	}

	Status status;
	it->second.attachment->detach(status.ptr());
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
FB_WASM_EXPORT
int fb_execute(int db_handle, int tx_handle, const char* sql)
{
	clearError();

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_execute: unknown database handle");
		return 1;
	}

	ITransaction* transaction = nullptr;
	bool ownTransaction = false;

	if (tx_handle)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("fb_execute: unknown transaction handle");
			return 2;
		}
	}
	else
	{
		Status status;
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
		if (status.failed() || !transaction)
		{
			setErrorFromStatus("fb_execute: could not start transaction", status.ptr());
			return 3;
		}
		ownTransaction = true;
	}

	Status status;
	attachment->execute(status.ptr(), transaction, 0, sql, SQL_DIALECT_V6,
		nullptr, nullptr, nullptr, nullptr);

	if (status.failed())
	{
		setErrorFromStatus("fb_execute", status.ptr());
		if (ownTransaction)
		{
			Status rollbackStatus;
			transaction->rollback(rollbackStatus.ptr());
		}
		return 4;
	}

	if (ownTransaction)
	{
		Status commitStatus;
		transaction->commit(commitStatus.ptr());
		if (commitStatus.failed())
		{
			setErrorFromStatus("fb_execute: commit failed", commitStatus.ptr());
			return 5;
		}
	}

	return 0;
}

/**
 * Execute a query and return a JSON-encoded result set, or null on failure.
 * The caller owns the returned pointer and must release it with
 * fb_free_result().
 *
 * `tx_handle` of 0 runs the query in its own transaction, committed once the
 * cursor has been drained.
 */
FB_WASM_EXPORT
const char* fb_query(int db_handle, int tx_handle, const char* sql)
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

	if (tx_handle)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("fb_query: unknown transaction handle");
			return nullptr;
		}
	}
	else
	{
		Status status;
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
		if (status.failed() || !transaction)
		{
			setErrorFromStatus("fb_query: could not start transaction", status.ptr());
			return nullptr;
		}
		ownTransaction = true;
	}

	// Cleanup helper — the cursor, statement and (optional) transaction must be
	// released on every exit path, including the error ones.
	IResultSet*       cursor    = nullptr;
	IStatement*       statement = nullptr;
	IMessageMetadata* metadata  = nullptr;

	auto cleanup = [&](bool commit)
	{
		if (cursor)
		{
			Status s;
			cursor->close(s.ptr());
			cursor->release();
		}
		if (metadata)
			metadata->release();
		if (statement)
		{
			Status s;
			statement->free(s.ptr());
			statement->release();
		}
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
	statement = attachment->prepare(status.ptr(), transaction, 0, sql, SQL_DIALECT_V6,
		IStatement::PREPARE_PREFETCH_METADATA);

	if (status.failed() || !statement)
	{
		setErrorFromStatus("fb_query: prepare failed", status.ptr());
		cleanup(false);
		return nullptr;
	}

	metadata = statement->getOutputMetadata(status.ptr());
	if (status.failed())
	{
		setErrorFromStatus("fb_query: could not read output metadata", status.ptr());
		cleanup(false);
		return nullptr;
	}

	const unsigned columnCount = metadata ? metadata->getCount(status.ptr()) : 0;
	if (status.failed())
	{
		setErrorFromStatus("fb_query: could not read column count", status.ptr());
		cleanup(false);
		return nullptr;
	}

	std::string json = "{\"columns\":[";

	// A statement with no output columns (INSERT, DDL, …) still succeeds; it
	// simply yields an empty result set rather than an error.
	std::vector<unsigned> types(columnCount);
	std::vector<int>      subTypes(columnCount);
	std::vector<int>      scales(columnCount);
	std::vector<unsigned> lengths(columnCount);
	std::vector<unsigned> offsets(columnCount);
	std::vector<unsigned> nullOffsets(columnCount);

	for (unsigned i = 0; i < columnCount; i++)
	{
		if (i)
			json += ',';

		// Prefer the alias so `SELECT COUNT(*) AS TOTAL` reports TOTAL.
		const char* name = metadata->getAlias(status.ptr(), i);
		if (status.failed() || !name || !*name)
			name = metadata->getField(status.ptr(), i);
		jsonEscape(name ? name : "", name ? strlen(name) : 0, json);

		types[i]       = metadata->getType(status.ptr(), i);
		subTypes[i]    = metadata->getSubType(status.ptr(), i);
		scales[i]      = metadata->getScale(status.ptr(), i);
		lengths[i]     = metadata->getLength(status.ptr(), i);
		offsets[i]     = metadata->getOffset(status.ptr(), i);
		nullOffsets[i] = metadata->getNullOffset(status.ptr(), i);

		if (status.failed())
		{
			setErrorFromStatus("fb_query: could not read column metadata", status.ptr());
			cleanup(false);
			return nullptr;
		}
	}

	json += "],\"rows\":[";

	if (columnCount)
	{
		const unsigned messageLength = metadata->getMessageLength(status.ptr());
		if (status.failed())
		{
			setErrorFromStatus("fb_query: could not size the message buffer", status.ptr());
			cleanup(false);
			return nullptr;
		}

		cursor = statement->openCursor(status.ptr(), transaction, nullptr, nullptr,
			metadata, 0);

		if (status.failed() || !cursor)
		{
			setErrorFromStatus("fb_query: could not open cursor", status.ptr());
			cleanup(false);
			return nullptr;
		}

		std::vector<unsigned char> buffer(messageLength);
		bool firstRow = true;

		for (;;)
		{
			const int rc = cursor->fetchNext(status.ptr(), buffer.data());

			if (status.failed())
			{
				setErrorFromStatus("fb_query: fetch failed", status.ptr());
				cleanup(false);
				return nullptr;
			}

			if (rc != IStatus::RESULT_OK)
				break;

			if (!firstRow)
				json += ',';
			firstRow = false;

			json += '[';
			for (unsigned i = 0; i < columnCount; i++)
			{
				if (i)
					json += ',';

				short nullFlag = 0;
				memcpy(&nullFlag, buffer.data() + nullOffsets[i], sizeof(nullFlag));

				if (nullFlag == -1)
					json += "null";
				else
				{
					appendValue(attachment, transaction, types[i], subTypes[i],
						scales[i], lengths[i], buffer.data() + offsets[i], json);
				}
			}
			json += ']';
		}
	}

	json += "]}";

	cleanup(true);

	return allocCString(json);
}

/** Release a result set returned by fb_query(). */
FB_WASM_EXPORT
void fb_free_result(const char* ptr)
{
	free(const_cast<char*>(ptr));
}

/**
 * Start a transaction on the given database.
 * Returns a transaction handle (>0) on success, 0 on failure.
 */
FB_WASM_EXPORT
int fb_start_transaction(int db_handle)
{
	clearError();

	IAttachment* attachment = lookupAttachment(db_handle);
	if (!attachment)
	{
		setError("fb_start_transaction: unknown database handle");
		return 0;
	}

	Status status;
	ITransaction* transaction = attachment->startTransaction(status.ptr(), 0, nullptr);

	if (status.failed() || !transaction)
	{
		setErrorFromStatus("fb_start_transaction", status.ptr());
		return 0;
	}

	const int handle = g_nextTxHandle++;
	g_transactions[handle] = transaction;
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
	ITransaction* transaction = it->second;
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
	it->second->rollback(status.ptr());
	g_transactions.erase(it);

	if (status.failed())
	{
		setErrorFromStatus("fb_rollback", status.ptr());
		return 2;
	}

	return 0;
}

} /* extern "C" */
