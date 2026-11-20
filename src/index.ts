#!/usr/bin/env node
// `ngt-mcp init` configures the MCP apps, `pause`/`resume`/`dashboard` let the user see and stop spending,
// `--help` prints usage; anything else starts the stdio server.
const HELP = `NGT Chain MCP server: lets an AI agent pay x402 APIs in NGT on Base, with spending caps.

Usage:
  npx -y @ngtchain/mcp@1.7.4 init        Set up the agent wallet in Cursor, Claude Desktop, Claude Code, Gemini CLI or Codex
  npx -y @ngtchain/mcp@1.7.4 pause       Stop all agent spending, in every app, until you resume
  npx -y @ngtchain/mcp@1.7.4 resume      Allow agent spending again
  npx -y @ngtchain/mcp@1.7.4 dashboard   Open a local page with recent paid calls, balances and a pause button
  npx -y @ngtchain/mcp@1.7.4             Start the MCP server on stdio (your MCP client runs this)
  npx -y @ngtchain/mcp@1.7.4 --help      Show this help

Server environment:
  NGT_AGENT_PRIVATE_KEY   Agent wallet key that signs NGT payments (required to pay)
  NGT_MAX_PRICE           Most one call may pay, in NGT (default 0.01)
  NGT_SESSION_BUDGET      Most one session may spend, in NGT (default 0.1)
  NGT_USDC_MAX_PRICE      Most one call may pay, in USDC (default 0: USDC off)
  NGT_USDC_SESSION_BUDGET Most one session may spend, in USDC (default 0: USDC off)
  NGT_PREFERRED_CURRENCY  Token to pay when a seller takes both, NGT or USDC (default NGT)
  NGT_MAX_FUNDING         Most one fund_agent_wallet request may ask for, in NGT (default 10)
  NGT_HOST_HEADERS        Headers to send to one host only, as JSON: {"api.example.com":{"x-api-key":"..."}}
  NGT_HOME                Folder for the activity log and the pause flag (default ~/.ngtchain)
`;

const command = process.argv[2];
if (command === "init") {
  const { runInit } = await import("./init.js");
  process.exitCode = await runInit();
} else if (command === "pause" || command === "resume") {
  const { activityLogPath, setPaused } = await import("./activity.js");
  setPaused(command === "pause");
  console.log(
    command === "pause"
      ? "Agent spending is paused in every app. Paid tools pay nothing until you run: npx -y @ngtchain/mcp@1.7.4 resume"
      : "Agent spending is allowed again, within your caps.",
  );
  console.log(`Activity log: ${activityLogPath()}`);
} else if (command === "dashboard") {
  const { runDashboard } = await import("./dashboard.js");
  await runDashboard();
} else if (command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(HELP);
} else {
  // stdout carries the MCP protocol, so terminal hints go to stderr.
  if (process.stdin.isTTY) {
    console.error("Waiting for an MCP client on stdio. To set up your MCP app, run: npx -y @ngtchain/mcp@1.7.4 init");
    console.error("For usage, run: npx -y @ngtchain/mcp@1.7.4 --help   (Ctrl+C stops this server)");
  }
  await import("./server.js");
}
