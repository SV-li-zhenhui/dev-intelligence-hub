import assert from "node:assert/strict";
import test from "node:test";
import { LineBuffer } from "../src/lib/line-buffer.js";

test("line buffers preserve split UTF-8 lines and enforce byte limits", () => {
  const buffer = new LineBuffer({ maxLineBytes: 8 });

  assert.deepEqual(buffer.push(Buffer.from("one\nt")), ["one"]);
  assert.deepEqual(buffer.push(Buffer.from("wo\r\n")), ["two"]);
  assert.deepEqual(buffer.end(Buffer.from("三")), ["三"]);

  const bounded = new LineBuffer({ maxLineBytes: 4 });
  assert.throws(() => bounded.push(Buffer.from("12345")), {
    code: "PROCESS_LINE_TOO_LARGE",
  });
});
