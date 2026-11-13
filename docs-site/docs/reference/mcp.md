---
title: MCP
description: Connect AI assistants to an OpenReader instance with the Model Context Protocol.
---

OpenReader is a remote MCP server at **`BASE_URL/api/mcp`**. It lets an assistant
search and organize a user's library, add and delete documents and make audiobooks,
as that user. Clients
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

The tools take command lines in the style of `gh`, such as `docs list --search dune`,
and return JSON. There is one tool for each [scope](./oauth), and deleting has a tool of
its own, so a client that asks before each call still shows what the call can do.
Only `openreader_delete` is marked destructive. `help` lists a tool's commands,
and `--help` after a command describes its flags.

| Tool | Scope | Commands |
| --- | --- | --- |
| `openreader` | `documents:read` | `docs list`, `docs view <doc>`, `folders list`, `voices list`, `voices cached <doc>`, `audiobook list <doc>`, `audiobook view <id>` |
| `openreader_docs` | `documents:write` | `docs add <source>`, `docs upload`, `docs rename <doc> <name>`, `docs move <doc> <folder>`, `folders create <name>`, `folders rename <folder> <name>` |
| `openreader_delete` | `documents:write` | `docs delete <doc>`, `folders delete <folder>`, `audiobook delete <id>` |
| `openreader_audio` | `audio:generate` | `audiobook create <doc>`, `audiobook cancel <id>` |

### Documents and folders

`docs add <url>` imports a link. A PDF, EPUB, DOCX, Markdown or text file is kept as
it is, up to the instance's upload limit, and a web page becomes Markdown. `docs add -`
saves the text in `input`, up to 2 MB. `--folder` adds the document to a folder.

To add a file from the user's device, run `docs upload`. It returns `uploadPageUrl`, a
link to the user's library that opens the file picker, into a folder with `--folder`.
An assistant that can run commands can send the file itself instead:
`docs upload --name paper.pdf --size <bytes>` also prepares a one-time upload URL and
returns it with its headers and a `curl` command. Once the file is sent,
`docs add <uploadId>` adds it. A DOCX is converted first; while it is, `docs add`
reports `processing`, and running it again finishes. The upload URL needs no other
credentials, works for 30 minutes and accepts that one file a single time, so treat it
like a password.

`docs rename` keeps the document's file extension. Arguments are quoted as in a shell,
and after `--` every word is an argument, so `folders create -- --drafts` names a
folder `--drafts`. `docs move <doc> <folder>` files a
document, and `-` in place of a folder takes it out of its folder; `docs list --folder`
filters the same way. `docs delete` removes a document with its generated audio and
audiobooks, and cannot be undone. `folders delete` removes only the folder: its
documents move to the top of the library.

### Voices and audiobooks

A voice ID names its provider and model as well as the voice, as
`provider/model/voice`, so a voice from `voices list` or `voices cached` means one
speech setting. `voices list` shows the providers and models the user can use, then the
voices of the saved provider and model, or of the `--provider` and `--model` you name.
If the provider does not answer, the voices are left out with a `PROVIDER_UNAVAILABLE`
error rather than listed unchecked, and the providers stay listed so you can pick another.

`voices cached <doc>` lists the voices a document already has audio for, with the
model speed the audio was made at. Creating an audiobook with one of those voices and
its `--model-speed` reuses that audio, which is what the web app's **Cached for this
book** list does. A voice whose audio no longer matches the document's reading
settings, or whose provider is disabled, is left out.

`audiobook create` uses the saved speech settings, including the saved voice speed, for
anything you leave out. `--model-speed` is the rate the model speaks at, so it changes
the audio; `--speed` only speeds up the finished file. The command returns at once with
a status and the voice ID it used, and sending the same command again returns the same
audiobook with `created: false`, resuming it if it was cancelled or interrupted.
`reusedCachedAudio` says whether audio was already there. Use `audiobook view <id>` to
check on it, and `audiobook cancel <id>` to stop it; generated audio stays cached and
the audiobook reports `cancelled` until it is created again. Because cancelling loses
nothing, `openreader_audio` is not marked destructive.

`audiobook list` and `audiobook view` show each audiobook's voice ID, model speed,
format, speed and `requestedAt`, and a `next` field that says what to do with it: follow
its progress, give the user its download link, or run the `audiobook create` command it
spells out to resume a cancelled, interrupted or usage-limited one. They only report:
reading an audiobook never starts or resumes its generation, and a read made while
another command holds the audiobook waits for it briefly.

`audiobook delete <id>` removes one audiobook and its file but keeps the document and
its generated audio, so creating the audiobook again reuses the speech already generated. A file that is
still being built cannot be deleted until it is ready. To remove one audiobook, use it
rather than `docs delete`, which removes the whole document.

Results include a `webUrl` that opens the document in OpenReader. Once an audiobook is
ready, `audiobook view` also returns a `webDownloadUrl`, a page that starts the download.
These links and `uploadPageUrl` need the user to be signed in to the account that owns the document, in the
browser that opens them. Without access, the page offers to sign in or switch account
and then returns to the link. Tools do not return audio files, API file addresses or
storage links, apart from the one-time upload URL that `docs upload` prepares. A command that fails returns an error result with a `code`, a `message` and,
when it applies, `retryAfterMs`; a command line it cannot read returns its usage. A call without the scope it needs gets an HTTP 403
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
