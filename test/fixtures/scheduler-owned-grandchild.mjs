process.stdout.write(`${process.pid}\n`);
process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
