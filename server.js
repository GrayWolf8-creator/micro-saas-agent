app.post('/mcp', x402PaymentGatekeeper, async (req, res) => {
  try {
    // Create a fresh server instance per connection/request to avoid state conflicts
    const mcpServer = new McpServer({
      name: "WolfPackTelemetry",
      version: "1.0.0"
    });

    // Register your tools on this instance
    mcpServer.tool(
      "get_wolf_pack_telemetry",
      "Retrieves current market telemetry",
      {},
      async () => ({
        content: [{ type: "text", text: JSON.stringify({ status: "active", pack_metrics: "nominal" }) }]
      })
    );

    mcpServer.tool(
      "get_pro_alpha_signals",
      "Retrieves premium trading signals",
      {},
      async () => ({
        content: [{ type: "text", text: JSON.stringify({ alpha: "high", signal: "strong" }) }]
      })
    );

    const transport = new SSEServerTransport("/mcp/messages", res); // or Streamable/Custom HTTP transport depending on your setup
    await mcpServer.connect(transport);
    
    // Process request...
  } catch (err) {
    console.error("MCP Processing Error:", err);
    res.status(500).json({ error: err.message });
  }
});