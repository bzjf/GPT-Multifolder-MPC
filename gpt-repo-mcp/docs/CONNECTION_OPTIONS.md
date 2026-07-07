# Connection Options

This project supports two local-to-HTTPS connection paths for ChatGPT MCP setup.

## ngrok prerequisites

For the built-in `npm run connect` flow, install and configure ngrok first. See `SETUP.md#install-ngrok-from-zero`.

## Secure tunnel profile

`TUNNEL_CLIENT_PROFILE` is an example local `tunnel-client` profile label. It is not a `repo_id`, GitHub repo, ChatGPT connector name, ngrok tunnel, or MCP server name.

Run the secure tunnel with:

```bash
tunnel-client run --profile <profile>
```

