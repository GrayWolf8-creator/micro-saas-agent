import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

// 1. Initialize MCP Server instance
const mcp = new McpServer({
  name: "GW8 Wolf Pack Telemetry Gateway",
  version: "2.0.0"
});

// 2. Register Tool: Standard Telemetry ($0.05)
mcp.tool(
  "get_wolf_pack_telemetry",
  "Fetches real-time prices, 24h performance, and telemetry for the Wolf Pack portfolio.",
  {},
  async () => {
    // Returns current telemetry stored in your DB / memory
    const telemetry = typeof getLatestTelemetryStandard === 'function' 
      ? getLatestTelemetryStandard() 
      : { status: "active", note: "Standard Wolf Pack Telemetry Feed" };
      
    return {
      content: [{ type: "text", text: JSON.stringify(telemetry, null, 2) }]
    };
  }
);

// 3. Register Tool: Pro Alpha Signals ($0.25)
mcp.tool(
  "get_pro_alpha_signals",
  "Fetches technical setups, breakout triggers, and custom alpha indicators.",
  {},
  async () => {
    const proSignals = typeof getLatestTelemetryPro === 'function' 
      ? getLatestTelemetryPro() 
      : { status: "active", note: "Pro Alpha Signal Feed" };

    return {
      content: [{ type: "text", text: JSON.stringify(proSignals, null, 2) }]
    };
  }
);

// 4. Expose the MCP Stream Endpoint (Gated by your x402 payment middleware)
app.post("/mcp", x402PaymentGatekeeper, async (req, res) => {
  const transport = new StreamableHTTPServerTransport(req, res);
  await mcp.connect(transport);
});