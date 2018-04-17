import * as QueryString from "querystring";
import * as Webdav      from "webdav-client";
import * as Stream      from "stream";
import { promisify }    from "util";

import {
  NextcloudClientInterface,
  ConnectionOptions,
  AsyncFunction
} from "./types";

import {
  Exception as NextcloudError,

  NotConnectedError,
  ForbiddenError,
  NotFoundError,
  NotReadyError
} from "./errors";

const promisifiedPut       = promisify(Webdav.Connection.prototype.put);
const promisifiedGet       = promisify(Webdav.Connection.prototype.get);
const promisifiedMove      = promisify(Webdav.Connection.prototype.move);
const promisifiedMkdir     = promisify(Webdav.Connection.prototype.mkdir);
const promisifiedExists    = promisify(Webdav.Connection.prototype.exists);
const promisifiedDelete    = promisify(Webdav.Connection.prototype.delete);
const promisifiedReaddir   = promisify(Webdav.Connection.prototype.readdir);
const promisifiedPreStream = promisify(Webdav.Connection.prototype.prepareForStreaming);

async function rawGetReadStream(sanePath: string): Promise<Stream.Readable> {
  const self: NextcloudClientInterface = this;

  await promisifiedPreStream.call(self.webdavConnection, sanePath);

  return self.webdavConnection.get(sanePath) as Stream.Readable;
}

async function rawRemove(sanePath: string): Promise<void> {
  const self: NextcloudClientInterface = this;

  await promisifiedDelete.call(self.webdavConnection, sanePath);
}

async function rawExists(sanePath: string): Promise<boolean> {
  const self: NextcloudClientInterface = this;

  const paths = unnest(sanePath);

  for (const sanePath of paths) {
    if (!await promisifiedExists.call(self.webdavConnection, sanePath)) {
      return false;
    }
  }

  return true;
}

async function rawPut(sanePath: string, content: string): Promise<void> {
  const self: NextcloudClientInterface = this;

  await promisifiedPut.call(self.webdavConnection, sanePath, content);
}

async function rawGet(sanePath: string): Promise<string> {
  const self: NextcloudClientInterface = this;

  return await promisifiedGet.call(self.webdavConnection, sanePath);
}

async function rawGetFiles(sanePath: string): Promise<[string]> {
  const self: NextcloudClientInterface = this;

  const files: [string] = await promisifiedReaddir.call(self.webdavConnection, sanePath);

  if (!Array.isArray(files)) {
    throw new NotReadyError;
  }

  return files;
}

async function rawRename(saneFrom: string, newName: string): Promise<void> {
  const self: NextcloudClientInterface = this;

  const override = true;
  const base     = saneFrom.slice(0, saneFrom.lastIndexOf("/") + 1);

  const fullDestinationPath = `${nextcloudRoot(self.url)}${base}${sanitizePath(newName)}`;

  await promisifiedMove.call(self.webdavConnection, saneFrom, fullDestinationPath, override);
}

async function rawGetWriteStream(sanePath: string): Promise<Stream.Writable> {
  const self: NextcloudClientInterface = this;

  await preWriteStream.call(self, sanePath);

  return await self.webdavConnection.put(sanePath) as Stream.Writable;
}

async function rawTouchFolder(sanePath: string): Promise<void> {
  const self: NextcloudClientInterface = this;

  if (!await rawExists.call(self, sanePath)) {
    await promisifiedMkdir.call(self.webdavConnection, sanePath);
  }
}

async function rawCreateFolderHierarchy(sanePath: string): Promise<void> {
  const self: NextcloudClientInterface = this;

  const paths = unnest(sanePath);

  for (const saneSubfolder of paths) {
    await rawTouchFolder.call(self, saneSubfolder);
  }
}

export function configureWebdavConnection(options: ConnectionOptions): void {
  const self: NextcloudClientInterface = this;

  self.webdavConnection = new Webdav.Connection({
    authenticator: new Webdav.BasicAuthenticator(),
    url:           nextcloudRoot(options.url),
    username:      options.username,
    password:      options.password
  });
}

export async function checkConnectivity(): Promise<boolean> {
  const self: NextcloudClientInterface = this;

  try           { await rawGetFiles.call(self, "/"); }
  catch (error) { return false;                      }

  return true;
}

async function rawPipeStream(sanePath: string, stream: Stream): Promise<void> {
  const self: NextcloudClientInterface = this;

  const writeStream = await rawGetWriteStream.call(self, sanePath);

  await new Promise((resolve, reject) => {
    stream.on("error", wrapError);
    writeStream.on("end", resolve);
    writeStream.on("error", wrapError);

    stream.pipe(writeStream);

    function wrapError(error) {
      reject(NextcloudError(error));
    }
  });
}

export const createFolderHierarchy = clientFunction(rawCreateFolderHierarchy);
export const getWriteStream        = clientFunction(rawGetWriteStream);
export const getReadStream         = clientFunction(rawGetReadStream);
export const touchFolder           = clientFunction(rawTouchFolder);
export const pipeStream            = clientFunction(rawPipeStream);
export const getFiles              = clientFunction(rawGetFiles);
export const rename                = clientFunction(rawRename);
export const remove                = clientFunction(rawRemove);
export const exists                = clientFunction(rawExists);
export const put                   = clientFunction(rawPut);
export const get                   = clientFunction(rawGet);

async function preWriteStream(sanitizedPath: string): Promise<void> {
  const self: NextcloudClientInterface = this;

  await promisifiedPut.call(self.webdavConnection, sanitizedPath, "");

  await promisifiedPreStream.call(self.webdavConnection, sanitizedPath);
}

function clientFunction<T extends AsyncFunction>(λ: T): T {
  return async function errorTranslator(...parameters) {
    // This assumes the first parameter will always be the path.
    const path = parameters[0];

    try {
      return await λ.apply(this, [sanitizePath(path)].concat(parameters.slice(1)));
    } catch (error) {
      if (error.statusCode) {
        if (error.statusCode === 404) {
          throw new NotFoundError(path);
        } else if (error.statusCode === 403) {
          throw new ForbiddenError(path);
        }
      }

      throw error;
    }
  } as T;
}

function unnest(path) {
  return path
  .slice(1)
  .split("/")
  .map((folder, position, folders) => `/${folders.slice(0, position + 1).join("/")}`);
}

function sanitizePath(path) {
  return QueryString.escape(path).replace(/%2F/g, "/");
}

function nextcloudRoot(url) {
  return `${url}/remote.php/dav/files/nextcloud`;
}
