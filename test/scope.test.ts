import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveAllowedRoots } from "../src/config";

let home: string;
let oldHome: string | undefined;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "delta-scope-"));
  oldHome = process.env.HOME;
  process.env.HOME = home;
  await mkdir(join(home, "project", "src", "deep"), { recursive: true });
  await writeFile(join(home, "project", "package.json"), "{}");
  await mkdir(join(home, "bare-folder", "sub"), { recursive: true });
});

afterAll(async () => {
  if (oldHome) process.env.HOME = oldHome;
  await rm(home, { recursive: true, force: true });
});

describe("resolveAllowedRoots — adaptive scope", () => {
  test("inside a project with markers → scoped to the project root", () => {
    expect(resolveAllowedRoots(join(home, "project", "src", "deep"))).toEqual([join(home, "project")]);
    expect(resolveAllowedRoots(join(home, "project", "src"))).toEqual([join(home, "project")]);
  });

  test("at the project root itself → scoped to it", () => {
    expect(resolveAllowedRoots(join(home, "project"))).toEqual([join(home, "project")]);
  });

  test("in a bare folder inside home (no markers) → global mode (/)", () => {
    expect(resolveAllowedRoots(join(home, "bare-folder", "sub"))).toEqual(["/"]);
  });

  test("at home dir → global mode (/)", () => {
    expect(resolveAllowedRoots(home)).toEqual(["/"]);
  });

  test("inside the project but nested under .git marker wins", async () => {
    const repo = join(home, "git-repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, "src"), { recursive: true });
    expect(resolveAllowedRoots(join(repo, "src"))).toEqual([repo]);
  });
});
