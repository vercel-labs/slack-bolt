#!/usr/bin/env node
import { run } from "./cli/index";

const { version } = require("../package.json") as { version: string };

run(version);
