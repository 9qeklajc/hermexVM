import { describe, expect, it, vi } from "vitest";
import { encodeStreamEvent } from "@contexcgi/protocol";
import {
  ContexcgiClient,
  normalizePrivateKey,
  normalizePublicKey,
  readConversationEvents,
} from "./index.js";

describe("readConversationEvents", () => {
  it("parses ContextVM CEP-41 JSONL chunks into conversation events", async () => {
    const stream = async function* () {
      yield {
        value:
          encodeStreamEvent({
            type: "run.started",
            discussionId: "discussion-1",
            runId: "run-1",
            agentId: "codex",
          }) +
          encodeStreamEvent({
            type: "assistant.delta",
            discussionId: "discussion-1",
            runId: "run-1",
            agentId: "codex",
            text: "hello",
          }),
      };
      yield {
        value: encodeStreamEvent({
          type: "run.completed",
          discussionId: "discussion-1",
          runId: "run-1",
          agentId: "codex",
          content: "hello",
        }),
      };
    };

    const events = [];
    for await (const event of readConversationEvents(stream())) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[1]).toMatchObject({ type: "assistant.delta", text: "hello" });
  });
});

describe("key normalization", () => {
  it("accepts hex and nip19 keys", () => {
    expect(normalizePrivateKey("1".padStart(64, "0"))).toBe(
      "1".padStart(64, "0"),
    );
    expect(
      normalizePrivateKey(
        "nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsmhltgl",
      ),
    ).toBe("1".padStart(64, "0"));
    expect(normalizePublicKey("1".repeat(64))).toBe("1".repeat(64));
    expect(
      normalizePublicKey(
        "npub1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygse4sl3h",
      ),
    ).toBe("1".repeat(64));
  });
});

describe("ContexcgiClient metadata calls", () => {
  it("reads agents, discussions, and one discussion from structured tool results", async () => {
    const client = new ContexcgiClient({
      privateKey: "1".padStart(64, "0"),
      serverPubkey: "1".repeat(64),
      relays: ["ws://localhost:10547"],
    });
    const callTool = vi.fn(async ({ name }: { name: string }) => {
      if (name === "contexcgi.agents.list") {
        return {
          structuredContent: {
            agents: [
              {
                id: "claude-code",
                label: "Claude Code",
                adapterKind: "claude-code",
                capabilities: {
                  streaming: true,
                  sessionResume: true,
                  workspace: true,
                  tools: true,
                },
              },
            ],
          },
        };
      }
      if (name === "contexcgi.discussions.list") {
        return {
          structuredContent: {
            discussions: [
              {
                id: "d1",
                createdAt: "a",
                updatedAt: "b",
                participantAgentIds: [],
              },
            ],
          },
        };
      }
      if (name === "contexcgi.binaries.list") {
        return {
          structuredContent: {
            binaries: [
              {
                id: "agent.apk",
                name: "Agent APK",
                version: "1.0.0",
                platform: "android",
                filename: "agent.apk",
                sizeBytes: 5,
                sha256:
                  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
                mimeType: "application/vnd.android.package-archive",
                createdAt: "a",
              },
            ],
          },
        };
      }
      if (name === "contexcgi.binaries.get") {
        return {
          structuredContent: {
            binary: {
              id: "agent.apk",
              name: "Agent APK",
              version: "1.0.0",
              platform: "android",
              filename: "agent.apk",
              sizeBytes: 5,
              sha256:
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
              mimeType: "application/vnd.android.package-archive",
              createdAt: "a",
            },
          },
        };
      }
      if (name === "contexcgi.binaries.download") {
        return {
          structuredContent: {
            binary: {
              id: "agent.apk",
              name: "Agent APK",
              version: "1.0.0",
              platform: "android",
              filename: "agent.apk",
              sizeBytes: 5,
              sha256:
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
              mimeType: "application/vnd.android.package-archive",
              createdAt: "a",
            },
            encoding: "base64",
            contentBase64: "aGVsbG8=",
            sha256:
              "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
          },
        };
      }
      if (name === "contexcgi.localSessions.list") {
        return {
          structuredContent: {
            sessions: [
              {
                id: "claude:s1:/tmp/s1.jsonl",
                provider: "claude-code",
                sessionId: "s1",
                path: "/tmp/s1.jsonl",
                relativePath: ".claude/projects/repo/s1.jsonl",
                createdAt: "a",
                updatedAt: "b",
                sizeBytes: 10,
              },
            ],
          },
        };
      }
      if (name === "contexcgi.localSessions.get") {
        return {
          structuredContent: {
            session: {
              id: "claude:s1:/tmp/s1.jsonl",
              provider: "claude-code",
              sessionId: "s1",
              path: "/tmp/s1.jsonl",
              relativePath: ".claude/projects/repo/s1.jsonl",
              createdAt: "a",
              updatedAt: "b",
              sizeBytes: 10,
              content: '{"type":"session"}\n',
            },
          },
        };
      }
      return {
        structuredContent: {
          discussion: {
            id: "d1",
            createdAt: "a",
            updatedAt: "b",
            participantAgentIds: [],
          },
          messages: [],
          sessions: [],
        },
      };
    });
    (
      client as unknown as { mcpClient: { callTool: typeof callTool } }
    ).mcpClient = { callTool };

    await expect(client.listAgents()).resolves.toHaveLength(1);
    await expect(client.listDiscussions()).resolves.toHaveLength(1);
    await expect(client.listBinaries({ platform: "android" })).resolves.toEqual(
      [expect.objectContaining({ id: "agent.apk" })],
    );
    await expect(client.getBinary("agent.apk")).resolves.toMatchObject({
      id: "agent.apk",
      platform: "android",
    });
    await expect(client.downloadBinary("agent.apk")).resolves.toMatchObject({
      binary: expect.objectContaining({ id: "agent.apk" }),
      bytes: new Uint8Array([104, 101, 108, 108, 111]),
    });
    await expect(client.listLocalSessions()).resolves.toHaveLength(1);
    await expect(
      client.getLocalSessionContent("claude:s1:/tmp/s1.jsonl"),
    ).resolves.toMatchObject({ content: '{"type":"session"}\n' });
    await expect(client.getDiscussion("d1")).resolves.toMatchObject({
      discussion: { id: "d1" },
    });
  });
});
