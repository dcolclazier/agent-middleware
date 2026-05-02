#!/usr/bin/env python3
"""
MCP stdio→HTTP proxy for MemPalace.

Claude Code speaks MCP over stdio. This proxy translates those MCP tool
calls into HTTP requests against the MemPalace API server on Spark #2.

Usage in Claude Code project settings.json:
{
  "mcpServers": {
    "mempalace": {
      "command": "python3",
      "args": ["tools/mempalace/mcp-proxy.py", "--url", "http://192.168.1.8:8100"]
    }
  }
}

Requires: pip install mcp  (the Python MCP SDK)
"""
import argparse
import json
import logging
import os
import sys
import urllib.request
import urllib.error

# MCP SDK (Python)
try:
    from mcp.server import Server
    from mcp.server.stdio import stdio_server
    from mcp import types
except ImportError:
    print("ERROR: pip install mcp", file=sys.stderr)
    sys.exit(1)

logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
log = logging.getLogger("mempalace-mcp-proxy")

# ---------------------------------------------------------------------------
# HTTP client (stdlib only — no requests dependency)
# ---------------------------------------------------------------------------

API_URL = ""
AUTH_TOKEN = os.environ.get("MEMPALACE_TOKEN", "")


def _api(method: str, path: str, body: dict = None) -> dict:
    """Call the MemPalace HTTP API. Returns parsed JSON."""
    url = f"{API_URL}{path}"
    data = json.dumps(body).encode() if body else None
    headers = {"Content-Type": "application/json"}
    if AUTH_TOKEN:
        headers["Authorization"] = f"Bearer {AUTH_TOKEN}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body_text = e.read().decode() if e.fp else str(e)
        return {"error": f"HTTP {e.code}: {body_text}"}
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

server = Server("mempalace-proxy")


@server.list_tools()
async def list_tools():
    return [
        types.Tool(
            name="mempalace_search",
            description="Search memories across the palace. Use wing/room to scope.",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search query"},
                    "limit": {"type": "integer", "default": 5},
                    "wing": {"type": "string", "description": "Filter by wing (agent name)"},
                    "room": {"type": "string", "description": "Filter by room (topic)"},
                },
                "required": ["query"],
            },
        ),
        types.Tool(
            name="mempalace_add_drawer",
            description="Store a memory. Use wing='shared' for cross-agent facts, wing='claude' for private.",
            inputSchema={
                "type": "object",
                "properties": {
                    "wing": {"type": "string", "description": "Wing name (e.g. 'shared', 'claude', 'qwen', 'nemoclaw')"},
                    "room": {"type": "string", "description": "Room/topic (e.g. 'decisions', 'naming', 'context')"},
                    "content": {"type": "string", "description": "Memory content"},
                    "source_file": {"type": "string", "description": "Optional source file path"},
                    "added_by": {"type": "string", "default": "claude"},
                },
                "required": ["wing", "room", "content"],
            },
        ),
        types.Tool(
            name="mempalace_get_drawer",
            description="Retrieve a specific drawer by ID.",
            inputSchema={
                "type": "object",
                "properties": {
                    "drawer_id": {"type": "string"},
                },
                "required": ["drawer_id"],
            },
        ),
        types.Tool(
            name="mempalace_delete_drawer",
            description="Delete a memory drawer by ID.",
            inputSchema={
                "type": "object",
                "properties": {
                    "drawer_id": {"type": "string"},
                },
                "required": ["drawer_id"],
            },
        ),
        types.Tool(
            name="mempalace_list_drawers",
            description="List drawers in a wing/room.",
            inputSchema={
                "type": "object",
                "properties": {
                    "wing": {"type": "string"},
                    "room": {"type": "string"},
                    "limit": {"type": "integer", "default": 20},
                },
            },
        ),
        types.Tool(
            name="mempalace_list_wings",
            description="List all wings in the palace.",
            inputSchema={"type": "object", "properties": {}},
        ),
        types.Tool(
            name="mempalace_list_rooms",
            description="List rooms in a wing.",
            inputSchema={
                "type": "object",
                "properties": {
                    "wing": {"type": "string"},
                },
            },
        ),
        types.Tool(
            name="mempalace_kg_add",
            description="Add a knowledge graph triple (fact with temporal validity).",
            inputSchema={
                "type": "object",
                "properties": {
                    "subject": {"type": "string"},
                    "predicate": {"type": "string"},
                    "object": {"type": "string"},
                    "valid_from": {"type": "string", "description": "ISO date or year"},
                },
                "required": ["subject", "predicate", "object"],
            },
        ),
        types.Tool(
            name="mempalace_kg_query",
            description="Query knowledge graph for an entity's relationships.",
            inputSchema={
                "type": "object",
                "properties": {
                    "entity": {"type": "string"},
                    "as_of": {"type": "string"},
                    "direction": {"type": "string", "default": "both"},
                },
                "required": ["entity"],
            },
        ),
        types.Tool(
            name="mempalace_diary_write",
            description="Write a diary entry for an agent.",
            inputSchema={
                "type": "object",
                "properties": {
                    "agent_name": {"type": "string"},
                    "entry": {"type": "string"},
                    "topic": {"type": "string", "default": "general"},
                },
                "required": ["agent_name", "entry"],
            },
        ),
        types.Tool(
            name="mempalace_diary_read",
            description="Read recent diary entries for an agent.",
            inputSchema={
                "type": "object",
                "properties": {
                    "agent_name": {"type": "string"},
                    "last_n": {"type": "integer", "default": 10},
                },
                "required": ["agent_name"],
            },
        ),
        types.Tool(
            name="mempalace_status",
            description="Get palace status and stats.",
            inputSchema={"type": "object", "properties": {}},
        ),
    ]


@server.call_tool()
async def call_tool(name: str, arguments: dict):
    route_map = {
        "mempalace_search": ("POST", "/search"),
        "mempalace_add_drawer": ("POST", "/drawer"),
        "mempalace_get_drawer": ("GET", "/drawer/{drawer_id}"),
        "mempalace_delete_drawer": ("DELETE", "/drawer/{drawer_id}"),
        "mempalace_list_drawers": ("POST", "/drawers/list"),
        "mempalace_list_wings": ("GET", "/wings"),
        "mempalace_list_rooms": ("GET", "/rooms"),
        "mempalace_kg_add": ("POST", "/kg/add"),
        "mempalace_kg_query": ("POST", "/kg/query"),
        "mempalace_diary_write": ("POST", "/diary/write"),
        "mempalace_diary_read": ("POST", "/diary/read"),
        "mempalace_status": ("GET", "/status"),
    }

    if name not in route_map:
        return [types.TextContent(type="text", text=json.dumps({"error": f"Unknown tool: {name}"}))]

    method, path_template = route_map[name]
    args = dict(arguments) if arguments else {}

    # Substitute path params like {drawer_id}
    if "{drawer_id}" in path_template:
        drawer_id = args.pop("drawer_id", "")
        path = path_template.replace("{drawer_id}", drawer_id)
    else:
        path = path_template

    # GET requests pass args as query params via path
    if method == "GET" and args:
        from urllib.parse import urlencode
        path = f"{path}?{urlencode({k: v for k, v in args.items() if v is not None})}"
        result = _api(method, path)
    else:
        result = _api(method, path, body=args if args else None)

    return [types.TextContent(type="text", text=json.dumps(result, indent=2, default=str))]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(read_stream, write_stream, server.create_initialization_options())


if __name__ == "__main__":
    import asyncio

    parser = argparse.ArgumentParser(description="MemPalace MCP→HTTP proxy")
    parser.add_argument("--url", default="http://192.168.1.8:8100", help="MemPalace API URL")
    parsed = parser.parse_args()
    API_URL = parsed.url

    asyncio.run(main())
