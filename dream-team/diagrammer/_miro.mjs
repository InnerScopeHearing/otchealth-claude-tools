// _miro.mjs — tiny shared Miro REST helpers for the diagrammer renderers.
// Token from env only (MIRO_TOKEN). Scopes: boards:read, boards:write.

const TOKEN = process.env.MIRO_TOKEN;
if (!TOKEN) {
  console.error("Set MIRO_TOKEN (Miro access token with boards:write).");
  process.exit(1);
}
const BASE = "https://api.miro.com/v2";
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function miroApi(method, path, body, attempt = 1) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && attempt <= 5) {
    const retryAfter = Number(res.headers.get("retry-after")) || 0;
    const wait = Math.max(retryAfter * 1000, 500 * 2 ** (attempt - 1));
    await sleep(wait);
    return miroApi(method, path, body, attempt + 1);
  }
  const txt = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${txt}`);
  await sleep(180); // pace for rate limits
  return txt ? JSON.parse(txt) : {};
}

export async function createBoard(name, description = "") {
  const b = await miroApi("POST", "/boards", { name, description });
  return b;
}

export const shape = (board, content, { x, y, w = 320, h = 110, fill = "#ffffff", color = "#1a1a2e", font = "14", shape = "round_rectangle" }) =>
  miroApi("POST", `/boards/${board}/shapes`, {
    data: { shape, content },
    style: { fillColor: fill, color, fontSize: font, textAlign: "center", textAlignVertical: "middle" },
    position: { x, y, origin: "center" },
    geometry: { width: w, height: h },
  });

export const text = (board, content, { x, y, w = 900, font = "24", color = "#1a1a2e" }) =>
  miroApi("POST", `/boards/${board}/texts`, {
    data: { content },
    style: { color, fontSize: font, textAlign: "center" },
    position: { x, y, origin: "center" },
    geometry: { width: w },
  });

export const sticky = (board, content, { x, y, w = 460, fill = "light_yellow" }) =>
  miroApi("POST", `/boards/${board}/sticky_notes`, {
    data: { content, shape: "square" },
    style: { fillColor: fill },
    position: { x, y, origin: "center" },
    geometry: { width: w },
  });

export const connect = (board, from, to) =>
  miroApi("POST", `/boards/${board}/connectors`, {
    startItem: { id: from },
    endItem: { id: to },
    shape: "elbowed",
    style: { strokeColor: "#7a7a8c", strokeWidth: "2", endStrokeCap: "arrow" },
  });
