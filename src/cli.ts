#!/usr/bin/env node
import { Command } from "commander";
import { VERSION } from "./index.js";

const program = new Command();

program
  .name("lg")
  .description("Compose agent CLI runs into a checkpointed, resumable graph")
  .version(VERSION);

program.parse();
