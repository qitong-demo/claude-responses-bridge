#!/usr/bin/env node
import { loadConfig, parseArgs, startBridgeServer } from "./server.mjs";

const args = parseArgs(process.argv.slice(2));

const config = loadConfig({
  configPath: args.config,
  port: args.port,
  listenHost: args.host,
  upstreamBaseUrl: args.upstream,
  apiKey: args["api-key"],
  requestTimeoutMs: args.timeout,
  quiet: args.quiet === true ? true : undefined,
  modelMap: {
    default: args["map-default"],
    opus: args["map-opus"],
    sonnet: args["map-sonnet"],
    haiku: args["map-haiku"],
  },
});

const server = await startBridgeServer(config);

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
