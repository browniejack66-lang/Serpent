// @vitest-environment happy-dom
import { act, createElement, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AssetContextMenu } from "../../src/renderer/AssetContextMenu";
import { ContextMenuProvider, useContextMenu, type ContextMenuDescriptor } from "../../src/renderer/context-menu";
import { LocaleProvider } from "../../src/renderer/i18n";
import { folderPrivacyInputSchema, type FolderPrivacyInput, type FolderPrivacyState } from "../../src/shared/folder-privacy";

type Props = ComponentProps<typeof AssetContextMenu>;
const descriptor: ContextMenuDescriptor = { type: "folder", folderId: "folder-1", name: "Protected", locationKind: "managed" };
function Launcher() {
  const menu = useContextMenu();
  return createElement("button", { onClick: () => menu.open(descriptor, { x: 10, y: 10 }) }, "Open folder menu");
}
// Only folder privacy actions run in this fixture; unrelated commands stay idle.
const props = {
  libraryId: "library-1", tags: [], collections: [], linkedFolders: [], managedFolders: [], smartCollections: [], assets: [],
  activeCollectionId: null, customFolderCoverIds: new Set<string>(),
  onLoadCollectionMemberships: async () => [],
} as unknown as Props;

describe("folder privacy desktop actions", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  let notify: ((event: { libraryId: string }) => void) | undefined;
  let states: FolderPrivacyState[];
  let failUnlock: boolean;
  const folderPrivacy = vi.fn(async (input: FolderPrivacyInput) => {
    folderPrivacyInputSchema.parse(input);
    if (input.action === "status") return { ok: true, value: states };
    if (failUnlock) return { ok: false, error: { code: "FOLDER_PRIVACY_PASSWORD_INVALID", message: "Incorrect password" } };
    // Main broadcasts this before the mutation response reaches the renderer.
    notify?.({ libraryId: input.libraryId });
    return { ok: true, value: states };
  });
  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove(); root = undefined; container = undefined;
    vi.unstubAllGlobals(); vi.restoreAllMocks(); folderPrivacy.mockClear();
  });
  async function render(libraryId = "library-1") {
    if (!root) {
      states = []; failUnlock = false;
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      vi.stubGlobal("serpent", { library: { folderPrivacy, onFolderPrivacyChanged: (handler: typeof notify) => { notify = handler; return () => { notify = undefined; }; } } });
      container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    }
    await act(async () => root?.render(createElement(LocaleProvider, { initialPreference: "en", children:
      createElement(ContextMenuProvider, { children: [createElement(Launcher, { key: "launcher" }), createElement(AssetContextMenu, { ...props, libraryId, key: "menu" })] })
    })));
  }
  async function click(text: string) {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent === text);
    expect(button, text).toBeDefined();
    await act(async () => button?.click());
  }
  async function open() { await click("Open folder menu"); await click("Privacy lock…"); }
  async function fill(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  async function submit() {
    await act(async () => document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  }
  it("sends a schema-valid protect request and closes despite its own privacy notification", async () => {
    await render(); await open();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Folder privacy · Protected");
    const inputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    await fill(inputs[0]!, "test password"); await fill(inputs[1]!, "test password");
    await submit();
    expect(folderPrivacy).toHaveBeenLastCalledWith({ libraryId: "library-1", folderId: "folder-1", action: "protect", password: "test password" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("keeps failed unlocks in the dialog and clears the entered password", async () => {
    await render(); states = [{ folderId: "folder-1", locked: true }]; failUnlock = true; await open();
    await fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, "wrong"); await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Incorrect password");
    expect(document.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("");
    expect(document.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false);
  });
  it("requires the current password and folder-name confirmation to remove protection", async () => {
    await render(); states = [{ folderId: "folder-1", locked: false }]; await open();
    const select = document.querySelector<HTMLSelectElement>("select")!;
    await act(async () => { select.value = "remove"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await fill(document.querySelector<HTMLInputElement>('input[type="password"]')!, "current password");
    await fill(document.querySelector<HTMLInputElement>('input[autocomplete="off"]')!, "wrong name"); await submit();
    expect(folderPrivacy).toHaveBeenCalledTimes(1);
    await fill(document.querySelector<HTMLInputElement>('input[autocomplete="off"]')!, "Protected"); await submit();
    expect(folderPrivacy).toHaveBeenLastCalledWith({ libraryId: "library-1", folderId: "folder-1", action: "remove", password: "current password" });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("discards an open password dialog when switching libraries", async () => {
    await render(); await open();
    await render("library-2");
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(folderPrivacy).toHaveBeenCalledTimes(1);
  });
});
