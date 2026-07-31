import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class StateStore {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
  }

  async read(name, fallback = null) {
    try {
      return JSON.parse(
        await readFile(path.join(this.dataDirectory, `${name}.json`), "utf8"),
      );
    } catch (error) {
      if (error.code === "ENOENT") return fallback;
      throw error;
    }
  }

  async write(name, value) {
    await mkdir(this.dataDirectory, { recursive: true });
    const target = path.join(this.dataDirectory, `${name}.json`);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }
}
