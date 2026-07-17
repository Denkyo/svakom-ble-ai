import express from "express";
import crypto from "node:crypto";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SECRET = process.env.BRIDGE_SECRET || "";

let pendingCommand = null;
let bridgeLastSeen = 0;

function authorized(req) {
  if (!SECRET) return false;

  const supplied =
    req.query.secret ||
    req.headers["x-bridge-secret"] ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "");

  if (!supplied) return false;

  const expectedBuffer = Buffer.from(SECRET);
  const suppliedBuffer = Buffer.from(String(supplied));

  return (
    expectedBuffer.length === suppliedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  );
}

function queueCommand(command) {
  pendingCommand = command;
  return {
    queued: true,
    command,
    bridge_online: Date.now() - bridgeLastSeen < 5000
  };
}

function toolResult(data, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ],
    isError
  };
}

const tools = [
  {
    name: "toy_set_speed",
    description: "设置 SVAKOM 设备强度，范围为 0 到 1。可选持续秒数。",
    inputSchema: {
      type: "object",
      properties: {
        speed: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "强度，0 表示停止，1 表示最大强度"
        },
        sec: {
          type: "number",
          minimum: 0,
          maximum: 3600,
          description: "可选持续时间（秒）"
        }
      },
      required: ["speed"],
      additionalProperties: false
    }
  },
  {
    name: "toy_set_pattern",
    description: "设置 SVAKOM 振动花样和强度。花样范围 1 到 8。",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "integer",
          minimum: 1,
          maximum: 10
        },
        level: {
          type: "number",
          minimum: 0.1,
          maximum: 1,
          description: "花样强度，范围 0.2 到 1"
        },
        sec: {
          type: "number",
          minimum: 0,
          maximum: 3600
        }
      },
      required: ["pattern"],
      additionalProperties: false
    }
  },
  {
    name: "toy_stop",
    description: "立即停止 SVAKOM 设备。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "toy_status",
    description: "查询本地蓝牙中继是否在线。",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  }
];

app.get("/", (_req, res) => {
  res.json({
    service: "svakom-mcp-bridge",
    status: "ok"
  });
});

app.get("/toy-next", (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({ error: "unauthorized" });
  }

  bridgeLastSeen = Date.now();

  const command = pendingCommand;
  pendingCommand = null;

  res.json(command || { type: "hello" });
});

app.post("/mcp", (req, res) => {
  if (!authorized(req)) {
    return res.status(401).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { code: -32001, message: "Unauthorized" }
    });
  }

  const { id, method, params } = req.body || {};

  if (method === "notifications/initialized") {
    return res.status(202).end();
  }

  if (method === "initialize") {
    return res.json({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: "svakom-mcp-bridge",
          version: "1.0.0"
        }
      }
    });
  }

  if (method === "tools/list") {
    return res.json({
      jsonrpc: "2.0",
      id,
      result: { tools }
    });
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    let result;

    if (name === "toy_set_speed") {
      result = queueCommand({
        speed: Math.max(0, Math.min(1, Number(args.speed))),
        ...(args.sec ? { sec: Number(args.sec) } : {})
      });
    } else if (name === "toy_set_pattern") {
      result = queueCommand({
        pattern: Math.max(1, Math.min(10, Math.round(Number(args.pattern)))),
        level: Math.max(0.1, Math.min(1, Number(args.level ?? 0.5))),
        ...(args.sec ? { sec: Number(args.sec) } : {})
      });
    } else if (name === "toy_stop") {
      result = queueCommand({ stop: true });
    } else if (name === "toy_status") {
      result = {
        bridge_online: Date.now() - bridgeLastSeen < 5000,
        last_seen_seconds_ago: bridgeLastSeen
          ? Math.round((Date.now() - bridgeLastSeen) / 1000)
          : null,
        command_waiting: pendingCommand !== null
      };
    } else {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: toolResult({ error: `Unknown tool: ${name}` }, true)
      });
    }

    return res.json({
      jsonrpc: "2.0",
      id,
      result: toolResult(result)
    });
  }

  return res.status(404).json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: -32601,
      message: `Method not found: ${method}`
    }
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`SVAKOM MCP bridge listening on port ${PORT}`);
});
