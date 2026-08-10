import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { StorageBackend, DeleteFilter } from "../storage/types.js";
import type { AuditLogger } from "../security/audit.js";

/** Register the forget tool on the MCP server. */
export function registerForget(
  server: Server,
  storage: StorageBackend,
  audit: AuditLogger,
): void {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "forget") return null;

    const args = request.params.arguments as {
      id?: string;
      filter?: DeleteFilter;
      confirm?: boolean;
    };

    // Make sure that confirm is true
    if (!args.confirm) {
      return {
        content: [
          {
            type: "text",
            text: "Error: Set confirm to true to execute the deletion. The tool did not delete anything.",
          },
        ],
        isError: true,
      };
    }

    let result;
    if (args.id) {
      result = await storage.delete(args.id);
    } else if (args.filter) {
      result = await storage.deleteByFilter(args.filter);
    } else {
      return {
        content: [
          {
            type: "text",
            text: "Error: Provide an id or a filter. The tool did not delete anything.",
          },
        ],
        isError: true,
      };
    }

    // Log the audit entry
    audit.log({
      tool: "forget",
      argsHash: AuditLogger.hashArgs({ id: args.id, filter: args.filter }),
      resultLen: null,
      quotaHit: false,
      redacted: false,
    });

    return {
      content: [
        {
          type: "text",
          text: `Deleted: ${result.captures} captures, ${result.atoms} atoms, ${result.scenarios} scenarios`,
        },
      ],
    };
  });
}
