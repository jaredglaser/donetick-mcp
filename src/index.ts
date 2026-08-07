#!/usr/bin/env bun
import { z } from "zod";
import { inputRequired, inputResponse, McpServer, type ServerContext } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { DonetickClient } from "@/client";
import { parseConfig } from "@/config";
import { DonetickService } from "@/service";
import { buildToolDefinitions } from "@/tools/index";
import { CONFIRM_KEY, decideConfirmation } from "@/confirm";
import { createProbeGate } from "@/probe";

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
  const gate = createProbeGate(client, config.baseUrl);

  const factory = () => {
    const server = new McpServer({ name: "donetick-mcp", version: "0.1.0" });

    for (const tool of tools) {
      server.registerTool(
        tool.name,
        { description: tool.description, inputSchema: z.object(tool.inputSchema) },
        async (args: Record<string, unknown>, ctx: ServerContext) => {
          // Re-checked rather than remembered, so a Donetick that came up after this
          // server did serves the call instead of inheriting the startup verdict.
          const unreachable = await gate.reason();
          if (unreachable !== undefined) {
            return {
              content: [
                { type: "text" as const, text: `donetick-mcp cannot reach Donetick: ${unreachable}` },
              ],
              isError: true,
            };
          }
          const confirmation = decideConfirmation(
            inputResponse(ctx.mcpReq.inputResponses, CONFIRM_KEY),
          );
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

  void gate.run();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
