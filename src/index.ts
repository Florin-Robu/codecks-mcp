#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CodecksClient } from "./client.js";
import { registerTools } from "./tools.js";

const token = process.env.CODECKS_TOKEN;
const account = process.env.CODECKS_ACCOUNT;
if (!token || !account) {
  // Never print the token itself.
  console.error("codecks-mcp: set CODECKS_TOKEN and CODECKS_ACCOUNT (see README).");
  process.exit(1);
}

const server = new McpServer({ name: "codecks-mcp", version: "0.1.0" });
registerTools(server, new CodecksClient({ token, account }));
await server.connect(new StdioServerTransport());
