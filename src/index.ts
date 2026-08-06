#!/usr/bin/env bun
import { z } from "zod";
import { acceptedContent, inputRequired, McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DonetickClient } from "@/client";
import { parseConfig } from "@/config";
import { endpoints } from "@/endpoints";
import { DonetickService } from "@/service";
import { buildToolDefinitions } from "@/tools/index";

let probeFailure: string | undefined;

async function probe(client: DonetickClient, baseUrl: string): Promise<void> {
  try {
    const result = await client.get(endpoints.listChores());
    if (!Array.isArray(result)) {
      probeFailure = `${baseUrl} answered but did not return a chore array. DONETICK_URL may be pointing at the wrong service.`;
      console.error(probeFailure);
      return;
    }
    // console.info writes to stdout under Bun, which would corrupt the JSON-RPC
    // stream shared with the transport. Every diagnostic here goes to stderr instead.
    console.error(`donetick-mcp connected to ${baseUrl}, ${result.length} chores visible`);
  } catch (error) {
    probeFailure = error instanceof Error ? error.message : String(error);
    console.error(`donetick-mcp could not reach Donetick: ${probeFailure}`);
  }
}

async function main(): Promise<void> {
  const config = parseConfig(process.env);

  const client = new DonetickClient({
    baseUrl: config.baseUrl,
    token: config.token,
    timeoutMs: config.timeoutMs,
  });

  // Built once, outside the factory. A server instance is per-connection under
  // protocol 2026-07-28, so anything built inside would have per-connection lifetime.
  const service = new DonetickService(client, { cacheTtlMs: config.cacheTtlMs });
  const tools = buildToolDefinitions({ service, timezone: config.timezone, now: () => new Date() });

  const factory = () => {
    const server = new McpServer({ name: "donetick-mcp", version: "0.1.0" });

    for (const tool of tools) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: z.object(tool.inputSchema) },
        async (args: Record<string, unknown>, ctx: ServerContext) => {
          if (probeFailure !== undefined) {
            return {
              content: [
                { type: "text" as const, text: `donetick-mcp could not reach Donetick at startup: ${probeFailure}` },
              ],
              isError: true,
            };
          }
          const confirmation = acceptedContent<{ confirm: boolean }>(ctx.mcpReq.inputResponses, "confirm");
          const result = await tool.handler(args ?? {}, { confirmation });
          if (result.confirmRequired !== undefined) {
            const { key, message } = result.confirmRequired;
            return inputRequired({
              inputRequests: {
                [key]: inputRequired.elicit({
                  message,
                  requestedSchema: {
                    type: "object",
                    properties: { confirm: { type: "boolean" } },
                    required: ["confirm"],
                  },
                }),
              },
            });
          }
          return { content: result.content, isError: result.isError };
        },
      );
    }

    return server;
  };

  // serveStdio returns once listening. `legacy` defaults to 'serve', so a client on
  // a 2025-era handshake is pinned to a compatible instance from this same factory.
  // Probing before this point would delay the first response, and exiting here would
  // reach the client as a crash rather than as the real reason.
  serveStdio(factory, { onerror: (error) => console.error(error.message) });

  void probe(client, config.baseUrl);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
