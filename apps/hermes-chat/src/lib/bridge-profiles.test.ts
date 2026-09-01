import { describe, expect, it } from "vitest";
import type { HermesConfig } from "./api";
import {
  addBridgeProfile,
  deleteBridgeProfile,
  parseStoredConnections,
  sameBridgeIdentity,
  switchBridgeProfile,
  updateBridgeProfile,
} from "./bridge-profiles";

const HOME: HermesConfig = {
  privateKey: "home-client-key",
  serverPubkey: "home-bridge-key",
  relays: ["wss://home.example"],
};
const WORK: HermesConfig = {
  privateKey: "work-client-key",
  serverPubkey: "work-bridge-key",
  relays: ["wss://work.example"],
};

describe("bridge profiles", () => {
  it("migrates the legacy single connection into a named profile", () => {
    const state = parseStoredConnections(JSON.stringify(HOME));

    expect(state?.profiles).toHaveLength(1);
    expect(state?.profiles[0]).toMatchObject({
      name: "My bridge",
      config: HOME,
    });
    expect(state?.activeId).toBe(state?.profiles[0]?.id);
  });

  it("stores multiple named bridges and switches the active config", () => {
    const initial = parseStoredConnections(JSON.stringify(HOME));
    expect(initial).not.toBeNull();

    const withWork = addBridgeProfile(initial!, "Work", WORK);
    const switched = switchBridgeProfile(withWork, withWork.profiles[1]!.id);

    expect(switched.profiles.map((profile) => profile.name)).toEqual([
      "My bridge",
      "Work",
    ]);
    expect(switched.activeId).toBe(withWork.profiles[1]!.id);
    expect(
      switched.profiles.find((profile) => profile.id === switched.activeId)
        ?.config,
    ).toEqual(WORK);
  });

  it("distinguishes identity rotation from a relay-only edit", () => {
    expect(
      sameBridgeIdentity(HOME, {
        ...HOME,
        relays: ["wss://new-home.example"],
      }),
    ).toBe(true);
    expect(
      sameBridgeIdentity(HOME, { ...HOME, serverPubkey: "rotated-server" }),
    ).toBe(false);
    expect(
      sameBridgeIdentity(HOME, { ...HOME, privateKey: "rotated-client" }),
    ).toBe(false);
  });

  it("renames and edits one bridge without changing the others", () => {
    const initial = addBridgeProfile(
      parseStoredConnections(JSON.stringify(HOME))!,
      "Work",
      WORK,
    );
    const homeId = initial.profiles[0]!.id;
    const updated = updateBridgeProfile(initial, homeId, "Home server", {
      ...HOME,
      relays: ["wss://new-home.example"],
    });

    expect(updated.profiles[0]).toMatchObject({
      id: homeId,
      name: "Home server",
      config: { relays: ["wss://new-home.example"] },
    });
    expect(updated.profiles[1]?.config).toEqual(WORK);
  });

  it("selects another profile when the active bridge is deleted", () => {
    const initial = addBridgeProfile(
      parseStoredConnections(JSON.stringify(HOME))!,
      "Work",
      WORK,
    );
    const workId = initial.profiles[1]!.id;
    const activeWork = switchBridgeProfile(initial, workId);
    const afterDelete = deleteBridgeProfile(activeWork, workId);

    expect(afterDelete?.profiles).toHaveLength(1);
    expect(afterDelete?.activeId).toBe(initial.profiles[0]!.id);
    expect(
      deleteBridgeProfile(afterDelete!, initial.profiles[0]!.id),
    ).toBeNull();
  });

  it("rejects corrupt stored profile data", () => {
    expect(parseStoredConnections("not json")).toBeNull();
    expect(
      parseStoredConnections(JSON.stringify({ profiles: [], activeId: "x" })),
    ).toBeNull();
    expect(
      parseStoredConnections(
        JSON.stringify({
          profiles: [{ id: "x", name: "", config: HOME }],
          activeId: "x",
        }),
      ),
    ).toBeNull();
  });
});
