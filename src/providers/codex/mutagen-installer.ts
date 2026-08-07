import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import {
  chmod,
  mkdir,
  open,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const MUTAGEN_VERSION = "0.18.1";

export type SupportedMutagenAsset = { fileName: string; sha256: string };

const SUPPORTED_ASSETS: Record<string, SupportedMutagenAsset> = {
  "darwin-arm64": {
    fileName: "mutagen_darwin_arm64_v0.18.1.tar.gz",
    sha256: "6f810416d9e5fc4fd5e18431146f8b3c5a2056ba5a24f76c1e66da86eb3257e2",
  },
  "darwin-x64": {
    fileName: "mutagen_darwin_amd64_v0.18.1.tar.gz",
    sha256: "7d06f7d8fcfe90bc7e55cc834a2f2f20c2e0af9ea9bc35911fc4341ad56a9bbf",
  },
  "linux-arm64": {
    fileName: "mutagen_linux_arm64_v0.18.1.tar.gz",
    sha256: "bcba735aebf8cbc11da9b3742118a665599ac697fa06bc5751cac8dcd540db8a",
  },
  "linux-x64": {
    fileName: "mutagen_linux_amd64_v0.18.1.tar.gz",
    sha256: "7735286c778cc438418209f24d03a64f3a0151c8065ef0fe079cfaf093af6f8f",
  },
  "win32-arm64": {
    fileName: "mutagen_windows_arm64_v0.18.1.tar.gz",
    sha256: "9ac53447e46f019be9d37f49c00eeed8635966b885ed29ef06b3ff19afdee532",
  },
  "win32-x64": {
    fileName: "mutagen_windows_amd64_v0.18.1.tar.gz",
    sha256: "3e237e77f69959ed520a0f877330a431507bb0a85d9da7919764ba0c87b702c7",
  },
};

export type MutagenDownloader = (url: string) => Promise<Uint8Array>;

async function defaultDownloader(url: string) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Mutagen download failed with HTTP ${response.status}.`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > 100 * 1024 * 1024) {
    throw new Error("Mutagen download exceeded the 100 MiB size limit.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 100 * 1024 * 1024) {
    throw new Error("Mutagen download exceeded the 100 MiB size limit.");
  }
  return bytes;
}

function extractBinary(archive: Uint8Array, executableName: string) {
  const tar = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("Mutagen archive contains an invalid entry size.");
    }
    const contentOffset = offset + 512;
    const nextOffset = contentOffset + Math.ceil(size / 512) * 512;
    if (nextOffset > tar.length) throw new Error("Mutagen archive is truncated.");
    if (basename(name) === executableName) {
      return Buffer.from(tar.subarray(contentOffset, contentOffset + size));
    }
    offset = nextOffset;
  }
  throw new Error(`Mutagen archive does not contain ${executableName}.`);
}

async function pathExists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function acquireInstallLock(lockPath: string, targetPath: string) {
  const started = Date.now();
  while (true) {
    try {
      await mkdir(lockPath);
      return true;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
      if (await pathExists(targetPath)) return false;
      const lockStat = await stat(lockPath).catch(() => undefined);
      if (lockStat && Date.now() - lockStat.mtimeMs > 5 * 60_000) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > 30_000) {
        throw new Error("Timed out waiting for the Mutagen installation lock.");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export async function ensureCachedMutagen(options: {
  arch?: NodeJS.Architecture;
  asset?: SupportedMutagenAsset;
  cacheRoot?: string;
  downloader?: MutagenDownloader;
  platform?: NodeJS.Platform;
} = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const supportedAsset = SUPPORTED_ASSETS[`${platform}-${arch}`];
  if (!supportedAsset) {
    throw new Error(
      `Automatic Mutagen installation does not support ${platform}/${arch}. Configure TUTTI_MUTAGEN_BIN or install mutagen on PATH.`,
    );
  }
  const asset = options.asset ?? supportedAsset;
  const executableName = platform === "win32" ? "mutagen.exe" : "mutagen";
  const cacheRoot =
    options.cacheRoot ?? join(homedir(), ".cache", "tutti", "mutagen");
  const installDir = join(cacheRoot, `v${MUTAGEN_VERSION}`, `${platform}-${arch}`);
  const targetPath = join(installDir, executableName);
  if (await pathExists(targetPath)) return targetPath;

  await mkdir(installDir, { recursive: true });
  const lockPath = join(installDir, ".install.lock");
  const ownsLock = await acquireInstallLock(lockPath, targetPath);
  if (!ownsLock) return targetPath;
  const temporaryPath = join(installDir, `.${executableName}.${randomUUID()}.tmp`);
  try {
    if (await pathExists(targetPath)) return targetPath;
    const url = `https://github.com/mutagen-io/mutagen/releases/download/v${MUTAGEN_VERSION}/${asset.fileName}`;
    const archive = await (options.downloader ?? defaultDownloader)(url);
    const digest = createHash("sha256").update(archive).digest("hex");
    if (digest !== asset.sha256) {
      throw new Error(
        `Mutagen archive SHA-256 mismatch for ${platform}/${arch}; installation was aborted.`,
      );
    }
    const binary = extractBinary(archive, executableName);
    await writeFile(temporaryPath, binary, { flag: "wx", mode: 0o755 });
    const handle = await open(temporaryPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (platform !== "win32") await chmod(temporaryPath, 0o755);
    await rename(temporaryPath, targetPath);
    return targetPath;
  } finally {
    await rm(temporaryPath, { force: true });
    await rm(lockPath, { recursive: true, force: true });
  }
}
