# Quack 🦆

**Agent-to-agent relay for vibe coders**

Send your work from one AI agent to another without copy/paste.

## How It Works

```
┌─────────────┐      ┌─────────────────┐      ┌─────────────┐
│   Claude    │      │  Quack Server   │      │   Replit    │
│   Desktop   │ ───▶ │                 │ ◀─── │   Agent     │
│             │ MCP  │   /claude       │  API │             │
│ "Send this  │      │   /replit       │      │ "Check for  │
│  to Replit" │      │   /cursor       │      │  messages"  │
└─────────────┘      └─────────────────┘      └─────────────┘
```

## Quick Start

### 1. Deploy to Replit

1. Create new Replit → Import from GitHub or upload files
2. Run: `npm install && npm run dev`
3. Your Quack server is live at your Replit URL

### 2. Connect Claude Desktop

Add to `~/.config/claude-desktop/config.json` (Mac) or `%APPDATA%\Claude\config.json` (Windows):

```json
{
  "mcpServers": {
    "quack": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://your-replit-url/api/mcp/sse"]
    }
  }
}
```

Restart Claude Desktop.

### 3. Start Quacking!

In Claude Desktop:
```
"Send this code to Replit with instructions to deploy it"
```

In Replit Agent:
```
"Check my Quack inbox for messages"
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `quack_send` | Send message + files to another agent |
| `quack_check` | Check an inbox for pending messages |
| `quack_receive` | Get a message and mark it as read |
| `quack_complete` | Mark a message as completed |
| `quack_reply` | Reply to a message |

### Examples

**Send a file to Replit:**
```
quack_send({
  to: "replit",
  task: "Deploy this to production",
  files: [{ name: "app.ts", content: "...", type: "code" }],
  context: "This is the auth flow we discussed"
})
```

**Check for messages:**
```
quack_check({ inbox: "claude" })
```

## REST API

For agents without MCP support:

```bash
# Send a message
curl -X POST https://your-quack-url/api/send \
  -H "Content-Type: application/json" \
  -d '{
    "to": "replit",
    "from": "cursor",
    "task": "Review this code",
    "files": [{ "name": "utils.ts", "content": "...", "type": "code" }]
  }'

# Check inbox
curl https://your-quack-url/api/inbox/replit

# Mark as read
curl -X POST https://your-quack-url/api/receive/MESSAGE_ID

# Mark complete
curl -X POST https://your-quack-url/api/complete/MESSAGE_ID
```

## Embed in Any App

Add the seed script:

```html
<script src="https://your-quack-url/seed.js"></script>
<script>
  Quack.init({ 
    server: 'https://your-quack-url',
    inbox: 'myapp'
  });
  
  // Send a message
  Quack.send('claude', 'Help me debug this', {
    files: [{ name: 'error.log', content: '...', type: 'doc' }]
  });
  
  // Check inbox
  const { messages } = await Quack.check();
  
  // Keyboard shortcut: Ctrl+Shift+Q opens panel
</script>
```

## Message Format

```typescript
{
  id: string,
  to: string,           // destination inbox
  from: string,         // sender
  timestamp: string,    // ISO 8601
  expiresAt: string,    // 48 hours from creation
  status: 'pending' | 'read' | 'completed',
  
  task: string,         // what to do
  context?: string,     // background info
  files: [{
    name: string,
    content: string,    // base64 or raw text
    type: 'code' | 'doc' | 'image' | 'data'
  }],
  
  projectName?: string,
  replyTo?: string      // for threaded replies
}
```

## Default Inboxes

| Inbox | For |
|-------|-----|
| `/claude` | Claude Desktop, Claude Cowork |
| `/replit` | Replit Agent |
| `/cursor` | Cursor AI |
| `/gemini` | Gemini, Antigravity |
| `/gpt` | ChatGPT, GPT-4 |

You can also create custom inboxes by just sending to them.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `QUACK_SERVER` | http://localhost:3000 | For MCP client |

## Development

```bash
# Install dependencies
npm install

# Run in development mode (with hot reload)
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

## License

MIT
