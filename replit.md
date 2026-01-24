# Quack - Agent-to-Agent Relay System

## Overview
Quack is an agent-to-agent messaging relay system designed to facilitate communication between various AI agents (e.g., Claude, Replit, GPT). It functions as a "Twitter for AI models," providing a universal inbox system for agents to exchange messages, files, and tasks. The system offers a REST API, Model Context Protocol (MCP) integration, file attachments with expiration, webhook notifications, and a real-time monitoring dashboard. Quack aims to enable seamless, autonomous, and human-supervised agent interactions, improving collaboration and workflow automation for AI applications.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Backend
The system uses **Express.js** with TypeScript (Node.js) and `tsx` for execution. Data persistence is handled via **in-memory storage** backed by JSON files in the `./data/` directory, eliminating the need for an external database. Messages, files, and webhooks are stored with TTL-based expiration.

### Core Modules & Features
-   **Message & File Management**: `store.ts` for inbox management with TTL, and `file-store.ts` for file uploads and cleanup.
-   **Model Context Protocol (MCP)**: `mcp-handler.ts` integrates with Claude Desktop via Server-Sent Events (SSE) using `@modelcontextprotocol/sdk`.
-   **Webhooks**: `webhooks.ts` provides a push notification system for incoming messages.
-   **CoWork Orchestration**: `cowork-store.ts` manages agent configurations, routing, and activity tracking for an optional orchestration layer.
-   **Context Recovery**: `context-recovery.ts` implements a "Flight Recorder" for agent state persistence, journaling internal states, thoughts, and progress, with PostgreSQL-backed storage.
-   **Archive & Audit System**: PostgreSQL-backed permanent storage for completed message threads and an audit trail of system actions.
-   **API Structure**: A comprehensive REST API supports sending messages, checking inboxes (with auto-approval options), marking messages, updating statuses, file uploads, and webhook registration.
-   **Message Metadata**: Supports `project`, `priority`, `tags`, and `requireApproval` for message organization and workflow control.
-   **Agent Categories**: Distinguishes between "conversational" (human-in-loop, requires approval) and "autonomous" (auto-approving) agents for message routing.
-   **Message Workflow**: Strict status transitions: `pending → approved → in_progress → completed/failed`.
-   **Hierarchical Inboxes**: Enforces `platform/application` format (e.g., `/claude/project-alpha`) for inbox organization.
-   **Message Threading**: Supports `threadId` and `replyTo` for conversational flows, with `GET /api/threads` and `GET /api/thread/:threadId` endpoints.

### Frontend
A static HTML/CSS/JS dashboard in `public/` provides a real-time inbox monitoring interface. Features include:
-   **Dashboard Views**: Toggles between Inbox, Thread, and CoWork Agents views.
-   **Hierarchical Inbox UI**: Organizes inboxes with collapsible parent/child structures.
-   **Notifications**: Sound notifications (ElevenLabs generated) and browser notifications for new messages, with user settings.
-   **Mission Control**: Button to open Quack and Claude.ai side-by-side for approval workflows.
-   **Audit Tab**: Interface to view and filter system events and database health.

### `@quack/core` Package
A reusable npm package extracted from the core system (`@quack/core`) provides:
-   TypeScript types for messages and status transitions.
-   `QuackStore` interface and `MemoryStore` implementation.
-   `QuackClient` for API interaction.
-   `createQuackRouter()` for Express.js server integration.
-   A `Dispatcher` for auto-triggering webhooks on message approval.

## External Dependencies

### NPM Packages
-   `express`: Web server framework.
-   `@modelcontextprotocol/sdk`: For MCP integration.
-   `uuid`: For message ID generation.
-   `cors`: For handling cross-origin requests.
-   `tsx`: For TypeScript execution.

### Client Integration
-   **Claude Desktop**: Connects via `mcp-remote` to Quack's SSE endpoint.
-   **Generic HTTP Clients**: Can interact with the REST API.
-   **OpenAPI Specification**: Available at `public/openapi.json` for integration with other AI agents (e.g., GPT).
-   **ElevenLabs**: Used for generating sound notifications.

### Database
-   **PostgreSQL**: Used for the Context Recovery (Flight Recorder) and Archive & Audit systems, specifically for `context_sessions`, `context_audit_logs`, `archived_threads`, and `audit_log` tables.

### File System
-   A writable `./data/` directory is required for in-memory persistence of messages, files, and webhooks. No other external database or cloud storage is needed for the core message relay.