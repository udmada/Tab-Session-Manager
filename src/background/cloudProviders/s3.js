// Adapted from Violentmonkey (MIT) - S3 handling from @usync/drive.
import log from "loglevel";
import { getSettings } from "../../settings/settings";
import { signRequest, encodePath } from "../../common/awsSigV4";
import { decodeRemoteName, splitLatestFiles, encodeRemoteName } from "../../common/remoteFileName";

const logDir = "background/cloudProviders/s3";
const ARCHIVE_DIR = "archive/";
const ARCHIVE_LIMIT = 5;

const readConfig = () => ({
  s3Endpoint: getSettings("s3Endpoint"),
  s3Region: getSettings("s3Region"),
  s3Bucket: getSettings("s3Bucket"),
  s3AccessKeyId: getSettings("s3AccessKeyId"),
  s3SecretAccessKey: getSettings("s3SecretAccessKey"),
  s3PathStyle: getSettings("s3PathStyle"),
  s3Prefix: getSettings("s3Prefix"),
  s3KeepArchive: getSettings("s3KeepArchive")
});

const normalizeConfig = raw => {
  const config = raw || {};
  const trim = v => (typeof v === "string" ? v.trim() : "");
  const region = trim(config.s3Region) || "us-east-1";
  const bucket = trim(config.s3Bucket);
  const accessKeyId = trim(config.s3AccessKeyId);
  const secretAccessKey = trim(config.s3SecretAccessKey);
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "S3 settings are incomplete (bucket, access key ID and secret access key are required)"
    );
  }

  let endpoint = trim(config.s3Endpoint);
  if (!endpoint) endpoint = `https://s3.${region}.amazonaws.com`;
  if (!endpoint.includes("://")) endpoint = `https://${endpoint}`;
  endpoint = endpoint.replace(/\/+$/, "");
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`Invalid S3 endpoint: ${endpoint}`);
  }

  let prefix = trim(config.s3Prefix).replace(/^\/+/, "");
  if (prefix && !prefix.endsWith("/")) prefix += "/";

  return {
    region,
    bucket,
    accessKeyId,
    secretAccessKey,
    pathStyle: config.s3PathStyle !== false,
    keepArchive: !!config.s3KeepArchive,
    prefix,
    protocol: url.protocol,
    host: url.host,
    basePath: url.pathname.replace(/\/+$/, "")
  };
};

// Returns { origin, path } for an object key ("" for the bucket itself)
const resolveTarget = (config, key) => {
  if (config.pathStyle) {
    return {
      origin: `${config.protocol}//${config.host}`,
      path: `${config.basePath}/${config.bucket}${key ? `/${key}` : ""}`
    };
  }
  return {
    origin: `${config.protocol}//${config.bucket}.${config.host}`,
    path: `${config.basePath}${key ? `/${key}` : "/"}`
  };
};

const decodeEntities = text =>
  text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    switch (e) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const code = e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });

const getTag = (xml, tag) => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeEntities(match[1]) : "";
};

const errorFromResponse = async (response, action) => {
  let detail = "";
  try {
    const text = await response.text();
    const code = getTag(text, "Code");
    const message = getTag(text, "Message");
    detail = [code, message].filter(Boolean).join(": ");
  } catch {
    // ignore body read errors
  }
  return new Error(
    `S3 ${action} failed: ${response.status}${response.statusText ? ` ${response.statusText}` : ""}${detail ? ` (${detail})` : ""}`
  );
};

const request = async (config, { method, key = "", query, body, headers, action, allow = [] }) => {
  const { origin, path } = resolveTarget(config, key);
  const signed = await signRequest({
    method,
    origin,
    path,
    query,
    body,
    headers,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey
  });
  let response;
  try {
    response = await fetch(signed.url, { method, headers: signed.headers, body });
  } catch (e) {
    throw new Error(`S3 ${action} failed: network error (${e.message || e})`);
  }
  if (!response.ok && !allow.includes(response.status))
    throw await errorFromResponse(response, action);
  return response;
};

const listKeys = async (config, prefix, maxKeys) => {
  const keys = [];
  let token = "";
  do {
    const query = { "list-type": "2", prefix };
    if (maxKeys) query["max-keys"] = maxKeys;
    if (token) query["continuation-token"] = token;
    const response = await request(config, { method: "GET", query, action: "list" });
    const xml = await response.text();
    const re = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match;
    while ((match = re.exec(xml))) keys.push(getTag(match[1], "Key"));
    token =
      !maxKeys && getTag(xml, "IsTruncated") === "true" ? getTag(xml, "NextContinuationToken") : "";
  } while (token);
  return keys;
};

const listFiles = async () => {
  log.log(logDir, "listFiles()");
  const config = normalizeConfig(readConfig());
  const keys = await listKeys(config, config.prefix);
  const archivePrefix = `${config.prefix}${ARCHIVE_DIR}`;
  const files = [];
  keys.forEach(key => {
    if (!key.startsWith(config.prefix) || key.startsWith(archivePrefix)) return;
    const name = key.slice(config.prefix.length);
    if (name.includes("/")) return;
    const info = decodeRemoteName(name);
    if (!info) return;
    files.push({
      id: key,
      name: info.id,
      appProperties: { lastEditedTime: info.lastEditedTime, tag: info.tag }
    });
  });
  const { files: latestFiles, stale } = splitLatestFiles(files);
  for (const file of stale) {
    await request(config, { method: "DELETE", key: file.id, action: "delete", allow: [404] }).catch(
      e => log.error(logDir, "listFiles() remove stale", e)
    );
  }
  log.log(logDir, "=>listFiles()", latestFiles);
  return latestFiles;
};

const archiveObject = async (config, session, fileId) => {
  try {
    const name = fileId.slice(config.prefix.length);
    const archivePrefix = `${config.prefix}${ARCHIVE_DIR}`;
    const copyResponse = await request(config, {
      method: "PUT",
      key: `${archivePrefix}${name}`,
      headers: { "x-amz-copy-source": `/${config.bucket}/${encodePath(fileId)}` },
      action: "archive copy"
    });
    // CopyObject may answer 200 with an <Error> body
    const copyText = await copyResponse.text();
    if (getTag(copyText, "Code"))
      throw new Error(`S3 archive copy failed: ${getTag(copyText, "Code")}`);

    const entries = (await listKeys(config, archivePrefix))
      .map(key => ({ key, info: decodeRemoteName(key.slice(archivePrefix.length)) }))
      .filter(e => e.info && e.info.id === session.id)
      .sort((a, b) => b.info.lastEditedTime - a.info.lastEditedTime);
    for (const entry of entries.slice(ARCHIVE_LIMIT)) {
      await request(config, {
        method: "DELETE",
        key: entry.key,
        action: "archive delete",
        allow: [404]
      });
    }
  } catch (e) {
    // archiving is best-effort and must not block the upload itself
    log.error(logDir, "archiveObject()", e);
  }
};

const uploadSession = async (session, fileId) => {
  log.log(logDir, "uploadSession()", session, fileId);
  const config = normalizeConfig(readConfig());
  const key = `${config.prefix}${encodeRemoteName(session)}`;

  if (fileId && config.keepArchive) await archiveObject(config, session, fileId);

  await request(config, {
    method: "PUT",
    key,
    body: JSON.stringify(session),
    headers: { "Content-Type": "application/json" },
    action: "upload"
  });

  if (fileId && fileId !== key) {
    await request(config, { method: "DELETE", key: fileId, action: "delete", allow: [404] });
  }
};

const downloadFile = async fileId => {
  log.log(logDir, "downloadFile()", fileId);
  const config = normalizeConfig(readConfig());
  const response = await request(config, { method: "GET", key: fileId, action: "download" });
  return JSON.parse(await response.text());
};

const deleteFile = async fileId => {
  log.log(logDir, "deleteFile()", fileId);
  const config = normalizeConfig(readConfig());
  await request(config, { method: "DELETE", key: fileId, action: "delete", allow: [404] });
};

const probe = async rawConfig => {
  const config = normalizeConfig(rawConfig);
  await listKeys(config, config.prefix, 1);
};

const ensureAuthorized = async (interactive = false) => {
  normalizeConfig(readConfig());
  if (interactive) await probe(readConfig());
};

const testConnection = async config => {
  await probe(config);
};

export default {
  listFiles,
  uploadSession,
  downloadFile,
  deleteFile,
  ensureAuthorized,
  testConnection
};
