import { StringDecoder } from "node:string_decoder";

export class LineBufferError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LineBufferError";
    this.code = code;
  }
}

export class LineBuffer {
  constructor({ maxLineBytes = 256 * 1024 } = {}) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new TypeError("maxLineBytes must be a positive integer");
    }
    this.maxLineBytes = maxLineBytes;
    this.decoder = new StringDecoder("utf8");
    this.pending = "";
    this.ended = false;
  }

  push(chunk) {
    if (this.ended) throw new Error("LineBuffer has ended");
    return this.consume(this.decoder.write(chunk), false);
  }

  end(chunk) {
    if (this.ended) return [];
    this.ended = true;
    return this.consume(this.decoder.end(chunk), true);
  }

  consume(text, flush) {
    this.pending += text;
    const parts = this.pending.split("\n");
    this.pending = parts.pop();
    const lines = parts.map((line) =>
      line.endsWith("\r") ? line.slice(0, -1) : line,
    );
    for (const line of lines) this.assertWithinLimit(line);
    this.assertWithinLimit(this.pending);
    if (flush && this.pending) {
      const finalLine = this.pending.endsWith("\r")
        ? this.pending.slice(0, -1)
        : this.pending;
      this.assertWithinLimit(finalLine);
      lines.push(finalLine);
      this.pending = "";
    }
    return lines;
  }

  assertWithinLimit(value) {
    if (Buffer.byteLength(value, "utf8") > this.maxLineBytes) {
      throw new LineBufferError(
        "PROCESS_LINE_TOO_LARGE",
        "Process output line exceeded its byte limit",
      );
    }
  }
}
