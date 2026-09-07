# the-i18n-mcp

Compatibility alias for [`@the-i18n-kit/mcp`](https://www.npmjs.com/package/@the-i18n-kit/mcp).

This package contains one file that starts the real server. It exists so an
MCP host config written before the rename — `npx -y the-i18n-mcp@latest` —
keeps resolving to the current release instead of the last version published
under the old name.

Point new configs at the real package:

```json
{
  "mcpServers": {
    "the-i18n-mcp": {
      "command": "npx",
      "args": ["-y", "@the-i18n-kit/mcp@latest"]
    }
  }
}
```

📖 [Documentation](https://fabkho.github.io/the-i18n-kit/)
