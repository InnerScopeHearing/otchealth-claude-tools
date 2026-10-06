const contentKey = /^(name|email|phone|address|body|content|message|prompt|customer|patient|order|refund|text|copy|subject|html|html_body)$/i;
export function opaqueReference(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.toUpperCase() !== 'UNKNOWN' && /^[A-Za-z0-9._:/#+=%-]+$/.test(value);
}
export function strictTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,3})?(Z|[+-](\d\d):(\d\d))$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [,y,m,d,h,min,sec,zone,oh,om] = match;
  const date = new Date(Date.UTC(Number(y), Number(m)-1, Number(d)));
  return date.getUTCFullYear() === Number(y) && date.getUTCMonth() === Number(m)-1 && date.getUTCDate() === Number(d) && Number(h)<24 && Number(min)<60 && Number(sec)<60 && (zone === 'Z' || (Number(oh)<24 && Number(om)<60));
}
export function metadataErrors(value, depth = 0, budget = { nodes: 0 }) {
  if (depth > 12 || ++budget.nodes > 4096) return ['METADATA_LIMIT'];
  if (Array.isArray(value)) return value.flatMap(item => metadataErrors(item, depth + 1, budget));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key,item]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || contentKey.test(key)) return ['CONTENT_OR_IDENTIFYING_FIELD'];
    return metadataErrors(item, depth + 1, budget);
  });
  if (typeof value === 'string' && value !== '' && !opaqueReference(value)) return ['INVALID_METADATA_VALUE'];
  if (typeof value === 'number' && !Number.isFinite(value)) return ['INVALID_METADATA_VALUE'];
  return [];
}
