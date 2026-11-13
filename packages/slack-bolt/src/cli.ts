#!/usr/bin/env node
import { main } from "./cli/main";

const { version } = require("../package.json") as { version: string };

main(process.argv.slice(2), version).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
