import { expect, it } from "vitest";
import { safePolicyCommandArgument } from "../../../src/org-policy/workbench/command-arguments.js";

it("accepts safe command tokens and exact HTTPS registry origins", () => {
  for (const argument of [
    "--yes",
    "package@1.2.3",
    "--registry=https://registry.example",
    "--registry=https://registry.example:65535",
  ])
    expect(safePolicyCommandArgument(argument, ["--registry="]), argument).toBe(true);
});
it("rejects command metacharacters and registry credentials, paths, queries, fragments, and invalid ports", () => {
  for (const argument of [
    "/absolute",
    "../escape",
    "a;b",
    "a|b",
    "a&b",
    "a$HOME",
    "a>b",
    "a<b",
    "hidden\u202E",
    "--registry=http://registry.example",
    "--registry=https://user:pass@registry.example",
    "--registry=https://registry.example/path",
    "--registry=https://registry.example?q=x",
    "--registry=https://registry.example#hash",
    "--registry=https://registry.example:65536",
    "--registry=https://registry.example ",
  ])
    expect(safePolicyCommandArgument(argument, ["--registry="]), argument).toBe(false);
});
