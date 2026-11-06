# Remote MCP servers

Talorys can use tools from remote [Model Context Protocol](https://modelcontextprotocol.io)
(MCP) servers: a search service, your issue tracker, or a server you host
yourself. You add a server in **Settings → Integrations**, choose which of its
tools Talorys may use, and the agent can then call them in chat.

This is optional. With no servers configured nothing changes, and Talorys makes
no extra requests. Adding or removing a server never needs a redeploy.

## What it can and can't do

- **Transport:** Streamable HTTP only, over `https://`. The older HTTP+SSE
  transport, stdio and local MCP servers are not supported.
- **Authentication:** none, a bearer token, or [OAuth sign-in](#oauth-sign-in).
- **Chat only:** MCP tools are never offered to scheduled AI routines.
- **Tools only:** MCP prompts, resources and sampling are not used.

## Connecting a server

1. Open **Settings → Integrations** and choose **Add MCP server**.
2. Enter a name, the server's MCP URL (for example `https://example.com/mcp`)
   and how it authenticates: a bearer token, or OAuth to sign in with your account.
3. Choose **Connect**. Talorys checks the URL, connects, and lists the server's
   tools. If it can't connect, the server is saved with the reason, and you can
   fix the token or press reconnect.

Every tool starts **off**. Open the server with **Manage**, turn on the tools
you want, and pick how each one runs:

| Setting | What happens |
| --- | --- |
| **Ask me every time** (default) | The agent proposes the call. You see the server, the tool and the exact arguments on an approval card, and the call runs only when you approve it. |
| **Run without asking (read-only)** | The agent calls the tool directly. Choose this only for tools that just read data. |

"Run without asking" is a trust decision about the server. Servers can label a
tool read-only or destructive; Talorys shows those labels but never relies on
them, because it can't verify what a tool really does.

At most 20 tools can be on at once, across all servers, and their descriptions
must fit a fixed share of the AI's context. Turn off tools you don't use.

## Privacy

Talorys normally keeps your data inside your Cloudflare account. **MCP tools
are the exception:** calling a tool sends its arguments to that server, which is
run by a third party or by you, and the result comes back into the
conversation.

- Only the arguments of the tool call are sent. Talorys never sends your
  memories, notes, conversation history or other data to an MCP server on its
  own. The model is told to include only what the request needs, but whatever
  it puts in the arguments does leave your account, so review approval cards.
- Server URLs and tool names appear in Talorys's activity log. Arguments,
  results and credentials do not.
- Results and tool descriptions are treated as untrusted third-party text: the
  model is told never to follow instructions in them, and they can't change
  approvals or permissions.

## Security model

- **Owner only.** Servers are managed through `/api/mcp`, which needs an owner
  session and the CSRF header. Personal access tokens can't reach it, and no
  part of it is a tool: the agent can't add servers or turn tools on.
- **Credentials.** Bearer tokens and OAuth tokens are encrypted with AES-256-GCM under a key
  derived from the `MCP_CREDENTIAL_KEY` Worker secret, bound to the server's
  id. They are never returned by the API, shown in the UI, sent to the AI,
  logged, or included in backups. The token is only sent to the server's own
  origin: changing the URL to a different origin requires entering it again.
- **Endpoints.** Only `https://` URLs on public hosts are accepted. Private,
  loopback, link-local (including cloud metadata), CGNAT and other reserved
  addresses are refused, as are names like `localhost`, `*.local` and
  `*.internal`, and URLs with credentials or fragments. Before each new
  connection the host name is resolved over DNS-over-HTTPS, and a name that
  points to a private address is refused. Requests can only go to the
  configured origin, and redirects are never followed.
- **Approvals.** An approval is bound to the exact arguments and to the tool's
  permission state when it was proposed: if the tool is turned off or set to
  run without asking, the server is turned off or removed, its token changes, or
  the tool's definition changes, the approval fails and nothing is sent. Each
  approval runs at most once.
- **Changed tools.** When a server changes a tool's description, inputs or
  labels, Talorys stops using it until you turn it on again. Tools the server
  stops listing are marked as no longer offered.
- **Limits.** Every MCP call goes through the same pipeline as built-in tools:
  input validation, the per-turn call budget, at most 3 calls per tool per turn,
  and duplicate-call detection. Connections time out after 10 s, tool calls
  after 30 s, and responses over 2 MB are refused. The model sees at most 8,000
  characters of a result. Tools with oversized, overly nested or unsupported
  input schemas are listed but can't be turned on.
- **No background traffic.** Sessions are opened on demand and kept in memory
  for up to two minutes. There is no polling, no long-lived event stream and no
  automatic reconnect loop.

**Residual risk.** The DNS check runs before connecting, and the Workers
runtime resolves the name again when it connects, so a server that changes its
DNS answers in between (DNS rebinding) is not fully excluded. Requests from a
Worker leave from Cloudflare's network, not from your own, so they can't reach
devices on your home or office network.

## Approved calls and uncertain results

An external service may not be able to undo what it did, and Talorys can't
promise a call happened exactly once. If the connection fails or times out
after an approved call was sent, Talorys reports it as failed and says it **may
or may not have run**: check the service before asking again. Approved calls
are never retried automatically. Calls you set to run without asking are
retried once, only when a reused session turned out to be stale.

## Backups and updates

- A backup includes each server's name, URL and authentication type. It never
  includes tokens, OAuth sign-ins, sessions or which tools were on.
- Imported servers arrive **turned off**, with no token and no tools. Turn one
  on, add its token or sign in again, and choose its tools again.
- Updating Talorys keeps your servers, tokens and tool choices (they live in the
  Durable Object's SQLite database).

## Configuration

| Name | Kind | Purpose |
| --- | --- | --- |
| `MCP_CREDENTIAL_KEY` | Secret | Encrypts bearer tokens and OAuth sign-ins. The installer creates it, and the installer's `update` command adds it to older installations. Without it you can still add servers that need no authentication. Changing it makes stored tokens unreadable; enter them again or sign in again. |
| `TALORYS_MCP` | Secret or var | `off` turns MCP servers off for the deployment. |
| `TALORYS_MCP_MAX_TOOLS` | Secret or var | Most tools on at once (default 20, at most 64). |

For a [one-Worker deploy](deployment.md#one-worker-without-pages), set the key
by hand with 32 or more random characters:

```bash
openssl rand -base64 32 | npx wrangler secret put MCP_CREDENTIAL_KEY -c wrangler.standalone.jsonc
```

Set `TALORYS_MCP` and `TALORYS_MCP_MAX_TOOLS` with `wrangler secret put` too:
the installer regenerates the Worker config on update, which would drop a plain
variable.

## Cloudflare usage

MCP uses no extra Cloudflare products: configuration lives in the existing
Durable Object, and calls are ordinary `fetch` subrequests from it, which the
Workers Free plan includes. Each tool call costs a few subrequests (opening a
session takes two, then one per call) and counts toward the turn's existing
tool-call limit. The model still counts against your daily AI request budget as
usual, and large tool descriptions make every request in a turn longer.

## Troubleshooting

| Message | What to do |
| --- | --- |
| Could not connect to the MCP server | Check the URL, including its path (often `/mcp`). The server may be down. |
| This doesn't look like a Streamable HTTP MCP server | The URL answers, but not as an MCP server. Servers that only support the older SSE transport don't work. |
| This server requires authentication | Add or replace the bearer token under **Manage**. |
| The server answered with a redirect | Use the server's final URL. |
| This address is on a private or local network | Talorys only connects to public servers. To test a local server, use local development (below). |
| The server did not return any compatible tools | Its tools have input schemas Talorys can't validate. Each one shows the reason. |
| Changed, review again | The server changed the tool. Read its description, then turn it on again. |
| Credential storage isn't set up | Run the installer's `update` command, or set `MCP_CREDENTIAL_KEY` by hand. |
| Sign in to finish connecting | Choose **Sign in** and approve access on the server's page. The link is valid for 10 minutes; choose reconnect for a new one. |
| Signing in to this server failed | The server's sign-in doesn't support dynamic client registration, or refused the request. Try a bearer token if it offers one. |
| This sign-in link expired or was already used | Start again with reconnect. Each sign-in link works once. |

## Local development

With `TALORYS_ENV=development` (as `npm run dev` sets up), `http://localhost`,
`http://127.0.0.1` and `http://[::1]` URLs are allowed, so you can point Talorys
at an MCP server running on your machine. In mock-AI mode, a chat message
`call mcp_<tool id> {"arg": "value"}` calls an enabled tool directly. The tool
id is shown in the server's tool list.

## OAuth sign-in

Choose **OAuth (sign in)** as the authentication method for servers that let
you sign in with your account instead of pasting a token.

1. When you choose **Connect**, Talorys asks the server how to sign in (OAuth
   protected-resource and authorization-server metadata), registers itself as an
   app with the authorization server (dynamic client registration), and opens the
   server's sign-in page.
2. Approve access there. The authorization server sends you back to Talorys
   (`/settings/mcp-oauth`), which finishes signing in and connects.
3. Talorys refreshes the access token on its own. If the server revokes access,
   or the refresh token expires, the server shows **Needs authentication** and a
   **Sign in** button.

How it is kept safe:

- **Authorization code with PKCE (S256)**, as a public client: no client
  secret is stored. The request names the MCP server as the resource (RFC 8707).
- **State** is random, tied to the server, single use, and expires after 10
  minutes. The callback page posts it with your Talorys session and the CSRF
  header, so a sign-in can only finish in your own logged-in browser. (The
  redirect back to Talorys is cross-site, so the session cookie isn't sent with
  it; the callback page makes the request instead.)
- **Tokens, the app registration and the PKCE verifier** are stored encrypted
  with `MCP_CREDENTIAL_KEY`, like bearer tokens. They are never returned by the
  API, shown, sent to the AI, logged or exported. The access token is sent only
  to the MCP server's own origin, never to the authorization server.
- **The authorization server** must pass the same checks as an MCP endpoint:
  public `https://` host, no private addresses (also checked in DNS), no
  redirects.
- Changing the server's URL to another origin, or switching it to another
  authentication method, deletes the stored sign-in.

The callback works the same for the Pages deployment and the one-Worker
deployment: it is an ordinary page of the app, and its request goes through the
usual `/api` path, so the private Worker is never exposed.

Limitations: the authorization server must support dynamic client registration
(most MCP servers that offer OAuth do). Pre-registered client IDs, client
secrets and client ID metadata documents are not supported yet. Sign-in can only
be started from Settings, never by the agent.
