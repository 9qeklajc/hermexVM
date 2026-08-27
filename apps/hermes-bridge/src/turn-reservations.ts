/**
 * Synchronous in-process exclusion for destination conversations. JavaScript
 * runs each reserve() call without an await boundary, so two completed resume
 * requests cannot both pass the check.
 */
export class TurnReservations {
  private readonly owners = new Map<string, string>();

  private key(agentId: string, chatId: string): string {
    return `${agentId}\u0000${chatId}`;
  }

  reserve(agentId: string, chatId: string, owner: string): () => void {
    const key = this.key(agentId, chatId);
    const current = this.owners.get(key);
    if (current) {
      throw new Error("destination conversation already has a running turn");
    }
    this.owners.set(key, owner);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (this.owners.get(key) === owner) this.owners.delete(key);
    };
  }

  clear(): void {
    this.owners.clear();
  }
}
