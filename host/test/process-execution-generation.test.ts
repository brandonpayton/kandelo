import { describe, expect, it } from "vitest";
import { ProcessExecutionGenerationAllocator } from "../src/process-execution-generation";

describe("process execution generation", () => {
  it("hands out a distinct number for every execution image", () => {
    const allocator = new ProcessExecutionGenerationAllocator();
    expect([
      allocator.allocate(),
      allocator.allocate(),
      allocator.allocate(),
    ]).toEqual([1, 2, 3]);
  });

  it("counts from one per allocator, so two keepers overlap", () => {
    const keeper = new ProcessExecutionGenerationAllocator();
    const receiver = new ProcessExecutionGenerationAllocator();
    expect(keeper.allocate()).toBe(receiver.allocate());
  });

  it("refuses to hand out a number a checkpoint could not carry", () => {
    const allocator = new ProcessExecutionGenerationAllocator();
    (allocator as unknown as { next: number }).next = Number.MAX_SAFE_INTEGER;
    expect(allocator.allocate()).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => allocator.allocate()).toThrow(
      "process execution generation space exhausted",
    );
  });
});
