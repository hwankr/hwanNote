import { describe, expect, it } from "vitest";
import { isSameAutoSaveDirInfo } from "./autoSaveDirInfo";
import type { AutoSaveDirInfo } from "./tauriApi";

const base: AutoSaveDirInfo = {
  customDir: "D:/notes",
  effectiveDir: "D:/notes",
  isDefault: false,
  status: "available",
  expectedDir: "D:/notes",
  error: null
};

describe("isSameAutoSaveDirInfo", () => {
  it("treats separately read reports with equal fields as the same", () => {
    expect(isSameAutoSaveDirInfo(base, { ...base })).toBe(true);
    expect(isSameAutoSaveDirInfo(null, null)).toBe(true);
  });

  it("treats a missing report as different from a loaded one", () => {
    expect(isSameAutoSaveDirInfo(null, base)).toBe(false);
    expect(isSameAutoSaveDirInfo(base, null)).toBe(false);
  });

  it.each([
    ["customDir", { customDir: null }],
    ["effectiveDir", { effectiveDir: null }],
    ["isDefault", { isDefault: true }],
    ["status", { status: "unavailable" }],
    ["expectedDir", { expectedDir: "E:/notes" }],
    ["error", { error: "custom_auto_save_dir_unavailable" }]
  ] as const)("detects a change in %s", (_field, change) => {
    expect(isSameAutoSaveDirInfo(base, { ...base, ...change })).toBe(false);
  });
});
