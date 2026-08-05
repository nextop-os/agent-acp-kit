import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeNodeCommand(dir: string, name: string, source: string) {
  if (process.platform === "win32") {
    const scriptPath = join(dir, `${name}.js`);
    const commandPath = join(dir, `${name}.cmd`);
    writeFileSync(scriptPath, source);
    writeFileSync(commandPath, `@"${process.execPath}" "${scriptPath}" %*\r\n`);
    return commandPath;
  }

  const commandPath = join(dir, name);
  writeFileSync(commandPath, `#!${process.execPath}\n${source}`);
  chmodSync(commandPath, 0o755);
  return commandPath;
}
