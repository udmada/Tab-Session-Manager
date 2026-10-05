import { getSettings } from "../../settings/settings";
import google from "./google";
import webdav from "./webdav";
import s3 from "./s3";

const providers = { google, webdav, s3 };

export const getProviderByName = name => providers[name] || google;

export const getProvider = () => getProviderByName(getSettings("cloudProvider"));
