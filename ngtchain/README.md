NGT Chain is a local MCP server for Claude Code. Each call spends real NGT or USDC from a wallet you fund. pay_and_fetch sends the HTTPS request you name to that paid API and pays the price it asks, in NGT or USDC, only at or under your per-call cap. fetch_ngt_stream sends one request to the NGT stream and spends 0.001 NGT. The server also reads NGT and USDC balances from a Base RPC, and it can open a funding page on 127.0.0.1 that only this computer can reach. Payments are public on Base. The server does not send analytics.

The money protection is max_price and session_budget. A destructiveHint on a tool is only a hint. This plugin does not show a spend-confirmation dialog.

The agent private key is a sensitive plugin setting. Claude Code stores it on this computer. The server receives that setting. It does not read a key that is already in the environment.

This listing is for Claude Code only. Claude chat ignores local MCP servers, so this server does not run in chat. Cowork does not ask for userConfig, so it will not prompt for the agent key or the caps.

Example prompt, and this is a real payment of 0.001 NGT, not a test: call fetch_ngt_stream.
