#!/usr/bin/env bash
# Deploy MemPalace HTTP API to Spark #2 (spark-45aa, 192.168.1.8)
#
# Prerequisites:
#   - SSH access: sshpass -p "$SSH_PASS" ssh bender@192.168.1.8
#   - Python 3.9+ on Spark
#
# Usage (run from agent-middleware repo root):
#   export SSH_PASS=...
#   bash tools/mempalace/deploy-to-spark.sh

set -euo pipefail

SPARK_HOST="192.168.1.8"
SPARK_USER="bender"
REMOTE_DIR="/home/$SPARK_USER/mempalace"
PALACE_PATH="$REMOTE_DIR/palace"

if [ -z "${SSH_PASS:-}" ]; then
    echo "ERROR: SSH_PASS not set"
    exit 1
fi

SSH="sshpass -p $SSH_PASS ssh -o StrictHostKeyChecking=no $SPARK_USER@$SPARK_HOST"
SCP="sshpass -p $SSH_PASS scp -o StrictHostKeyChecking=no"

echo "=== Step 1: Create directories on Spark ==="
$SSH "mkdir -p $REMOTE_DIR/palace"

echo "=== Step 2: Copy API server to Spark ==="
$SCP tools/mempalace/api-server.py $SPARK_USER@$SPARK_HOST:$REMOTE_DIR/api-server.py

echo "=== Step 3: Install Python dependencies (venv) ==="
$SSH "
    if [ ! -d $REMOTE_DIR/.venv ]; then
        echo 'Creating venv...'
        python3 -m venv $REMOTE_DIR/.venv
    fi
    source $REMOTE_DIR/.venv/bin/activate
    pip install --upgrade pip 2>&1 | tail -1
    pip install mempalace==3.3.4 fastapi uvicorn 2>&1 | tail -5
"

VENV_PYTHON="$REMOTE_DIR/.venv/bin/python3"

echo "=== Step 4: Initialize palace (if not already done) ==="
$SSH "
    export MEMPALACE_PALACE_PATH=$REMOTE_DIR/palace
    source $REMOTE_DIR/.venv/bin/activate
    if [ ! -f $REMOTE_DIR/palace/chroma.sqlite3 ]; then
        echo 'Initializing palace...'
        mkdir -p $REMOTE_DIR/palace
        python3 -c \"
from mempalace.config import MempalaceConfig
from mempalace.backends.chroma import ChromaBackend
from mempalace.knowledge_graph import KnowledgeGraph
import os
os.environ['MEMPALACE_PALACE_PATH'] = '$REMOTE_DIR/palace'
c = MempalaceConfig()
client = ChromaBackend.make_client(c.palace_path)
col = client.get_or_create_collection('mempalace_drawers')
kg = KnowledgeGraph(db_path=os.path.join(c.palace_path, 'knowledge_graph.sqlite3'))
print('Palace initialized:', c.palace_path)
print('Collection:', col.name, 'count:', col.count())
print('KG:', kg.stats())
kg.close()
\"
    else
        echo 'Palace already exists.'
    fi
"

echo "=== Step 5: Start API server ==="
# pkill pattern is tight enough to NOT match the SSH bash wrapper that contains
# "api-server.py" as an argv string. Matching "venv/bin/python.*api-server.py"
# only kills the actual python process.
$SSH "
    pkill -f 'venv/bin/python.*api-server.py' 2>/dev/null || true
    sleep 1

    cd $REMOTE_DIR
    export MEMPALACE_PALACE_PATH=$REMOTE_DIR/palace
    export MEMPALACE_PORT=8100
    nohup $REMOTE_DIR/.venv/bin/python3 api-server.py >> api-server.log 2>&1 < /dev/null &
    disown
    echo \"Started with PID \$!\"
    sleep 5
    curl -sf http://localhost:8100/health && echo '' || echo 'Local health check failed — check api-server.log'
"

echo "=== Step 6: Add @reboot cron entry ==="
$SSH "
    CRON_CMD='@reboot cd $REMOTE_DIR && MEMPALACE_PALACE_PATH=$PALACE_PATH MEMPALACE_PORT=8100 $REMOTE_DIR/.venv/bin/python3 api-server.py >> api-server.log 2>&1'
    if crontab -l 2>/dev/null | grep -q 'api-server.py'; then
        echo 'Cron entry already exists.'
    else
        (crontab -l 2>/dev/null; echo \"\$CRON_CMD\") | crontab -
        echo 'Added @reboot cron entry.'
    fi
"

echo "=== Step 7: Verify ==="
echo -n "Health check: "
curl -sf http://$SPARK_HOST:8100/health && echo "" || echo "FAILED — check logs on Spark"

echo ""
echo "=== Deploy complete ==="
echo "MemPalace API running at http://$SPARK_HOST:8100"
echo ""
echo "Verify status: curl http://$SPARK_HOST:8100/status"
echo "Mine training data into canon/facility_ai wings: bash tools/mempalace/mine-training-data.sh (in dcc repo)"
