const pattern = /^([^.]+)\.(\d+)\.([^.]*)\.json$/;

// encodeURIComponent leaves "." and "-" untouched, which would break the file name format
const encodeTag = tag => encodeURIComponent(tag).replace(/\./g, "%2E").replace(/-/g, "%2D");

export const encodeRemoteName = session => {
  const tags = (session.tag || []).map(encodeTag).join(",") || "-";
  return `${session.id}.${session.lastEditedTime}.${tags}.json`;
};

export const decodeRemoteName = fileName => {
  const match = pattern.exec(fileName || "");
  if (!match) return null;
  const [, id, lastEditedTime, encodedTag] = match;
  let tag = [];
  if (encodedTag !== "-") {
    try {
      tag = encodedTag.split(",").map(decodeURIComponent);
    } catch {
      return null;
    }
  }
  return {
    id: id,
    lastEditedTime: Number(lastEditedTime),
    tag: tag
  };
};

// Edits upload a new file and delete the old one, so a failed delete or two devices editing the
// same session leave several files for one session id. Keep the newest, report the rest as stale.
export const splitLatestFiles = files => {
  const latest = new Map();
  const stale = [];
  for (const file of files) {
    const current = latest.get(file.name);
    if (!current) {
      latest.set(file.name, file);
      continue;
    }
    const a = file.appProperties.lastEditedTime;
    const b = current.appProperties.lastEditedTime;
    const isNewer = a > b || (a === b && file.id > current.id);
    if (isNewer) {
      stale.push(current);
      latest.set(file.name, file);
    } else {
      stale.push(file);
    }
  }
  return { files: [...latest.values()], stale };
};
