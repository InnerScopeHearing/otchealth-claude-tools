// commons-store.mjs — the ONE facade over otchealthcommons/company-journal (the fleet's shared
// non-PHI ops plane: _HEARTBEAT/, _DISPATCH/, _MEDIC/, _HANDOFF/, _DOCS/, _BULLETIN_SEEN/, _JOURNAL/,
// _NOTION/, _MEMORY/_exec/*.jsonl).
//
// WHY THIS EXISTS (2026-08-27 S3 port). Five toolkit callers (setup/heartbeat.mjs,
// skills/fleet-dispatch/dispatch.mjs, skills/fleet-medic/medic.mjs,
// skills/sunset-protocol/protocol.mjs, skills/fleet-search/search.mjs) each hand-rolled an identical
// account-SAS + fetch block to talk to the SAME (account, container). That storage account died with
// the Azure subscription deletion (2026-08-13); this file replaces all five copies with one thin
// wrapper over the proven S3 mirror (s3-blob.mjs), so a fix or a bucket change lands once.
//
// Unlike mem.mjs (written 2026-08-18, while Azure Blob GET/LIST for these accounts still worked and
// an Azure-read fallback was worth keeping), there is deliberately NO Azure leg here: the accounts
// are NXDOMAIN now, so a fallback branch would only ever throw, and a branch that always throws is
// dead code pretending to be a feature. If Azure commons ever needs a read-only historical inspection
// path again, add it explicitly and call it out, don't resurrect it silently here.
//
// CONTRACT (mirrors s3-blob.mjs's own contracts exactly -- see that file's header for the full detail):
//   cGet(name)      -> string | null   (null ONLY on a genuine 404; throws loud on anything else)
//   cGetMeta(name)  -> {text, etag}    (both null on 404; same loud-on-failure contract)
//   cPut(name, body, contentType)         -> {etag}. Throws on any non-2xx.
//   cPutCond(name, body, contentType, etag) -> {etag}. Conditional write (If-Match when etag is
//                                              truthy, If-None-Match:* when it is falsy -- see
//                                              blobwrite.mjs's condHeaders()). Throws on 412/409 too;
//                                              the CALLER'S retry loop decides what a conflict means.
//   cDel(name)      -> boolean         (true if something was deleted, false if already absent)
//   cList(prefix)   -> string[]        (names relative to the prefix's own container root)
//   cListMeta(prefix) -> {name,size,lastModified}[]
//   commonsConfigured() -> boolean     (true when the S3 credential chain resolves)
//
// Credentials resolve inside s3-blob.mjs via aws-secret.mjs's awsCreds() (ECS task role ->
// AWS_ACCESS_KEY_ID/SECRET -> OTC_AWS_ACCESS_KEY_ID/SECRET). No new credential-bootstrap path added.
// The old `azure-commons-storage-account`/`azure-commons-storage-key` secrets are NOT read here --
// every caller that ported to this facade drops that lookup entirely.
import { getTextFromS3, getTextMetaFromS3, putObjectToS3, deleteObjectFromS3, listBlobsFromS3, listBlobsMetaFromS3, s3Configured } from "./s3-blob.mjs";
import { condHeaders } from "./blobwrite.mjs";

const ACCT = "otchealthcommons";
const CONT = "company-journal";

export const cGet = (name) => getTextFromS3(ACCT, CONT, name);
export const cGetMeta = (name) => getTextMetaFromS3(ACCT, CONT, name);
export const cPut = (name, body, contentType) => putObjectToS3(ACCT, CONT, name, body, contentType);
export const cPutCond = (name, body, contentType, etag) => putObjectToS3(ACCT, CONT, name, body, contentType, condHeaders(etag));
export const cDel = (name) => deleteObjectFromS3(ACCT, CONT, name);
export const cList = (prefix) => listBlobsFromS3(ACCT, CONT, prefix);
export const cListMeta = (prefix) => listBlobsMetaFromS3(ACCT, CONT, prefix);
export const commonsConfigured = s3Configured;
