// Adapted from Violentmonkey (MIT) - @usync/drive S3 signing.
// Minimal AWS Signature Version 4 signer for S3 using WebCrypto only.

const encoder = new TextEncoder();
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const toHex = bytes =>
  Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

// RFC 3986 unreserved characters only
export const uriEncode = value =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );

// Encode an object key / path: each segment encoded once, "/" preserved.
export const encodePath = path => path.split("/").map(uriEncode).join("/");

export const sha256Hex = async data => {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
};

const hmac = async (key, data) => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? encoder.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data)));
};

const getSigningKey = async (secretAccessKey, date, region) => {
  let key = await hmac(`AWS4${secretAccessKey}`, date);
  key = await hmac(key, region);
  key = await hmac(key, "s3");
  return hmac(key, "aws4_request");
};

export const buildCanonicalQuery = query =>
  Object.entries(query || {})
    .map(([k, v]) => [uriEncode(k), uriEncode(String(v))])
    .sort(([k1, v1], [k2, v2]) => (k1 === k2 ? (v1 < v2 ? -1 : +(v1 > v2)) : k1 < k2 ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

/**
 * Sign an S3 request.
 * @param {object} options
 * @param {string} options.method
 * @param {string} options.origin e.g. https://s3.us-east-1.amazonaws.com (no path)
 * @param {string} options.path already-unencoded path starting with "/" (encoded here once)
 * @param {object} [options.query] plain key/value pairs
 * @param {string} [options.body] string body
 * @param {object} [options.headers] extra headers; x-amz-* ones are signed
 * @returns {Promise<{url:string, headers:object}>}
 */
export const signRequest = async ({
  method,
  origin,
  path,
  query,
  body,
  headers,
  region,
  accessKeyId,
  secretAccessKey,
  date = new Date()
}) => {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = encodePath(path);
  const canonicalQuery = buildCanonicalQuery(query);
  const url = `${origin}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ""}`;
  const payloadHash = body ? await sha256Hex(body) : EMPTY_SHA256;

  const signed = {
    host: new URL(url).host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate
  };
  Object.entries(headers || {}).forEach(([k, v]) => {
    if (k.toLowerCase().startsWith("x-amz-")) signed[k.toLowerCase()] = String(v).trim();
  });

  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map(n => `${n}:${signed[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join("\n");

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join(
    "\n"
  );
  const signature = toHex(
    await hmac(await getSigningKey(secretAccessKey, dateStamp, region), stringToSign)
  );

  const outHeaders = { ...(headers || {}) };
  // host is set by the browser; do not send it explicitly
  Object.entries(signed).forEach(([k, v]) => {
    if (k !== "host") outHeaders[k] = v;
  });
  outHeaders.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url, headers: outHeaders };
};
