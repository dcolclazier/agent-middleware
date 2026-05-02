#!/usr/bin/env python3
"""
MemPalace HTTP API — thin FastAPI wrapper around mempalace's Python API.

Runs on Spark #2 (192.168.1.8:8100) alongside the Gemma 4 vLLM server.
All three agents (Claude Code, Qwen, NemoClaw) talk to this over HTTP.

Usage:
    pip install mempalace==3.3.4 fastapi uvicorn
    mempalace init ~/mempalace
    python api-server.py                          # default port 8100
    MEMPALACE_PORT=8200 python api-server.py      # custom port
"""
import os
import sys
import logging
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Depends, Header
from pydantic import BaseModel, Field
import uvicorn

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

PALACE_PATH = os.environ.get("MEMPALACE_PALACE_PATH", os.path.expanduser("~/mempalace/palace"))
PORT = int(os.environ.get("MEMPALACE_PORT", "8100"))
AUTH_TOKEN = os.environ.get("MEMPALACE_TOKEN", "")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
log = logging.getLogger("mempalace-api")

# ---------------------------------------------------------------------------
# MemPalace singletons (initialised at startup)
# ---------------------------------------------------------------------------

_kg = None  # KnowledgeGraph instance
_config = None  # MempalaceConfig instance


def _ensure_palace():
    """Verify palace exists, or give a helpful error."""
    chroma_db = os.path.join(PALACE_PATH, "chroma.sqlite3")
    if not os.path.isfile(chroma_db):
        log.error(f"Palace not found at {PALACE_PATH}. Run: mempalace init <dir>")
        sys.exit(1)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _kg, _config
    _ensure_palace()
    os.environ["MEMPALACE_PALACE_PATH"] = PALACE_PATH

    from mempalace.config import MempalaceConfig
    from mempalace.knowledge_graph import KnowledgeGraph

    _config = MempalaceConfig()
    kg_path = os.path.join(_config.palace_path, "knowledge_graph.sqlite3")
    _kg = KnowledgeGraph(db_path=kg_path)
    log.info(f"Palace loaded from {_config.palace_path}")
    yield
    if _kg:
        _kg.close()


app = FastAPI(title="MemPalace API", version="1.0.0", lifespan=lifespan)

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


async def verify_token(authorization: Optional[str] = Header(None)):
    if not AUTH_TOKEN:
        return  # no auth configured
    if not authorization or authorization.replace("Bearer ", "") != AUTH_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid or missing token")


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------


class SearchRequest(BaseModel):
    query: str
    limit: int = Field(default=5, ge=1, le=50)
    wing: Optional[str] = None
    room: Optional[str] = None
    max_distance: float = Field(default=1.5)
    min_similarity: Optional[float] = None


class AddDrawerRequest(BaseModel):
    wing: str
    room: str
    content: str
    source_file: Optional[str] = None
    added_by: str = "api"


class UpdateDrawerRequest(BaseModel):
    drawer_id: str
    content: Optional[str] = None
    wing: Optional[str] = None
    room: Optional[str] = None


class DeleteDrawerRequest(BaseModel):
    drawer_id: str


class ListDrawersRequest(BaseModel):
    wing: Optional[str] = None
    room: Optional[str] = None
    limit: int = Field(default=20, ge=1, le=200)
    offset: int = Field(default=0, ge=0)


class KgAddRequest(BaseModel):
    subject: str
    predicate: str
    object: str
    valid_from: Optional[str] = None
    source_closet: Optional[str] = None


class KgQueryRequest(BaseModel):
    entity: str
    as_of: Optional[str] = None
    direction: str = Field(default="both")


class KgInvalidateRequest(BaseModel):
    subject: str
    predicate: str
    object: str
    ended: Optional[str] = None


class DiaryWriteRequest(BaseModel):
    agent_name: str
    entry: str
    topic: str = "general"


class DiaryReadRequest(BaseModel):
    agent_name: str
    last_n: int = Field(default=10, ge=1, le=100)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    return {"status": "ok", "palace_path": PALACE_PATH}


@app.get("/status", dependencies=[Depends(verify_token)])
async def status():
    from mempalace.mcp_server import tool_status
    return tool_status()


@app.post("/search", dependencies=[Depends(verify_token)])
async def search(req: SearchRequest):
    from mempalace.mcp_server import tool_search
    return tool_search(
        query=req.query,
        limit=req.limit,
        wing=req.wing,
        room=req.room,
        max_distance=req.max_distance,
        min_similarity=req.min_similarity,
    )


@app.post("/drawer", dependencies=[Depends(verify_token)])
async def add_drawer(req: AddDrawerRequest):
    from mempalace.mcp_server import tool_add_drawer
    return tool_add_drawer(
        wing=req.wing,
        room=req.room,
        content=req.content,
        source_file=req.source_file,
        added_by=req.added_by,
    )


@app.get("/drawer/{drawer_id}", dependencies=[Depends(verify_token)])
async def get_drawer(drawer_id: str):
    from mempalace.mcp_server import tool_get_drawer
    return tool_get_drawer(drawer_id=drawer_id)


@app.put("/drawer", dependencies=[Depends(verify_token)])
async def update_drawer(req: UpdateDrawerRequest):
    from mempalace.mcp_server import tool_update_drawer
    return tool_update_drawer(
        drawer_id=req.drawer_id,
        content=req.content,
        wing=req.wing,
        room=req.room,
    )


@app.delete("/drawer/{drawer_id}", dependencies=[Depends(verify_token)])
async def delete_drawer(drawer_id: str):
    from mempalace.mcp_server import tool_delete_drawer
    return tool_delete_drawer(drawer_id=drawer_id)


@app.post("/drawers/list", dependencies=[Depends(verify_token)])
async def list_drawers(req: ListDrawersRequest):
    from mempalace.mcp_server import tool_list_drawers
    return tool_list_drawers(
        wing=req.wing,
        room=req.room,
        limit=req.limit,
        offset=req.offset,
    )


@app.get("/wings", dependencies=[Depends(verify_token)])
async def list_wings():
    from mempalace.mcp_server import tool_list_wings
    return tool_list_wings()


@app.get("/rooms", dependencies=[Depends(verify_token)])
async def list_rooms(wing: Optional[str] = None):
    from mempalace.mcp_server import tool_list_rooms
    return tool_list_rooms(wing=wing)


# --- Knowledge Graph ---


@app.post("/kg/add", dependencies=[Depends(verify_token)])
async def kg_add(req: KgAddRequest):
    from mempalace.mcp_server import tool_kg_add
    return tool_kg_add(
        subject=req.subject,
        predicate=req.predicate,
        object=req.object,
        valid_from=req.valid_from,
        source_closet=req.source_closet,
    )


@app.post("/kg/query", dependencies=[Depends(verify_token)])
async def kg_query(req: KgQueryRequest):
    from mempalace.mcp_server import tool_kg_query
    return tool_kg_query(
        entity=req.entity,
        as_of=req.as_of,
        direction=req.direction,
    )


@app.post("/kg/invalidate", dependencies=[Depends(verify_token)])
async def kg_invalidate(req: KgInvalidateRequest):
    from mempalace.mcp_server import tool_kg_invalidate
    return tool_kg_invalidate(
        subject=req.subject,
        predicate=req.predicate,
        object=req.object,
        ended=req.ended,
    )


@app.get("/kg/timeline", dependencies=[Depends(verify_token)])
async def kg_timeline(entity: Optional[str] = None):
    from mempalace.mcp_server import tool_kg_timeline
    return tool_kg_timeline(entity=entity)


@app.get("/kg/stats", dependencies=[Depends(verify_token)])
async def kg_stats():
    from mempalace.mcp_server import tool_kg_stats
    return tool_kg_stats()


# --- Diary ---


@app.post("/diary/write", dependencies=[Depends(verify_token)])
async def diary_write(req: DiaryWriteRequest):
    from mempalace.mcp_server import tool_diary_write
    return tool_diary_write(
        agent_name=req.agent_name,
        entry=req.entry,
        topic=req.topic,
    )


@app.post("/diary/read", dependencies=[Depends(verify_token)])
async def diary_read(req: DiaryReadRequest):
    from mempalace.mcp_server import tool_diary_read
    return tool_diary_read(
        agent_name=req.agent_name,
        last_n=req.last_n,
    )


# --- Tunnels ---


@app.post("/tunnels/create", dependencies=[Depends(verify_token)])
async def create_tunnel(
    source_wing: str,
    source_room: str,
    target_wing: str,
    target_room: str,
    label: str = "",
):
    from mempalace.mcp_server import tool_create_tunnel
    return tool_create_tunnel(
        source_wing=source_wing,
        source_room=source_room,
        target_wing=target_wing,
        target_room=target_room,
        label=label,
    )


@app.get("/tunnels", dependencies=[Depends(verify_token)])
async def list_tunnels(wing: Optional[str] = None):
    from mempalace.mcp_server import tool_list_tunnels
    return tool_list_tunnels(wing=wing)


# --- Dedup ---


@app.post("/check-duplicate", dependencies=[Depends(verify_token)])
async def check_duplicate(content: str, threshold: float = 0.9):
    from mempalace.mcp_server import tool_check_duplicate
    return tool_check_duplicate(content=content, threshold=threshold)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info")
