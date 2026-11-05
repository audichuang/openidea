import { describe, expect, it } from "vitest";
import type { NodeAt, SyntaxNode } from "@/bindings";
import { fileStem, isTopLevelTypeName, renamesFileInstead } from "./renameFallback";

const n = (kind: string, field: string | null = null): SyntaxNode => ({
  kind,
  range: { start: { line: 0, col: 0 }, end: { line: 0, col: 0 } },
  field,
  named: true,
  error: false,
  missing: false,
  hasError: false,
});
const at = (node: SyntaxNode, ...ancestors: string[]): NodeAt => ({ node, ancestors: ancestors.map((k) => n(k)) });

const topClass = at(n("identifier", "name"), "class_declaration", "program");

describe("fileStem", () => {
  it("strips the folder and the last extension, either separator", () => {
    expect(fileStem("/p/src/Foo.java")).toBe("Foo");
    expect(fileStem("C:\\p\\src\\Foo.java")).toBe("Foo");
    expect(fileStem("/p/Foo.test.ts")).toBe("Foo.test");
    expect(fileStem("/p/.gitignore")).toBe(".gitignore");
  });
});

describe("isTopLevelTypeName", () => {
  it("accepts the name of a top-level type of any kind", () => {
    expect(isTopLevelTypeName(topClass)).toBe(true);
    expect(isTopLevelTypeName(at(n("identifier", "name"), "record_declaration", "program"))).toBe(true);
    expect(isTopLevelTypeName(at(n("identifier", "name"), "interface_declaration", "program"))).toBe(true);
    // Kotlin: no field on the name; C#: inside a namespace.
    expect(isTopLevelTypeName(at(n("type_identifier"), "class_declaration", "source_file"))).toBe(true);
    expect(
      isTopLevelTypeName(at(n("identifier", "name"), "class_declaration", "declaration_list", "namespace_declaration")),
    ).toBe(true);
  });

  it("rejects nested types, constructors and references", () => {
    expect(
      isTopLevelTypeName(at(n("identifier", "name"), "class_declaration", "class_body", "class_declaration")),
    ).toBe(false);
    expect(
      isTopLevelTypeName(at(n("identifier", "name"), "class_declaration", "block", "method_declaration", "class_body")),
    ).toBe(false);
    expect(isTopLevelTypeName(at(n("identifier", "name"), "constructor_declaration", "class_body"))).toBe(false);
    expect(isTopLevelTypeName(at(n("type_identifier"), "object_creation_expression", "block"))).toBe(false);
    expect(isTopLevelTypeName(at(n("identifier", "name"), "method_declaration", "class_body"))).toBe(false);
  });
});

describe("renamesFileInstead", () => {
  const q = { path: "/p/src/Foo.java", language: "java", name: "Foo", at: topClass };

  it("renames the file for the top-level type named after it", () => {
    expect(renamesFileInstead(q)).toBe(true);
  });

  it("keeps the refusal when the name differs from the file", () => {
    expect(renamesFileInstead({ ...q, name: "Bar" })).toBe(false);
    expect(renamesFileInstead({ ...q, name: "foo" })).toBe(false);
    expect(renamesFileInstead({ ...q, name: null })).toBe(false);
  });

  it("keeps the refusal for anything but the top-level type's name", () => {
    expect(renamesFileInstead({ ...q, at: at(n("identifier", "name"), "constructor_declaration", "class_body") })).toBe(
      false,
    );
  });

  it("without a syntax tree, trusts the name only where types are named after their file", () => {
    expect(renamesFileInstead({ ...q, at: null })).toBe(true);
    expect(renamesFileInstead({ ...q, path: "/p/foo.py", language: "python", name: "foo", at: null })).toBe(false);
  });
});
