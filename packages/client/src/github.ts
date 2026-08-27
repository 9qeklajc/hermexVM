import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  ApplesauceRelayPool,
  EncryptionMode,
  NostrClientTransport,
  PrivateKeySigner,
} from "@contextvm/sdk";
import {
  GITHUB_USER_TOOL_NAME,
  GITHUB_ORGS_LIST_TOOL_NAME,
  GITHUB_ORGS_REPOS_TOOL_NAME,
  GITHUB_REPOS_LIST_TOOL_NAME,
  GITHUB_REPO_GET_TOOL_NAME,
  GITHUB_BRANCHES_TOOL_NAME,
  GITHUB_REPOS_TAGS_TOOL_NAME,
  GITHUB_MILESTONES_LIST_TOOL_NAME,
  GITHUB_ISSUES_LIST_TOOL_NAME,
  GITHUB_ISSUE_GET_TOOL_NAME,
  GITHUB_ISSUE_CREATE_TOOL_NAME,
  GITHUB_ISSUE_COMMENTS_TOOL_NAME,
  GITHUB_ISSUE_COMMENT_ADD_TOOL_NAME,
  GITHUB_PRS_LIST_TOOL_NAME,
  GITHUB_PR_GET_TOOL_NAME,
  GITHUB_PR_FILES_TOOL_NAME,
  GITHUB_PR_MERGE_TOOL_NAME,
  GITHUB_PR_CLOSE_TOOL_NAME,
  GITHUB_PR_REVIEW_TOOL_NAME,
  GITHUB_PR_REVIEWS_LIST_TOOL_NAME,
  GITHUB_PR_CHECKS_TOOL_NAME,
  GITHUB_COMMITS_LIST_TOOL_NAME,
  GITHUB_COMMITS_COMPARE_TOOL_NAME,
  GITHUB_FILE_GET_TOOL_NAME,
  GITHUB_RELEASES_LIST_TOOL_NAME,
  GITHUB_WORKFLOWS_LIST_TOOL_NAME,
  GITHUB_RUNS_LIST_TOOL_NAME,
  type GithubUser,
  type GithubOrg,
  type GithubTag,
  type GithubMilestone,
  type GithubRepo,
  type GithubBranch,
  type GithubIssue,
  type GithubComment,
  type GithubPullRequest,
  type GithubPullFile,
  type GithubCommit,
  type GithubCompare,
  type GithubFile,
  type GithubRelease,
  type GithubReview,
  type GithubCheckRun,
  type GithubWorkflow,
  type GithubRun,
} from "@contexcgi/protocol";
import { normalizePrivateKey, normalizePublicKey } from "./index.js";

export type GithubClientConfig = {
  privateKey: string;
  serverPubkey: string;
  relays?: string[];
  encryption?: EncryptionMode;
};

export class GithubClient {
  private readonly mcpClient: Client;
  private readonly transport: NostrClientTransport;

  constructor(config: GithubClientConfig) {
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

    this.mcpClient = new Client({ name: "github-client", version: "0.1.0" });
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

  // -- User --
  user(): Promise<GithubUser> {
    return this.call(GITHUB_USER_TOOL_NAME);
  }

  // -- Orgs --
  orgs(): Promise<GithubOrg[]> {
    return this.call(GITHUB_ORGS_LIST_TOOL_NAME);
  }
  orgRepos(org: string, limit?: number): Promise<GithubRepo[]> {
    return this.call(GITHUB_ORGS_REPOS_TOOL_NAME, { org, limit });
  }

  // -- Repos --
  repos(input?: { limit?: number; affiliation?: string }): Promise<GithubRepo[]> {
    return this.call(GITHUB_REPOS_LIST_TOOL_NAME, input ?? {});
  }
  repo(owner: string, repo: string): Promise<GithubRepo> {
    return this.call(GITHUB_REPO_GET_TOOL_NAME, { owner, repo });
  }
  branches(owner: string, repo: string): Promise<GithubBranch[]> {
    return this.call(GITHUB_BRANCHES_TOOL_NAME, { owner, repo });
  }
  tags(owner: string, repo: string, limit?: number): Promise<GithubTag[]> {
    return this.call(GITHUB_REPOS_TAGS_TOOL_NAME, { owner, repo, limit });
  }
  milestones(input: {
    owner: string;
    repo: string;
    state?: string;
    limit?: number;
  }): Promise<GithubMilestone[]> {
    return this.call(GITHUB_MILESTONES_LIST_TOOL_NAME, input);
  }

  // -- Issues --
  issues(input: {
    owner: string;
    repo: string;
    state?: string;
    limit?: number;
  }): Promise<GithubIssue[]> {
    return this.call(GITHUB_ISSUES_LIST_TOOL_NAME, input);
  }
  issue(owner: string, repo: string, number: number): Promise<GithubIssue> {
    return this.call(GITHUB_ISSUE_GET_TOOL_NAME, { owner, repo, number });
  }
  createIssue(input: {
    owner: string;
    repo: string;
    title: string;
    body?: string;
    labels?: string[];
    assignees?: string[];
  }): Promise<GithubIssue> {
    return this.call(GITHUB_ISSUE_CREATE_TOOL_NAME, input);
  }
  comments(input: {
    owner: string;
    repo: string;
    number: number;
    limit?: number;
  }): Promise<GithubComment[]> {
    return this.call(GITHUB_ISSUE_COMMENTS_TOOL_NAME, input);
  }
  addComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<GithubComment> {
    return this.call(GITHUB_ISSUE_COMMENT_ADD_TOOL_NAME, {
      owner,
      repo,
      number,
      body,
    });
  }

  // -- Pull requests --
  prs(input: {
    owner: string;
    repo: string;
    state?: string;
    limit?: number;
  }): Promise<GithubPullRequest[]> {
    return this.call(GITHUB_PRS_LIST_TOOL_NAME, input);
  }
  pr(owner: string, repo: string, number: number): Promise<GithubPullRequest> {
    return this.call(GITHUB_PR_GET_TOOL_NAME, { owner, repo, number });
  }
  prFiles(input: {
    owner: string;
    repo: string;
    number: number;
    limit?: number;
  }): Promise<GithubPullFile[]> {
    return this.call(GITHUB_PR_FILES_TOOL_NAME, input);
  }
  mergePr(input: {
    owner: string;
    repo: string;
    number: number;
    style?: string;
  }): Promise<{ merged: boolean }> {
    return this.call(GITHUB_PR_MERGE_TOOL_NAME, input);
  }
  closePr(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GithubPullRequest> {
    return this.call(GITHUB_PR_CLOSE_TOOL_NAME, { owner, repo, number });
  }
  reviews(input: {
    owner: string;
    repo: string;
    number: number;
    limit?: number;
  }): Promise<GithubReview[]> {
    return this.call(GITHUB_PR_REVIEWS_LIST_TOOL_NAME, input);
  }
  submitReview(input: {
    owner: string;
    repo: string;
    number: number;
    event: string;
    body?: string;
  }): Promise<GithubReview> {
    return this.call(GITHUB_PR_REVIEW_TOOL_NAME, input);
  }
  checks(input: {
    owner: string;
    repo: string;
    number: number;
    limit?: number;
  }): Promise<GithubCheckRun[]> {
    return this.call(GITHUB_PR_CHECKS_TOOL_NAME, input);
  }

  // -- Commits & compare --
  commits(input: {
    owner: string;
    repo: string;
    branch?: string;
    limit?: number;
  }): Promise<GithubCommit[]> {
    return this.call(GITHUB_COMMITS_LIST_TOOL_NAME, input);
  }
  compare(
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<GithubCompare> {
    return this.call(GITHUB_COMMITS_COMPARE_TOOL_NAME, {
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
  }): Promise<GithubFile> {
    return this.call(GITHUB_FILE_GET_TOOL_NAME, input);
  }

  // -- Releases --
  releases(input: {
    owner: string;
    repo: string;
    limit?: number;
  }): Promise<GithubRelease[]> {
    return this.call(GITHUB_RELEASES_LIST_TOOL_NAME, input);
  }

  // -- Workflows & runs --
  workflows(owner: string, repo: string): Promise<GithubWorkflow[]> {
    return this.call(GITHUB_WORKFLOWS_LIST_TOOL_NAME, { owner, repo });
  }
  runs(input: {
    owner: string;
    repo: string;
    branch?: string;
    limit?: number;
  }): Promise<GithubRun[]> {
    return this.call(GITHUB_RUNS_LIST_TOOL_NAME, input);
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
