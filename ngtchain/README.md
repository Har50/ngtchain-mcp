NGT Chain is a local MCP server for Claude Code. Each call spends real NGT from a wallet you fund. pay_and_fetch sends the HTTPS request you name to that paid API and pays the price it asks in NGT, only at or under your per-call cap. fetch_ngt_stream sends one request to the NGT stream and spends 0.001 NGT.

This plugin pays in NGT only. It has no USDC settings, so USDC payments stay off. The desktop extension has separate USDC caps.
Privacy: https://www.ngtchain.com/ngtchain-mcp-privacy.html

The money protection is max_price and session_budget. A destructiveHint on a tool is only a hint. This plugin does not show a spend-confirmation dialog.

The agent private key is a sensitive plugin setting. Claude Code stores it on this computer. The server receives that setting. It does not read a key that is already in the environment.

This listing is for Claude Code only. Claude chat ignores local MCP servers, so this server does not run in chat. Cowork does not ask for userConfig, so it will not prompt for the agent key or the caps.

Example prompt, and this is a real payment of 0.001 NGT, not a test: call fetch_ngt_stream.
