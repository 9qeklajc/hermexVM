import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  HERMES_RELAYS_ENSURE_TOOL_NAME,
  type HermesRelaysEnsureResult,
} from "@contexcgi/protocol";
import { z } from "zod";
import type { RelayConfiguration } from "./relay-config.js";

export function registerRelayTools(
  server: McpServer,
  relayConfiguration: RelayConfiguration,
): void {
  server.registerTool(
    HERMES_RELAYS_ENSURE_TOOL_NAME,
    {
      title: "Add missing bridge relays",
      description:
        "Adds missing client relay URLs to the bridge's durable relay list and hot-reloads its live relay pool.",
      inputSchema: {
        relays: z.array(z.string().min(1).max(2048)).min(1).max(32),
      },
    },
    async ({ relays }) => {
      const result: HermesRelaysEnsureResult =
        await relayConfiguration.ensure(relays);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
