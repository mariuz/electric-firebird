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
#include <mutex>
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
 * Append one column value, already located inside the fetched message buffer,
 * as JSON.
 */
void appendValue(IAttachment* attachment, ITransaction* transaction,
	unsigned type, int subType, int scale, unsigned length,
	const unsigned char* data, std::string& out, BlobSink* sink)
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
//       u8   isNull
//       u32  byteLength    (absent when isNull)
//       ...  UTF-8 bytes   (absent when isNull)
//
// Every value is sent as text and the input message is described as VARCHAR
// UTF-8, letting Firebird convert to the column's actual type.  That is what
// makes one code path work for integers, dates and strings alike; the
// alternative is reimplementing Firebird's conversion rules in the binding
// layer and getting them subtly wrong.

/**
 * UTF-8's character-set id.  Firebird defines CS_UTF8 in src/intl/charsets.h,
 * which is engine-internal and not reachable from the public API headers this
 * file is written against.
 */
constexpr unsigned FB_CS_UTF8 = 4;

/** One bound parameter: SQL NULL, or text for the engine to convert. */
struct ParamValue
{
	bool        isNull = true;
	std::string text;
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
bool parseParams(const unsigned char* data, unsigned length,
	std::vector<ParamValue>& out)
{
	out.clear();

	if (!data || length < 4)
		return length == 0;   // no parameters at all is valid

	unsigned pos = 0;
	const unsigned count = readU32(data);
	pos += 4;

	out.reserve(count);

	for (unsigned i = 0; i < count; i++)
	{
		if (pos + 1 > length)
			return false;

		ParamValue value;
		value.isNull = data[pos++] != 0;

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

		out.push_back(std::move(value));
	}

	return true;
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

	IMessageMetadata* meta() const noexcept { return metadata; }
	void* data() noexcept { return buffer.empty() ? nullptr : buffer.data(); }

	/**
	 * Describe `values` as VARCHAR UTF-8 and pack them into a message.
	 *
	 * `statement` supplies the parameter count, so a mismatch is reported
	 * before the engine sees it.
	 */
	bool build(IStatement* statement, const std::vector<ParamValue>& values)
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

		const unsigned expected = metadata->getCount(status.ptr());
		if (status.failed())
		{
			setErrorFromStatus("could not count parameters", status.ptr());
			return false;
		}

		if (expected != values.size())
		{
			char message[128];
			snprintf(message, sizeof(message),
				"statement expects %u parameter(s) but %u were supplied",
				expected, static_cast<unsigned>(values.size()));
			setError(message);
			return false;
		}

		if (expected == 0)
			return true;   // nothing to bind

		const unsigned messageLength = metadata->getMessageLength(status.ptr());
		if (status.failed())
		{
			setErrorFromStatus("could not size the parameter message", status.ptr());
			return false;
		}

		buffer.assign(messageLength, 0);

		for (unsigned i = 0; i < expected; i++)
		{
			const unsigned type       = metadata->getType(status.ptr(), i);
			const int      scale      = metadata->getScale(status.ptr(), i);
			const unsigned length     = metadata->getLength(status.ptr(), i);
			const unsigned offset     = metadata->getOffset(status.ptr(), i);
			const unsigned nullOffset = metadata->getNullOffset(status.ptr(), i);

			if (status.failed())
			{
				setErrorFromStatus("could not read a parameter descriptor", status.ptr());
				return false;
			}

			const short nullFlag = values[i].isNull ? -1 : 0;
			memcpy(buffer.data() + nullOffset, &nullFlag, sizeof(nullFlag));

			if (values[i].isNull)
				continue;

			// Present the value as VARCHAR and let Firebird convert it to the
			// declared type — the same conversion SQL string literals get, so
			// integers, decimals, dates and booleans all follow the engine's
			// own rules rather than a reimplementation of them.
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
				type & ~1u, scale, length, buffer.data() + offset);

			if (status.failed())
			{
				char context[160];
				snprintf(context, sizeof(context),
					"could not convert parameter %u (\"%.60s\")", i, text.c_str());
				setErrorFromStatus(context, status.ptr());
				return false;
			}
		}

		return true;
	}

private:
	IMessageMetadata*          metadata = nullptr;
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
		}

		m_disarmed = true;
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

bool serialiseCursor(IAttachment* attachment, ITransaction* transaction,
	IStatement* statement, IMessageMetadata* metadata, unsigned columnCount,
	IMessageMetadata* inMeta, void* inBuffer,
	IResultSet*& cursor, std::string& json, BlobSink* sink)
{
	Status status;

	json = "{\"columns\":[";

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

		types[i]       = metadata->getType(status.ptr(), i);
		subTypes[i]    = metadata->getSubType(status.ptr(), i);
		scales[i]      = metadata->getScale(status.ptr(), i);
		lengths[i]     = metadata->getLength(status.ptr(), i);
		offsets[i]     = metadata->getOffset(status.ptr(), i);
		nullOffsets[i] = metadata->getNullOffset(status.ptr(), i);

		const FB_BOOLEAN nullable = metadata->isNullable(status.ptr(), i);

		if (status.failed())
		{
			setErrorFromStatus("could not read column metadata", status.ptr());
			return false;
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
			types[i], subTypes[i], scales[i], lengths[i],
			nullable ? "true" : "false");
		json += described;
	}

	json += "],\"rows\":[";

	if (columnCount)
	{
		const unsigned messageLength = metadata->getMessageLength(status.ptr());
		if (status.failed())
		{
			setErrorFromStatus("could not size the message buffer", status.ptr());
			return false;
		}

		cursor = statement->openCursor(status.ptr(), transaction, inMeta, inBuffer,
			metadata, 0);

		if (status.failed() || !cursor)
		{
			setErrorFromStatus("could not open cursor", status.ptr());
			return false;
		}

		std::vector<unsigned char> buffer(messageLength);
		bool firstRow = true;

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
						scales[i], lengths[i], buffer.data() + offsets[i], json, sink);
				}
			}
			json += ']';
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
	// would keep the attachment alive and the database file locked.
	for (auto tx = g_transactions.begin(); tx != g_transactions.end(); )
	{
		Status rollbackStatus;
		tx->second->rollback(rollbackStatus.ptr());
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

	BlobSink sink;
	sink.enabled = (flags & FB_QUERY_BINARY_BLOBS) != 0;

	std::string json;
	if (!serialiseCursor(attachment, transaction, statement, metadata, columnCount,
			nullptr, nullptr, cursor, json, &sink))
	{
		cleanup(false);
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
	IStatement* statement = attachment->prepare(status.ptr(), transaction, 0, sql,
		SQL_DIALECT_V6, IStatement::PREPARE_PREFETCH_METADATA);

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

	{
		Status freeStatus;
		statement->free(freeStatus.ptr());
	}
	statement->release();

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

	if (tx_handle)
	{
		transaction = lookupTransaction(tx_handle);
		if (!transaction)
		{
			setError("fb_query_params: unknown transaction handle");
			return nullptr;
		}
	}
	else
	{
		Status status;
		transaction = attachment->startTransaction(status.ptr(), 0, nullptr);
		if (status.failed() || !transaction)
		{
			setErrorFromStatus("fb_query_params: could not start transaction", status.ptr());
			return nullptr;
		}
		ownTransaction = true;
	}

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
		setErrorFromStatus("fb_query_params: prepare failed", status.ptr());
		cleanup(false);
		return nullptr;
	}

	InputMessage input;
	if (!input.build(statement, values))
	{
		cleanup(false);
		return nullptr;
	}

	metadata = statement->getOutputMetadata(status.ptr());
	if (status.failed())
	{
		setErrorFromStatus("fb_query_params: could not read output metadata", status.ptr());
		cleanup(false);
		return nullptr;
	}

	const unsigned columnCount = metadata ? metadata->getCount(status.ptr()) : 0;
	if (status.failed())
	{
		setErrorFromStatus("fb_query_params: could not read column count", status.ptr());
		cleanup(false);
		return nullptr;
	}

	BlobSink sink;
	sink.enabled = (flags & FB_QUERY_BINARY_BLOBS) != 0;

	std::string json;
	if (!serialiseCursor(attachment, transaction, statement, metadata, columnCount,
			input.meta(), input.data(), cursor, json, &sink))
	{
		cleanup(false);
		return nullptr;
	}

	cleanup(true);
	publishBlobs(sink);
	return allocCString(json);
}

} /* extern "C" */
