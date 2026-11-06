import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useProject } from "@/platform/project";
import { useProjectRoots } from "@/platform/projectRoots";
import { BUILTIN_FILE_TEMPLATES } from "../files/builtins";
import { packageFor } from "../files/create";
import { renderFileTemplate } from "../files/model";

describe("template packages from Gradle roots", () => {
  let projectState: ReturnType<typeof useProject.getState>;
  let rootsState: ReturnType<typeof useProjectRoots.getState>;

  beforeEach(() => {
    projectState = useProject.getState();
    rootsState = useProjectRoots.getState();
    useProject.setState({
      project: { name: "p", root: "/p", trusted: true, isGit: false, settings: {} } as never,
      settings: {} as never,
    });
  });

  afterEach(() => {
    useProject.setState(projectState);
    useProjectRoots.setState(rootsState);
  });

  describe.each(["source", "test"] as const)("%s root", (kind) => {
    it.each([
      ["Gradle", "java"],
      ["Gradle", "kotlin"],
      ["app/Gradle", "java"],
      ["app/Gradle", "kotlin"],
    ])("uses %s for the %s template in a custom root", async (detectedFrom, templateId) => {
      useProjectRoots.setState({
        root: "/p",
        detected: [{ path: "gen/sources", kind, detectedFrom }],
      });
      const template = BUILTIN_FILE_TEMPLATES.find((t) => t.id === templateId)!;
      const packageName = await packageFor(template, "/p/gen/sources/com/acme");
      expect(packageName).toBe("com.acme");
      const { text } = renderFileTemplate(template.kinds[0]!.body, {
        name: "Example",
        fileName: `Example.${template.extension}`,
        packageName,
      });
      expect(text.split("\n")[0]).toBe(templateId === "java" ? "package com.acme;" : "package com.acme");
    });
  });
});
