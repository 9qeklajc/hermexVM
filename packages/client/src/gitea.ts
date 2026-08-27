import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ApplesauceRelayPool,
  EncryptionMode,
  NostrClientTransport,
  PrivateKeySigner,
} from "@contextvm/sdk";
import {
  GITEA_USER_TOOL_NAME,
  GITEA_ORGS_LIST_TOOL_NAME,
  GITEA_ORGS_REPOS_TOOL_NAME,
  GITEA_REPOS_LIST_TOOL_NAME,
  GITEA_REPOS_GET_TOOL_NAME,
  GITEA_REPOS_BRANCHES_TOOL_NAME,
  GITEA_REPOS_TAGS_TOOL_NAME,
  GITEA_MILESTONES_LIST_TOOL_NAME,
  GITEA_ISSUES_LIST_TOOL_NAME,
  GITEA_ISSUES_GET_TOOL_NAME,
  GITEA_ISSUES_CREATE_TOOL_NAME,
  GITEA_ISSUES_COMMENTS_TOOL_NAME,
  GITEA_ISSUES_COMMENT_ADD_TOOL_NAME,
  GITEA_ISSUES_LABELS_TOOL_NAME,
  GITEA_PULLS_LIST_TOOL_NAME,
  GITEA_PULLS_GET_TOOL_NAME,
  GITEA_PULLS_FILES_TOOL_NAME,
  GITEA_PULLS_MERGE_TOOL_NAME,
  GITEA_PULLS_CLOSE_TOOL_NAME,
  GITEA_COMMITS_LIST_TOOL_NAME,
  GITEA_COMMITS_COMPARE_TOOL_NAME,
  GITEA_FILE_GET_TOOL_NAME,
  GITEA_RELEASES_LIST_TOOL_NAME,
  GITEA_RELEASES_CREATE_TOOL_NAME,
  type GiteaUser,
  type GiteaOrg,
  type GiteaRepo,
  type GiteaBranch,
  type GiteaTag,
  type GiteaMilestone,
  type GiteaIssue,
  type GiteaComment,
  type GiteaLabel,
  type GiteaPullRequest,
  type GiteaPullFile,
  type GiteaCommit,
  type GiteaCompare,
  type GiteaFile,
  type GiteaRelease,
} from "@contexcgi/protocol";
import { normalizePrivateKey, normalizePublicKey } from "./index.js";

export type GiteaClientConfig = {
  privateKey: string;
  serverPubkey: string;
  relays?: string[];
  encryption?: EncryptionMode;
};

export class GiteaClient {
  private readonly mcpClient: Client;
  private readonly transport: NostrClientTransport;

  constructor(config: GiteaClientConfig) {
    const relays = config.relays ?? [];
    this.transport = new NostrClientTransport({
      signer: new PrivateKeySigner(normalizePrivateKey(config.privateKey)),
      relayHandler: new ApplesauceRelayPool(relays, {
        pingFrequencyMs: 2_147_400_000,
      }),
      discoveryRelayUrls: [],
      fallbackOperationalRelayUrls: relays,
      serverPubkey: normalizePublicKey(config.serverPubkey),
      encryptionMode: config.encryption ?? EncryptionMode.OPTIONAL,
      openStream: {
        enabled: true,
        policy: {
          closeGracePeriodMs: 120_000,
          idleTimeoutMs: 600_000,
          probeTimeoutMs: 60_000,
          maxBufferedChunksPerStream: 5_000,
          maxBufferedBytesPerStream: 64 * 1024 * 1024,
        },
      },
      oversizedTransfer: {
        enabled: true,
        thresholdBytes: 48_000,
        chunkSizeBytes: 48_000,
        policy: {
          maxTransferBytes: 16 * 1024 * 1024,
          maxTransferChunks: 10_000,
        },
      },
    });

    // Phone clock guard — same as all other clients.
    const SINCE_GUARD_SECONDS = 3600;
    type SubFilter = Record<string, unknown> & { since?: number };
    const patchTarget = this.transport as unknown as {
      createSubscriptionFilters: (
        targetPubkey: string,
        additionalFilters?: Record<string, unknown>,
      ) => SubFilter[];
    };
    const buildFilters =
      patchTarget.createSubscriptionFilters.bind(patchTarget);
    patchTarget.createSubscriptionFilters = (
      targetPubkey,
      additionalFilters = {},
    ) =>
      buildFilters(targetPubkey, additionalFilters).map((filter) => ({
        ...filter,
        since: Math.max(
          0,
          (filter.since ?? Math.floor(Date.now() / 1000)) - SINCE_GUARD_SECONDS,
        ),
      }));

    this.mcpClient = new Client({ name: "gitea-client", version: "0.1.0" });
  }

  async connect(): Promise<void> {
    await this.mcpClient.connect(this.transport);
  }
  async close(): Promise<void> {
    await this.mcpClient.close();
  }

  private async call<T>(
    name: string,
    args: Record<string, unknown> = {},
    options?: RequestOptions,
  ): Promise<T> {
    const result = await this.mcpClient.callTool(
      { name, arguments: args },
      undefined,
      options,
    );
    if (result.isError) {
      const content = Array.isArray(result.content) ? result.content : [];
      const message = content
        .filter(
          (item): item is { type: "text"; text: string } =>
            item.type === "text" && typeof item.text === "string",
        )
        .map((item) => item.text)
        .join("\n");
      throw new Error(message || `${name} failed`);
    }
    return readStructured<T>(result);
  }

  // -- User & orgs --
  user(): Promise<GiteaUser> {
    return this.call(GITEA_USER_TOOL_NAME);
  }
  orgs(): Promise<GiteaOrg[]> {
    return this.call(GITEA_ORGS_LIST_TOOL_NAME);
  }
  orgRepos(org: string, limit?: number, page?: number): Promise<GiteaRepo[]> {
    return this.call(GITEA_ORGS_REPOS_TOOL_NAME, { org, limit, page });
  }

  // -- Repos --
  repos(input?: { limit?: number; page?: number }): Promise<GiteaRepo[]> {
    return this.call(GITEA_REPOS_LIST_TOOL_NAME, input ?? {});
  }
  repo(owner: string, repo: string): Promise<GiteaRepo> {
    return this.call(GITEA_REPOS_GET_TOOL_NAME, { owner, repo });
  }
  branches(owner: string, repo: string): Promise<GiteaBranch[]> {
    return this.call(GITEA_REPOS_BRANCHES_TOOL_NAME, { owner, repo });
  }
  tags(owner: string, repo: string, limit?: number): Promise<GiteaTag[]> {
    return this.call(GITEA_REPOS_TAGS_TOOL_NAME, { owner, repo, limit });
  }
  milestones(input: {
    owner: string;
    repo: string;
    state?: string;
    limit?: number;
  }): Promise<GiteaMilestone[]> {
    return this.call(GITEA_MILESTONES_LIST_TOOL_NAME, input);
  }

  // -- Issues --
  issues(input: {
    owner: string;
    repo: string;
    state?: string;
    limit?: number;
    page?: number;
  }): Promise<GiteaIssue[]> {
    return this.call(GITEA_ISSUES_LIST_TOOL_NAME, input);
  }
  issue(owner: string, repo: string, number: number): Promise<GiteaIssue> {
    return this.call(GITEA_ISSUES_GET_TOOL_NAME, { owner, repo, number });
  }
  createIssue(input: {
    owner: string;
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  }): Promise<GiteaIssue> {
    return this.call(GITEA_ISSUES_CREATE_TOOL_NAME, input);
  }
  comments(input: {
    owner: string;
    repo: string;
    number: number;
    limit?: number;
    page?: number;
  }): Promise<GiteaComment[]> {
    return this.call(GITEA_ISSUES_COMMENTS_TOOL_NAME, input);
  }
  addComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<GiteaComment> {
    return this.call(GITEA_ISSUES_COMMENT_ADD_TOOL_NAME, {
      owner,
      repo,
      number,
      body,
    });
  }
  labels(owner: string, repo: string): Promise<GiteaLabel[]> {
    return this.call(GITEA_ISSUES_LABELS_TOOL_NAME, { owner, repo });
  }

  // -- Pull requests --
  pulls(input: {
    owner: string;
    repo: string;
    state?: string;
    limit?: number;
    page?: number;
  }): Promise<GiteaPullRequest[]> {
    return this.call(GITEA_PULLS_LIST_TOOL_NAME, input);
  }
  pull(owner: string, repo: string, number: number): Promise<GiteaPullRequest> {
    return this.call(GITEA_PULLS_GET_TOOL_NAME, { owner, repo, number });
  }
  pullFiles(input: {
    owner: string;
    repo: string;
    number: number;
    limit?: number;
  }): Promise<GiteaPullFile[]> {
    return this.call(GITEA_PULLS_FILES_TOOL_NAME, input);
  }
  mergePull(input: {
    owner: string;
    repo: string;
    number: number;
    style?: string;
  }): Promise<{ merged: boolean }> {
    return this.call(GITEA_PULLS_MERGE_TOOL_NAME, input);
  }
  closePull(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GiteaPullRequest> {
    return this.call(GITEA_PULLS_CLOSE_TOOL_NAME, { owner, repo, number });
  }

  // -- Commits & compare --
  commits(input: {
    owner: string;
    repo: string;
    branch?: string;
    limit?: number;
    page?: number;
  }): Promise<GiteaCommit[]> {
    return this.call(GITEA_COMMITS_LIST_TOOL_NAME, input);
  }
  compare(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<GiteaCompare> {
    return this.call(GITEA_COMMITS_COMPARE_TOOL_NAME, {
      owner,
      repo,
      base,
      head,
    });
  }

  // -- File content --
  file(input: {
    owner: string;
    repo: string;
    path: string;
    branch?: string;
  }): Promise<GiteaFile> {
    return this.call(GITEA_FILE_GET_TOOL_NAME, input);
  }

  // -- Releases --
  releases(input: {
    owner: string;
    repo: string;
    limit?: number;
    page?: number;
  }): Promise<GiteaRelease[]> {
    return this.call(GITEA_RELEASES_LIST_TOOL_NAME, input);
  }
  createRelease(input: {
    owner: string;
    repo: string;
    tagName: string;
    title?: string;
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
  }): Promise<GiteaRelease> {
    return this.call(GITEA_RELEASES_CREATE_TOOL_NAME, input);
  }
}

function readStructured<T>(result: unknown): T {
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  if (
    structured &&
    typeof structured === "object" &&
    !Array.isArray(structured) &&
    "items" in structured
  ) {
    return (structured as { items: T }).items;
  }
  return structured as T;
}
