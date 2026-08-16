// pg-wire.mjs -- a minimal, dependency-free PostgreSQL frontend/backend wire-protocol (v3) client.
//
// WHY THIS EXISTS. otchealth-claude-tools has no package.json and no npm dependencies anywhere
// (every skill is a plain .mjs file using only node: built-ins and fetch) -- that discipline is why
// skills/decision-clock/cosmos-client.mjs and skills/signal-radar/common.mjs are dependency-free REST
// clients rather than using an Azure SDK. otchealth-mcp-server's Postgres agent-state backend
// (src/agentstate/postgres.ts) uses the `pg` npm package because that repo has a package.json and a
// build step; this repo has neither, and adding one for a single dependency would break that
// discipline fleet-wide for every other skill. So this file is the same "hand-rolled REST/wire client
// over node: built-ins" pattern applied to Postgres instead of HTTP: real TCP (node:net), real TLS
// (node:tls), real SCRAM-SHA-256 (RFC 5802/7677) and MD5 auth (node:crypto), and the Postgres Extended
// Query protocol for parameterized queries -- no query text is ever built by concatenating a value.
//
// SCOPE. Just enough of the protocol for skills/kb-memory/pg-state.mjs's needs: connect, authenticate
// (cleartext / md5 / SCRAM-SHA-256 -- the three password mechanisms Postgres/RDS actually issue),
// optionally negotiate TLS, and run parameterized statements that return zero or more rows of
// TEXT-format columns. No COPY, no LISTEN/NOTIFY, no binary-format columns, no connection pooling
// (each of the two callers is a short-lived CLI invocation issuing a handful of sequential queries,
// so one lazily-opened, memoized-per-process connection is the right amount of machinery -- see
// pg-state.mjs). No pgvector (neither caller needs it; that is a gateway-only feature).
//
// VERIFIED LIVE (not just reasoned about) against a real local PostgreSQL 16 server during
// development: SSL negotiation (both the 'S' TLS-upgrade path and the 'N' plaintext-continue path),
// SCRAM-SHA-256 auth, MD5 auth, DDL, parameterized INSERT/SELECT/UPDATE, NULL round-tripping, the
// ON CONFLICT upsert path, and every ErrorResponse-driven failure path (bad SQL, unique violation,
// wrong password).
//
// That live run was against a throwaway local server and its harness was never committed, so treat
// the paragraph above as a development note rather than a reproducible check -- an earlier version
// of this comment cited a tests/pg-wire.test.mjs that does not exist in this repo. What IS
// reproducible is tests/pg-wire-auth.test.mjs, which pins the weak-mechanism gate below.
//
// WEAK AUTH: the server picks the mechanism, so md5 and unencrypted-cleartext refuse by default and
// need PG_ALLOW_WEAK_AUTH=1. See authMechanismRefusal().
//
// PROTOCOL REFERENCE: https://www.postgresql.org/docs/current/protocol.html

import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import crypto from "node:crypto";

// ───────────────────────── message encoding helpers ─────────────────────────

function i32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}
function i16(n) {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n, 0);
  return b;
}
function cstr(s) {
  return Buffer.concat([Buffer.from(String(s), "utf8"), Buffer.from([0])]);
}

/** Build a type-prefixed frontend message: type byte + Int32 length (length INCLUDES itself, per the
 *  protocol, but EXCLUDES the type byte) + the parts. `type` is a single ASCII char, or null for the
 *  untyped StartupMessage/SSLRequest, which have no leading type byte at all. */
function frame(type, parts) {
  const body = Buffer.concat(parts);
  const len = i32(body.length + 4);
  return type === null ? Buffer.concat([len, body]) : Buffer.concat([Buffer.from(type, "ascii"), len, body]);
}

const SSL_REQUEST = Buffer.concat([i32(8), i32(80877103)]); // magic code, no type byte, 8 bytes total

// ───────────────────────── buffered byte-stream reader ─────────────────────────

/** Wraps a connected socket's byte stream with exact-length reads, so message framing (1-byte type +
 *  Int32 length-inclusive-of-itself + payload) can be pulled out regardless of how TCP happens to have
 *  chunked the underlying packets. Built on the socket's async iterator, which the socket is switched
 *  into ONLY after any raw pre-iteration reads (the single-byte SSL negotiation response) are done --
 *  see negotiateTls() below for why that ordering matters. */
class ByteReader {
  constructor(socket) {
    this._iter = socket[Symbol.asyncIterator]();
    this._buf = Buffer.alloc(0);
  }
  async _fill(n) {
    while (this._buf.length < n) {
      const { value, done } = await this._iter.next();
      if (done) throw new Error("pg-wire: connection closed while reading (expected more bytes)");
      this._buf = this._buf.length ? Buffer.concat([this._buf, value]) : Buffer.from(value);
    }
  }
  async readBytes(n) {
    await this._fill(n);
    const out = this._buf.subarray(0, n);
    this._buf = this._buf.subarray(n);
    return out;
  }
  /** One backend message: { type: 'R'|'Z'|'E'|..., payload: Buffer }. */
  async readMessage() {
    const t = await this.readBytes(1);
    const lenBuf = await this.readBytes(4);
    const len = lenBuf.readInt32BE(0);
    const payload = len > 4 ? await this.readBytes(len - 4) : Buffer.alloc(0);
    return { type: String.fromCharCode(t[0]), payload };
  }
}

/** Read exactly one raw byte via a one-shot 'data' listener rather than the async iterator. Used ONLY
 *  for the SSL negotiation response, which is a single un-framed byte sent before either side has
 *  agreed the connection is even in "Postgres message" mode. Any surplus bytes in the same TCP chunk
 *  (the server should never send any this early, but nothing guarantees a middlebox won't coalesce
 *  packets) are pushed back with socket.unshift() so they are not lost once normal reads resume. */
function readOneRawByte(socket) {
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      cleanup();
      if (chunk.length > 1) socket.unshift(chunk.subarray(1));
      resolve(chunk[0]);
    };
    const onError = (e) => { cleanup(); reject(e); };
    const onClose = () => { cleanup(); reject(new Error("pg-wire: connection closed during SSL negotiation")); };
    function cleanup() {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    }
    socket.once("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

// ───────────────────────── SCRAM-SHA-256 (RFC 5802 / RFC 7677) ─────────────────────────

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}
function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}
function xorBuf(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** One SCRAM-SHA-256 exchange, no channel binding (gs2-header "n,,", the standard choice for a plain
 *  TCP or TLS-without-channel-binding connection -- Postgres does not require binding). Pure aside
 *  from the two round-trip messages passed in by the caller; kept as a small class so pg-wire's main
 *  auth loop can hold the intermediate state (clientNonce, authMessage) across the two backend replies
 *  without threading extra parameters through the outer read loop. */
class ScramClient {
  constructor(password) {
    this.password = password;
    this.clientNonce = crypto.randomBytes(18).toString("base64");
    this.clientFirstBare = `n=*,r=${this.clientNonce}`;
  }
  /** -> the bytes of the client-first-message (gs2-header + bare) to send as the SASLInitialResponse. */
  clientFirstMessage() {
    return Buffer.from(`n,,${this.clientFirstBare}`, "utf8");
  }
  /** Consume the server-first-message (AuthenticationSASLContinue payload) -> the client-final-message
   *  bytes to send as the SASLResponse. Throws if the server's nonce does not extend the client's own
   *  (the RFC 5802 requirement that guards against a nonce substitution). */
  clientFinalMessage(serverFirstMessage) {
    const s = serverFirstMessage.toString("utf8");
    const m = /^r=([^,]*),s=([^,]*),i=(\d+)$/.exec(s);
    if (!m) throw new Error(`pg-wire: unparseable SCRAM server-first-message: ${JSON.stringify(s.slice(0, 200))}`);
    const [, serverNonce, saltB64, iterRaw] = m;
    if (!serverNonce.startsWith(this.clientNonce)) {
      throw new Error("pg-wire: SCRAM server nonce does not extend the client nonce (possible tampering)");
    }
    const iterations = parseInt(iterRaw, 10);
    const salt = Buffer.from(saltB64, "base64");
    const saltedPassword = crypto.pbkdf2Sync(this.password, salt, iterations, 32, "sha256");
    const clientKey = hmac(saltedPassword, "Client Key");
    const storedKey = sha256(clientKey);
    const clientFinalWithoutProof = `c=biws,r=${serverNonce}`; // "biws" = base64("n,,")
    const authMessage = `${this.clientFirstBare},${s},${clientFinalWithoutProof}`;
    const clientSignature = hmac(storedKey, authMessage);
    const clientProof = xorBuf(clientKey, clientSignature);
    // Stash what verifyServerSignature needs; both server and client derive ServerSignature the same
    // way from the SAME saltedPassword + authMessage, so nothing server-secret is required here.
    this._saltedPassword = saltedPassword;
    this._authMessage = authMessage;
    return Buffer.from(`${clientFinalWithoutProof},p=${clientProof.toString("base64")}`, "utf8");
  }
  /** Consume the server-final-message (AuthenticationSASLFinal payload). Throws on an explicit "e="
   *  server error, or if the server's proof of knowing the password does not match -- both indicate
   *  the exchange did not complete honestly and the connection must not be trusted. */
  verifyServerSignature(serverFinalMessage) {
    const s = serverFinalMessage.toString("utf8");
    const err = /^e=(.*)$/.exec(s);
    if (err) throw new Error(`pg-wire: SCRAM server reported an error: ${err[1]}`);
    const m = /^v=([^,]*)/.exec(s);
    if (!m) throw new Error(`pg-wire: unparseable SCRAM server-final-message: ${JSON.stringify(s.slice(0, 200))}`);
    const serverKey = hmac(this._saltedPassword, "Server Key");
    const serverSignature = hmac(serverKey, this._authMessage);
    if (serverSignature.toString("base64") !== m[1]) {
      throw new Error("pg-wire: SCRAM server signature mismatch (server did not prove it knows the password)");
    }
  }
}

/**
 * Decide whether a server-selected password mechanism may be used. Returns null to allow, or the
 * refusal message to throw.
 *
 * This is a pure function on purpose. The mechanism is chosen by the SERVER, so the interesting
 * behaviour is a branch deep inside the authentication loop that only runs when a particular kind
 * of server is on the other end -- which is precisely the code that never gets tested and then
 * turns out to do the wrong thing. Pulling the decision out means it can be proven at every
 * combination of (mechanism, encrypted, override) with no server at all.
 *
 * @param {number} authType  Postgres AuthenticationRequest subtype (3 cleartext, 5 md5, 10 SASL)
 * @param {{encrypted: boolean, allowWeakAuth: boolean}} ctx
 * @returns {string|null}
 */
export function authMechanismRefusal(authType, { encrypted, allowWeakAuth }) {
  if (allowWeakAuth) return null;
  if (authType === 3 && !encrypted) {
    return (
      "pg-wire: server requested a cleartext password on an UNENCRYPTED connection; refusing to send " +
      "the password in the clear. The server declined TLS (answered 'N' to SSLRequest). Fix the " +
      "server's TLS, or set PG_ALLOW_WEAK_AUTH=1 / allowWeakAuth:true to override."
    );
  }
  if (authType === 5) {
    return (
      "pg-wire: server requested MD5 password authentication, which is refused by default. MD5 is " +
      "collision-broken and Postgres has defaulted to SCRAM-SHA-256 since 14. Prefer fixing the " +
      "server (ALTER SYSTEM SET password_encryption='scram-sha-256', then reset the role's password " +
      "so its verifier is re-derived). Set PG_ALLOW_WEAK_AUTH=1 / allowWeakAuth:true only if you " +
      "have accepted that risk for this specific server."
    );
  }
  return null;
}

function md5PasswordMessage(password, user, saltBuf) {
  const inner = crypto.createHash("md5").update(password + user, "utf8").digest("hex");
  const outer = crypto.createHash("md5").update(Buffer.concat([Buffer.from(inner, "ascii"), saltBuf])).digest("hex");
  return `md5${outer}`;
}

// ───────────────────────── ErrorResponse parsing ─────────────────────────

/** ErrorResponse/NoticeResponse payload: repeated (1-byte field code + C-string), terminated by a
 *  zero byte. Field codes: https://www.postgresql.org/docs/current/protocol-error-fields.html */
function parseErrorFields(payload) {
  const fields = {};
  let i = 0;
  while (i < payload.length && payload[i] !== 0) {
    const code = String.fromCharCode(payload[i]);
    i++;
    const end = payload.indexOf(0, i);
    fields[code] = payload.toString("utf8", i, end === -1 ? payload.length : end);
    i = end === -1 ? payload.length : end + 1;
  }
  return fields;
}
function errorFromFields(fields) {
  const e = new Error(`Postgres ${fields.C || "?????"}: ${fields.M || "(no message)"}`);
  e.code = fields.C;
  e.detail = fields.D;
  e.pgFields = fields;
  return e;
}

// ───────────────────────── SSL negotiation ─────────────────────────

/** Send SSLRequest and, if the server offers TLS, upgrade the socket in place. Returns the socket to
 *  use for everything after (either the original plain socket, or the new TLS socket wrapping it).
 *  Must run BEFORE the socket is ever handed to a ByteReader (which switches it into async-iterator
 *  mode) -- tls.connect({ socket }) takes over the underlying plain socket's reading itself, and mixing
 *  that with an already-active async iterator on the same socket is exactly the kind of ordering bug
 *  that would silently misdeliver bytes between the two consumers. */
async function negotiateTls(plainSocket, { host, sslVerify }) {
  plainSocket.write(SSL_REQUEST);
  const resp = await readOneRawByte(plainSocket);
  if (resp === 0x4e /* 'N' */) return plainSocket; // server declined -- continue in plaintext
  if (resp !== 0x53 /* 'S' */) {
    throw new Error(`pg-wire: unexpected SSL negotiation response byte 0x${resp.toString(16)}`);
  }
  // RFC 6066 forbids an IP-literal SNI ServerName (Node warns and ignores it); only pass servername
  // for a real hostname. Real RDS/production hosts are always DNS names, so this only matters for
  // local/dev testing against a bare IP.
  const isIpLiteral = /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]+$/.test(host);
  return new Promise((resolve, reject) => {
    const tlsSocket = tlsConnect({ socket: plainSocket, host, ...(isIpLiteral ? {} : { servername: host }), rejectUnauthorized: Boolean(sslVerify) });
    tlsSocket.once("secureConnect", () => resolve(tlsSocket));
    tlsSocket.once("error", reject);
  });
}

// ───────────────────────── connection ─────────────────────────

/**
 * connect(opts) -> { query(text, values) -> {rows, rowCount, command}, end() }
 *
 * opts: { host, port, database, user, password, ssl = true, sslVerify = false, connectTimeoutMs = 10000 }
 *   ssl=false skips SSL negotiation entirely (plaintext only -- for a local/dev Postgres that has no
 *   TLS configured at all). ssl=true (default) always sends SSLRequest first; a server that responds
 *   'N' falls back to plaintext exactly as ssl=false would, so this is safe against a non-TLS server.
 *   sslVerify mirrors otchealth-mcp-server's PG_SSL_VERIFY: verifying the RDS-issued cert needs the
 *   RDS CA bundle, which is not (yet) baked in anywhere this file runs, so the default is
 *   encrypt-without-verify -- strictly better than plaintext, and the traffic never leaves the VPC.
 *
 *   allowWeakAuth (default false, or env PG_ALLOW_WEAK_AUTH=1) permits the two legacy password
 *   mechanisms this client can speak but will not use unprompted: md5, and cleartext over an
 *   unencrypted socket. See the authentication loop for why the default is refuse-and-say-so.
 */
export async function connect(opts) {
  const { host, port = 5432, database, user, password, ssl = true, sslVerify = false, connectTimeoutMs = 10000 } = opts;
  const allowWeakAuth = opts.allowWeakAuth ?? process.env.PG_ALLOW_WEAK_AUTH === "1";
  if (!host || !user || !database) throw new Error("pg-wire: connect() requires host, user, and database");

  let plainSocket;
  await new Promise((resolve, reject) => {
    plainSocket = netConnect({ host, port });
    const onError = (e) => { cleanup(); reject(new Error(`pg-wire: TCP connect to ${host}:${port} failed: ${e.message}`)); };
    const onTimeout = () => { cleanup(); plainSocket.destroy(); reject(new Error(`pg-wire: TCP connect to ${host}:${port} timed out after ${connectTimeoutMs}ms`)); };
    const onConnect = () => { cleanup(); resolve(); };
    function cleanup() {
      plainSocket.removeListener("error", onError);
      plainSocket.removeListener("timeout", onTimeout);
      plainSocket.removeListener("connect", onConnect);
      plainSocket.setTimeout(0);
    }
    plainSocket.setTimeout(connectTimeoutMs);
    plainSocket.once("error", onError);
    plainSocket.once("timeout", onTimeout);
    plainSocket.once("connect", onConnect);
  });

  const socket = ssl ? await negotiateTls(plainSocket, { host, sslVerify }) : plainSocket;
  // Whether the bytes are actually encrypted, which is NOT the same as having asked for TLS:
  // negotiateTls falls back to the plain socket when the server answers 'N'. The auth loop needs the
  // real answer, because "I requested ssl" is exactly the kind of intent-not-effect signal that has
  // produced false confidence in this fleet before.
  const encrypted = socket !== plainSocket;
  socket.on("error", () => { /* surfaced to the caller via the in-flight read/write promise, if any */ });

  const reader = new ByteReader(socket);

  function write(buf) {
    return new Promise((resolve, reject) => socket.write(buf, (err) => (err ? reject(err) : resolve())));
  }

  // ---- StartupMessage ----
  const startupParams = Buffer.concat([
    Buffer.from("user\0", "ascii"), cstr(user),
    Buffer.from("database\0", "ascii"), cstr(database),
    Buffer.from("application_name\0", "ascii"), cstr("otchealth-claude-tools/pg-wire"),
    Buffer.from([0]), // terminator
  ]);
  await write(frame(null, [i32(196608 /* protocol 3.0 */), startupParams]));

  // ---- Authentication + startup message loop, until ReadyForQuery ----
  let scram = null;
  for (;;) {
    const { type, payload } = await reader.readMessage();
    if (type === "E") throw errorFromFields(parseErrorFields(payload));
    if (type === "N") continue; // NoticeResponse: informational, ignore
    if (type === "K" || type === "S") continue; // BackendKeyData / ParameterStatus: not needed here
    if (type === "Z") break; // ReadyForQuery -- handshake complete
    if (type === "R") {
      const authType = payload.readInt32BE(0);
      if (authType === 0) continue; // AuthenticationOk
      // The SERVER picks the mechanism, so a client that implements the legacy ones will silently
      // use them the moment a server asks. Both weak mechanisms below therefore refuse by default
      // and say exactly why. This is deliberately not the same as deleting them: we have not proven
      // that no Postgres we talk to demands md5 (the one that matters, RDS otchealth-pg, is
      // VPC-private and could not be probed), and a loud refusal is safe whether or not it does --
      // whereas a silent downgrade is unsafe precisely when we are wrong about the server.
      const refusal = authMechanismRefusal(authType, { encrypted, allowWeakAuth });
      if (refusal) throw new Error(refusal);

      if (authType === 3) { // cleartext (reached only when encrypted, or explicitly overridden)
        await write(frame("p", [cstr(password)]));
        continue;
      }
      if (authType === 5) { // md5, 4-byte salt follows the code (reached only when overridden)
        const salt = payload.subarray(4, 8);
        await write(frame("p", [cstr(md5PasswordMessage(password, user, salt))]));
        continue;
      }
      if (authType === 10) { // SASL: null-terminated list of mechanism names, then a final empty string
        const mechanisms = payload.subarray(4).toString("utf8").split("\0").filter(Boolean);
        if (!mechanisms.includes("SCRAM-SHA-256")) {
          throw new Error(`pg-wire: server offered no supported SASL mechanism (got: ${mechanisms.join(", ") || "(none)"})`);
        }
        scram = new ScramClient(password);
        const first = scram.clientFirstMessage();
        await write(frame("p", [cstr("SCRAM-SHA-256"), i32(first.length), first]));
        continue;
      }
      if (authType === 11) { // SASLContinue
        if (!scram) throw new Error("pg-wire: SASLContinue received with no SCRAM exchange in progress");
        const final = scram.clientFinalMessage(payload.subarray(4));
        await write(frame("p", [final]));
        continue;
      }
      if (authType === 12) { // SASLFinal
        if (!scram) throw new Error("pg-wire: SASLFinal received with no SCRAM exchange in progress");
        scram.verifyServerSignature(payload.subarray(4));
        continue;
      }
      throw new Error(`pg-wire: unsupported authentication method (code ${authType}); only cleartext, md5, and SCRAM-SHA-256 are implemented`);
    }
    throw new Error(`pg-wire: unexpected message type '${type}' during connection startup`);
  }

  let ended = false;

  /**
   * Extended Query protocol, always: Parse (unnamed) + Bind (unnamed portal, all params/results TEXT
   * format) + Describe(Portal) + Execute + Sync, sent as one flush. Parameter types are left
   * unspecified (Postgres infers them from context -- the target column in an INSERT, or the explicit
   * ::numeric/::boolean/::vector cast the translator or a fixed statement supplies), exactly like the
   * `pg` npm package's own default behavior, and every value is sent as UTF8 text (never as SQL text
   * concatenated into the query string -- that split is the whole injection boundary).
   */
  async function query(text, values = []) {
    if (ended) throw new Error("pg-wire: query() called after end()");
    const paramBufs = values.map((v) => (v === null || v === undefined ? null : Buffer.from(String(v), "utf8")));
    const bindParams = paramBufs.length
      ? [i16(paramBufs.length), ...paramBufs.flatMap((b) => (b === null ? [i32(-1)] : [i32(b.length), b]))]
      : [i16(0)];

    const parseMsg = frame("P", [cstr(""), cstr(text), i16(0)]);
    const bindMsg = frame("B", [cstr(""), cstr(""), i16(0), ...bindParams, i16(1), i16(0)]);
    const describeMsg = frame("D", [Buffer.from("P", "ascii"), cstr("")]);
    const executeMsg = frame("E", [cstr(""), i32(0)]);
    const syncMsg = frame("S", []);

    await write(Buffer.concat([parseMsg, bindMsg, describeMsg, executeMsg, syncMsg]));

    const rows = [];
    let command = null;
    let firstError = null;
    for (;;) {
      const { type, payload } = await reader.readMessage();
      if (type === "1" || type === "2" || type === "n") continue; // ParseComplete / BindComplete / NoData
      if (type === "N") continue; // NoticeResponse
      if (type === "T") continue; // RowDescription -- columns are decoded positionally, names unused
      if (type === "D") { // DataRow
        const n = payload.readInt16BE(0);
        let off = 2;
        const row = [];
        for (let i = 0; i < n; i++) {
          const len = payload.readInt32BE(off);
          off += 4;
          if (len === -1) { row.push(null); continue; }
          row.push(payload.toString("utf8", off, off + len));
          off += len;
        }
        rows.push(row);
        continue;
      }
      if (type === "C") { command = payload.toString("utf8").replace(/\0+$/, ""); continue; } // CommandComplete
      if (type === "I") { command = "EMPTY"; continue; } // EmptyQueryResponse
      if (type === "E") { firstError = errorFromFields(parseErrorFields(payload)); continue; } // keep draining to Z
      if (type === "Z") break; // ReadyForQuery: this query's response is complete
      // Unknown/irrelevant message type: ignore rather than fail the whole client on a
      // protocol detail this minimal implementation does not need (e.g. a future NOTIFY).
    }
    if (firstError) throw firstError;
    return { rows, command };
  }

  async function end() {
    if (ended) return;
    ended = true;
    try { await write(frame("X", [])); } catch { /* best-effort */ }
    socket.end();
    socket.destroy();
  }

  return { query, end };
}
