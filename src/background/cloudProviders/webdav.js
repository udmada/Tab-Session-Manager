// Adapted from Violentmonkey (MIT): URL normalisation (scheme defaulting, trailing slash)
// and PROPFIND/MKCOL based WebDAV handling.
import log from "loglevel";
import { getSettings } from "../../settings/settings";
import { encodeRemoteName, decodeRemoteName, splitLatestFiles } from "../../common/remoteFileName";

const logDir = "background/cloudProviders/webdav";

const normalizeBaseUrl = url => {
  let base = (url || "").trim();
  if (!base) return "";
  if (!base.includes("://")) base = `https://${base}`;
  if (!base.endsWith("/")) base += "/";
  try {
    new URL(base);
  } catch {
    return "";
  }
  return base;
};

const encodePath = path => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");

const configFromSettings = () => ({
  webdavUrl: getSettings("webdavUrl"),
  webdavUsername: getSettings("webdavUsername"),
  webdavPassword: getSettings("webdavPassword"),
  webdavFolder: getSettings("webdavFolder")
});

const toBase64 = text => {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary);
};

const createClient = config => {
  const base = normalizeBaseUrl(config.webdavUrl);
  if (!base) throw new Error("WebDAV URL is not set or invalid");
  const folder = encodePath(config.webdavFolder || "");
  const folderUrl = folder ? `${base}${folder}/` : base;
  const folderPath = new URL(folderUrl).pathname;
  const username = config.webdavUsername || "";
  const password = config.webdavPassword || "";
  const authHeaders =
    username || password ? { Authorization: `Basic ${toBase64(`${username}:${password}`)}` } : {};

  const request = async (method, url, { headers = {}, body, okStatuses = [] } = {}) => {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { ...authHeaders, ...headers },
        body,
        cache: "no-store"
      });
    } catch (e) {
      throw new Error(`WebDAV ${method} failed: ${e.message}`);
    }
    if (!response.ok && !okStatuses.includes(response.status)) {
      const error = new Error(`WebDAV ${method} failed with status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response;
  };

  const fileUrl = name => `${folderUrl}${encodeURIComponent(name)}`;

  // fileId is the decoded file name inside the folder
  const ensureFolder = async () => {
    // create each path segment, 405 means it already exists
    const segments = folder ? folder.split("/") : [];
    let current = base;
    for (const segment of segments) {
      current += `${segment}/`;
      await request("MKCOL", current, { okStatuses: [405, 301, 302, 403, 409] }).catch(e => {
        // 409 (parent missing) on a deeper level will surface on PUT/PROPFIND
        if (e.status !== 409) throw e;
      });
    }
  };

  // keep only the newest file per session id and best-effort delete the stale ones
  const dedupe = files => {
    const newest = new Map();
    const stale = [];
    files.forEach(file => {
      const current = newest.get(file.name);
      if (!current) return newest.set(file.name, file);
      if (file.appProperties.lastEditedTime > current.appProperties.lastEditedTime) {
        stale.push(current);
        newest.set(file.name, file);
      } else stale.push(file);
    });
    stale.forEach(file =>
      request("DELETE", fileUrl(file.id), { okStatuses: [404] }).catch(() => {})
    );
    return [...newest.values()];
  };

  const list = async () => {
    const response = await request("PROPFIND", folderUrl, {
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body: `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>`,
      okStatuses: [207]
    });
    const text = await response.text();
    const files = [];
    const regex = /<(?:[\w-]+:)?href[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?href>/gi;
    let match;
    while ((match = regex.exec(text))) {
      let href = match[1].trim().replace(/&amp;/g, "&");
      if (href.endsWith("/")) continue;
      try {
        // href may be absolute URL or absolute path
        if (/^[a-z]+:\/\//i.test(href)) href = new URL(href).pathname;
        href = decodeURIComponent(href);
      } catch {
        continue;
      }
      const decodedFolderPath = (() => {
        try {
          return decodeURIComponent(folderPath);
        } catch {
          return folderPath;
        }
      })();
      const name = href.startsWith(decodedFolderPath)
        ? href.slice(decodedFolderPath.length)
        : href.split("/").pop();
      if (!name || name.includes("/")) continue;
      const info = decodeRemoteName(name);
      if (!info) continue;
      files.push({
        id: name,
        name: info.id,
        appProperties: { lastEditedTime: info.lastEditedTime, tag: info.tag }
      });
    }
    return dedupe(files);
  };

  return { request, fileUrl, ensureFolder, list };
};

const getClient = () => createClient(configFromSettings());

const listFiles = async () => {
  log.log(logDir, "listFiles()");
  const client = getClient();
  try {
    const { files, stale } = splitLatestFiles(await client.list());
    for (const file of stale) {
      await client
        .request("DELETE", client.fileUrl(file.id), { okStatuses: [404] })
        .catch(e => log.error(logDir, "listFiles() remove stale", e));
    }
    log.log(logDir, "=>listFiles()", files);
    return files;
  } catch (e) {
    if (e.status === 404) {
      await client.ensureFolder();
      return [];
    }
    log.error(logDir, "listFiles()", e);
    throw e;
  }
};

const uploadSession = async (session, fileId) => {
  log.log(logDir, "uploadSession()", session.id);
  const client = getClient();
  const name = encodeRemoteName(session);
  const body = JSON.stringify(session);
  const put = () =>
    client.request("PUT", client.fileUrl(name), {
      headers: { "Content-Type": "application/json" },
      body
    });
  try {
    await put();
  } catch (e) {
    // folder may not exist yet
    if (e.status !== 404 && e.status !== 409 && e.status !== 405) throw e;
    await client.ensureFolder();
    await put();
  }
  if (fileId && fileId !== name) {
    await client.request("DELETE", client.fileUrl(fileId), { okStatuses: [404] });
  }
};

const downloadFile = async fileId => {
  log.log(logDir, "downloadFile()", fileId);
  const client = getClient();
  const response = await client.request("GET", client.fileUrl(fileId));
  return JSON.parse(await response.text());
};

const deleteFile = async fileId => {
  log.log(logDir, "deleteFile()", fileId);
  const client = getClient();
  await client.request("DELETE", client.fileUrl(fileId), { okStatuses: [404] });
};

const verify = async client => {
  try {
    await client.ensureFolder();
    await client.list();
  } catch (e) {
    if (e.status === 401 || e.status === 403) throw new Error("Authentication failed");
    throw e;
  }
};

const ensureAuthorized = async (interactive = false) => {
  const config = configFromSettings();
  if (!normalizeBaseUrl(config.webdavUrl)) throw new Error("WebDAV URL is not set");
  if (!interactive) return;
  await verify(createClient(config));
};

const testConnection = async config => {
  await verify(createClient(config || {}));
};

export default {
  listFiles,
  uploadSession,
  downloadFile,
  deleteFile,
  ensureAuthorized,
  testConnection
};
