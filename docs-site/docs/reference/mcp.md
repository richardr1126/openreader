---
title: MCP
description: Connect AI assistants to an OpenReader instance with the Model Context Protocol.
---

OpenReader is a remote MCP server at **`BASE_URL/api/mcp`**. It lets an assistant
search a user's library, add documents and make audiobooks, as that user. Clients
sign in with [OAuth](./oauth), so there is no package to install and no API key to
copy.

## Connect a client

Add `https://reader.example/api/mcp`, with your own `BASE_URL`, as a remote MCP server
or connector. The client opens a browser, you sign in, and you approve what it can do.
For example, in Claude Code:

```bash
claude mcp add --transport http openreader https://reader.example/api/mcp
```

Clients configured with a JSON file usually take the same address, though field names
vary between clients:

```json
{
  "mcpServers": {
    "openreader": { "url": "https://reader.example/api/mcp" }
  }
}
```

Hosted connectors connect from the vendor's servers, so they need an instance with a
public HTTPS address. A client on your own computer can reach a local instance.

To check an instance by hand, run MCP Inspector and connect to the URL with the
streamable HTTP transport:

```bash
npx @modelcontextprotocol/inspector
```

Administrators can stop new clients from connecting with
[Open OAuth client registration](../configure/instance-settings). Clients that are
already connected keep working.

## Tools

| Tool | Scope | What it does |
| --- | --- | --- |
| `list_documents` | `documents:read` | Lists or searches the library, a page at a time |
| `add_document` | `documents:write` | Adds a public web page, or up to 2 MB of text |
| `list_providers` | `documents:read` | Lists the speech providers and models the user can use |
| `list_voices` | `documents:read` | Lists voices for one provider and model, including the user's cloned voices |
| `create_audiobook` | `audio:generate` | Starts an audiobook of a document or one chapter |
| `get_audiobook` | `documents:read` | Reports an audiobook's status and progress |

`create_audiobook` can use any enabled provider, model and voice. If it names none, it
uses the user's saved settings. A model outside what the instance allows falls back to
the provider's default, and the result reports the provider, model and voice it used.

`create_audiobook` returns at once with a status, and sending the same request again
returns the same audiobook. Use `get_audiobook` to check on it.

Results include a `webUrl` that opens the document in OpenReader. To listen to or
download an audiobook, open that link and sign in; tools do not return audio files or
audio links. A tool that fails returns an error result with a `code`, a `message` and,
when it applies, `retryAfterMs`. A call without the scope it needs gets an HTTP 403
`insufficient_scope` challenge, so the client can ask for more access.

See [Connected Apps](../guide/connected-apps) for what the approval screen shows and how
to disconnect.

MCP shares the user's [compute limits](../configure/compute-rate-limiting) and storage with
the web app. It has no request limit of its own.

## Staying connected

Access tokens last 15 minutes. A client that asks for `offline_access` refreshes them
without another sign-in. You need to approve the client again when:

- it has not refreshed its token for 30 days, or it never asked for `offline_access`;
- you disconnect it in **Settings → Account → Connected apps**;
- it asks for a scope you did not approve;
- the instance's `BASE_URL` changes, or `AUTH_SECRET` is replaced.

Some clients also end connections on their own schedule. Reconnect from the client if
that happens; your library is not affected.

## Security

- Only a bearer token issued for `BASE_URL/api/mcp` works. Browser sessions and tokens
  for `BASE_URL/api/v1` are rejected, and the reverse is also true.
- The endpoint sends no CORS headers and rejects a browser `Origin` the instance does
  not trust.
- Provider credentials and worker tokens never reach a client.
