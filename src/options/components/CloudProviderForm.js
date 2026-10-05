import React, { useState, useEffect } from "react";
import browser from "webextension-polyfill";
import { getSettings, setSettings } from "src/settings/settings";
import SignInButton from "./SignInButton";

const providers = [
  { value: "google", name: "cloudProviderGoogleLabel" },
  { value: "webdav", name: "cloudProviderWebdavLabel" },
  { value: "s3", name: "cloudProviderS3Label" }
];

const fields = {
  webdav: [
    {
      id: "webdavUrl",
      label: "webdavUrlLabel",
      type: "url",
      placeholder: "https://example.com/dav"
    },
    { id: "webdavUsername", label: "webdavUsernameLabel", type: "text" },
    { id: "webdavPassword", label: "webdavPasswordLabel", type: "password" },
    { id: "webdavFolder", label: "webdavFolderLabel", type: "text" }
  ],
  s3: [
    {
      id: "s3Endpoint",
      label: "s3EndpointLabel",
      type: "url",
      placeholder: "https://s3.example.com"
    },
    { id: "s3Region", label: "s3RegionLabel", type: "text", placeholder: "us-east-1" },
    { id: "s3Bucket", label: "s3BucketLabel", type: "text" },
    { id: "s3AccessKeyId", label: "s3AccessKeyIdLabel", type: "text" },
    { id: "s3SecretAccessKey", label: "s3SecretAccessKeyLabel", type: "password" },
    { id: "s3Prefix", label: "s3PrefixLabel", type: "text" },
    { id: "s3PathStyle", label: "s3PathStyleLabel", type: "checkbox" },
    { id: "s3KeepArchive", label: "s3KeepArchiveLabel", type: "checkbox" }
  ]
};

const readConfig = provider => {
  const config = {};
  fields[provider].forEach(field => {
    config[field.id] = getSettings(field.id);
  });
  return config;
};

const withScheme = url => (url.includes("://") ? url : `https://${url}`);

const getOriginPatterns = (provider, config) => {
  try {
    if (provider === "webdav") {
      const url = new URL(withScheme((config.webdavUrl || "").trim()));
      return [`${url.protocol}//${url.host}/*`];
    }
    if (provider === "s3") {
      const isDefaultEndpoint = !(config.s3Endpoint || "").trim();
      const endpoint = isDefaultEndpoint
        ? `https://s3.${config.s3Region || "us-east-1"}.amazonaws.com`
        : withScheme(config.s3Endpoint.trim());
      const url = new URL(endpoint);
      const origins = [`${url.protocol}//${url.host}/*`];
      if (!config.s3PathStyle && config.s3Bucket) {
        origins.push(`${url.protocol}//${config.s3Bucket}.${url.host}/*`);
      }
      return origins;
    }
  } catch (e) {
    return null;
  }
  return null;
};

export default () => {
  const [provider, setProvider] = useState(getSettings("cloudProvider") || "google");
  const [config, setConfig] = useState(() =>
    Object.assign({}, readConfig("webdav"), readConfig("s3"))
  );
  const [connectedLabel, setConnectedLabel] = useState(getSettings("signedInEmail"));
  const [status, setStatus] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const isConnected = Boolean(connectedLabel);

  // keep the connected state in sync with sign-in/out done elsewhere (e.g. SignInButton)
  useEffect(() => {
    const listener = (changes, area) => {
      if (area !== "local" || !changes.Settings) return;
      const newSettings = changes.Settings.newValue || {};
      setConnectedLabel(newSettings.signedInEmail || "");
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, []);

  const handleProviderChange = e => {
    setProvider(e.target.value);
    setStatus("");
    setSettings("cloudProvider", e.target.value);
  };

  const handleFieldChange = (field, e) => {
    const value = field.type === "checkbox" ? e.target.checked : e.target.value;
    setConfig({ ...config, [field.id]: value });
    setSettings(field.id, value);
  };

  const requestPermission = async () => {
    const origins = getOriginPatterns(provider, config);
    if (!origins) {
      setStatus(browser.i18n.getMessage("cloudInvalidUrlLabel"));
      return false;
    }
    const isGranted = await browser.permissions.request({ origins });
    if (!isGranted) setStatus(browser.i18n.getMessage("cloudPermissionDeniedLabel"));
    return isGranted;
  };

  const handleTestClick = async () => {
    setStatus("");
    if (!(await requestPermission())) return;
    setIsBusy(true);
    try {
      const res = await browser.runtime.sendMessage({
        message: "testCloudConnection",
        provider,
        config
      });
      setStatus(
        res && res.ok
          ? browser.i18n.getMessage("cloudTestSucceededLabel")
          : `${browser.i18n.getMessage("cloudTestFailedLabel")} ${(res && res.error) || ""}`
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleConnectClick = async () => {
    setStatus("");
    if (!(await requestPermission())) return;
    setIsBusy(true);
    try {
      const isSucceeded = await browser.runtime.sendMessage({
        message: "connectCloud",
        provider,
        config
      });
      if (isSucceeded) {
        setConnectedLabel(getSettings("signedInEmail"));
        setStatus("");
      } else {
        setStatus(browser.i18n.getMessage("cloudConnectFailedLabel"));
      }
    } finally {
      setIsBusy(false);
    }
  };

  const handleDisconnectClick = async () => {
    setIsBusy(true);
    try {
      const isSucceeded = await browser.runtime.sendMessage({ message: "disconnectCloud" });
      if (isSucceeded) {
        setConnectedLabel("");
        setStatus("");
      }
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="cloudProviderForm">
      <div className="selectWrap">
        <select value={provider} onChange={handleProviderChange} disabled={isConnected}>
          {providers.map(option => (
            <option value={option.value} key={option.value}>
              {browser.i18n.getMessage(option.name)}
            </option>
          ))}
        </select>
      </div>
      {provider === "google" ? (
        <SignInButton />
      ) : (
        <>
          {fields[provider].map(field => (
            <label
              className={`cloudField ${field.type === "checkbox" ? "checkbox" : ""}`}
              key={field.id}
            >
              <span>{browser.i18n.getMessage(field.label)}</span>
              {field.type === "checkbox" ? (
                <input
                  type="checkbox"
                  checked={Boolean(config[field.id])}
                  disabled={isConnected}
                  onChange={e => handleFieldChange(field, e)}
                />
              ) : (
                <input
                  type={field.type}
                  value={config[field.id] || ""}
                  placeholder={field.placeholder}
                  disabled={isConnected}
                  autoComplete="off"
                  onChange={e => handleFieldChange(field, e)}
                />
              )}
            </label>
          ))}
          <div className="cloudButtons">
            <input
              type="button"
              value={browser.i18n.getMessage("cloudTestConnectionLabel")}
              disabled={isBusy}
              onClick={handleTestClick}
            />
            {isConnected ? (
              <input
                type="button"
                value={browser.i18n.getMessage("cloudDisconnectLabel")}
                disabled={isBusy}
                onClick={handleDisconnectClick}
              />
            ) : (
              <input
                type="button"
                value={browser.i18n.getMessage("cloudConnectLabel")}
                disabled={isBusy}
                onClick={handleConnectClick}
              />
            )}
          </div>
          <p className="caption">{isConnected ? connectedLabel : status}</p>
          {isConnected && status && <p className="caption">{status}</p>}
        </>
      )}
    </div>
  );
};
