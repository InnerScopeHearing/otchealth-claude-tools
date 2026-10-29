import { createHash } from "node:crypto";
import { getBufferFromS3, putObjectToS3 } from "../kb-memory/s3-blob.mjs";

const ACCOUNT = "otchealthcfodata";
const CFO_CONTAINER = "cfo-source-docs";
const XLSX_PATH = "innd-stock/INND-daily-stock-history.xlsx";
const TEXT_PATH = "_TEXT/innd-stock/INND-daily-stock-history.xlsx.txt";
const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function latestCompletedSessionDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = type => parts.find(p => p.type === type)?.value;
  const localDate = `${get("year")}-${get("month")}-${get("day")}`;
  if (Number(get("hour")) >= 16) return localDate;
  const prior = new Date(`${localDate}T12:00:00Z`);
  prior.setUTCDate(prior.getUTCDate() - 1);
  return prior.toISOString().slice(0, 10);
}

function csvCell(value) {
  if (value == null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function csvFromRows(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function verifyPublishedBytes(expected, actual, path) {
  const a = Buffer.from(expected), b = Buffer.from(actual);
  if (!a.equals(b)) throw new Error(`publication readback mismatch: ${path}`);
  return { path, sha256: createHash("sha256").update(a).digest("hex"), bytes: a.length };
}

export async function publishCfoCopies(workbookBytes, csvText) {
  const textBytes = Buffer.from(csvText, "utf8");
  const targets = [
    { path: XLSX_PATH, bytes: Buffer.from(workbookBytes), type: XLSX_TYPE },
    { path: TEXT_PATH, bytes: textBytes, type: "text/csv; charset=utf-8" },
  ];
  const verified = [];
  for (const target of targets) {
    await putObjectToS3(ACCOUNT, CFO_CONTAINER, target.path, target.bytes, target.type);
    const readback = await getBufferFromS3(ACCOUNT, CFO_CONTAINER, target.path);
    if (readback == null) throw new Error(`publication readback missing: ${target.path}`);
    verified.push(verifyPublishedBytes(target.bytes, readback, target.path));
  }
  return verified;
}
